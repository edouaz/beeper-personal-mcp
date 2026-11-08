import http from 'node:http';
import { readFileSync } from 'node:fs';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { createOAuth } from './oauth.mjs';
import { createConfirmations } from './confirmations.mjs';
import { createDirectSender } from './direct-send.mjs';
import { createChatStarter } from './start-chat.mjs';
import { createMediaReader } from './media.mjs';
import { createActions, SEND_TYPES, MAX_BASE64_CHARS } from './actions.mjs';
import { createStatusReader } from './message-status.mjs';

const startedAt = Date.now();
const incidents = { last: null, lastRejection: null };
const VERSION = '2.0.0';

const id = z.string().min(1).max(512);
const chatID = id.refine(value => value !== '.' && value !== '..' && !/[\/\\]/.test(value), 'Invalid chat ID');
const limit = z.number().int().min(1).max(100).default(20);
const page = { limit, cursor: id.optional(), direction: z.enum(['before', 'after']).optional() };
const messagePage = { ...page, limit: z.number().int().min(1).max(20).default(20) };
const account = { accountID: id.optional() };
const time = z.string().datetime({ offset: true }).optional();
const waitSeconds = z.number().int().min(0).max(30).default(8).describe('Seconds to wait for the message to leave the pending state (0 = return immediately). Default 8.');
const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

function createMcp(backend, oauthEnabled = false, confirmations, subject, directSend, startSubject, startChat, mediaReader, extras = {}) {
  const { actions, statusReader, health } = extras;
  const server = new McpServer({ name: 'beeper-confirmed', version: VERSION });
  const register = (name, description, inputSchema, run, write = false, scope = 'messages:send', contentBlock = false) => server.registerTool(name, {
    description, inputSchema, annotations: write ? { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false } : annotations,
    ...(oauthEnabled ? { _meta: { securitySchemes: [{ type: 'oauth2', scopes: write ? ['messages:read', scope] : ['messages:read'] }] } } : {}),
  }, async args => {
    const began = performance.now();
    const done = (ok, category) => console.log(JSON.stringify({ event: 'tool_call', tool: name, ok, category: category ?? null, duration_ms: Math.round(performance.now() - began) }));
    try {
      if (write && !(scope === 'chats:start' ? startSubject : subject)) return { isError: true, content: [{ type: 'text', text: `Reconnect Beeper and authorize messages:read and ${scope}.` }], _meta: { 'mcp/www_authenticate': [`Bearer error="insufficient_scope", scope="messages:read ${scope}"`] } };
      const result = await run(args);
      done(result?.ok === false || result?.accepted === false || result?.started === false ? false : true, result?.state || result?.status || result?.code);
      return { content: [contentBlock ? result : { type: 'text', text: JSON.stringify(result) }] };
    } catch (error) {
      done(false, error instanceof BackendError ? error.category : 'ERROR');
      if (error instanceof Error && !(error instanceof BackendError) && /^(Invalid|Unsupported|Message or attachment|Attachment)/.test(error.message)) return { isError: true, content: [{ type: 'text', text: `Rejected by the MCP (not an upstream error): ${error.message}.` }] };
      return { isError: true, content: [{ type: 'text', text: error instanceof BackendError ? `Beeper upstream ${error.category} (request_id: ${error.requestId}).` : write ? (scope === 'chats:start' ? 'Chat start blocked. Check the account and number.' : directSend ? 'Send blocked. Check the destination and message; check Beeper before retrying.' : 'Send blocked. Open the owner confirmation URL and approve the exact message. If expired or consumed, check Beeper before preparing a new request.') : 'Beeper request failed. Check service health and authentication.' }] };
    }
  });
  const query = ({accountID, ...rest}) => ({ ...rest, ...(accountID ? { accountIDs: accountID } : {}) });
  register('list_accounts', 'List connected Beeper accounts.', {}, () => backend('/v1/accounts'));
  register('search_contacts', 'Search contacts on one account by name, username, phone number, or other supported identifier. Results can be ambiguous; select an exact contact before starting a chat.', { accountID: chatID, query: id }, ({accountID, query}) => backend(`/v1/accounts/${encodeURIComponent(accountID)}/contacts`, { query }));
  register('list_chats', 'List chats in last activity order. Use returned cursors for pagination.', { ...page, ...account }, args => backend('/v1/chats', query(args)));
  const chatFilters = { ...page, ...account, lastActivityAfter: time, lastActivityBefore: time };
  register('search_chats', 'Search chat titles, networks, or participants.', { ...chatFilters, query: id }, args => backend('/v1/chats/search', query(args)));
  register('get_chat', 'Get details of a chat using its exact Beeper chat ID.', { chatID }, ({chatID}) => backend(`/v1/chats/${encodeURIComponent(chatID)}`));
  register('list_messages', 'List messages in one chat. This uses message search, with cursor-based pagination.', { ...messagePage, chatID, dateAfter: time, dateBefore: time }, ({chatID, ...args}) => backend('/v1/messages/search', { ...args, chatIDs: chatID }));
  register('export_messages', 'Export one JSON page of messages in Beeper order with sender identity and timestamps as returned by Beeper. Use the returned cursor to resume; filter by account, chat and date as needed.', { ...messagePage, ...account, chatID: chatID.optional(), dateAfter: time, dateBefore: time }, ({chatID, ...args}) => backend('/v1/messages/search', { ...query(args), ...(chatID ? { chatIDs: chatID } : {}) }));
  register('search_messages', 'Search messages using literal words, optionally limited by account, chat, and time.', { ...messagePage, ...account, query: id, chatID: chatID.optional(), dateAfter: time, dateBefore: time }, ({chatID, ...args}) => backend('/v1/messages/search', { ...query(args), ...(chatID ? { chatIDs: chatID } : {}) }));
  register('download_attachment', 'Read a specific message attachment, at most 1 MB. Supports JPEG, PNG, GIF, WebP and PDF, when available. Select an attachment index from the exact message; arbitrary URLs and local files are not accepted.', { chatID, messageID: chatID, attachmentIndex: z.number().int().min(0).max(99) }, args => mediaReader(args), false, 'messages:read', true);
  register('get_unread_conversations', 'List chats marked unread, ordered by recent activity.', chatFilters, args => backend('/v1/chats/search', { ...query(args), unreadOnly: true }));
  register('get_recent_conversations', 'List chats by most recent activity, optionally filtered by time.', chatFilters, args => backend('/v1/chats/search', query(args)));
  register('prepare_reply_draft', 'Return supplied reply text as a local draft. Does not save or send it.', { text: z.string().min(1).max(10000) }, ({text}) => ({ draft: text, saved: false, sent: false }));
  if (confirmations) {
    register('prepare_message', 'Prepare exact text for an exact Beeper chat ID. Returns an owner confirmation URL. No message is sent. The owner must open the URL and authenticate before send_message can succeed.', { chatID, text: z.string().min(1).max(10000) }, args => confirmations.prepare(args, subject), true);
    register('send_message', 'Attempt an owner-approved message once using its confirmation token. Requires approval on the protected confirmation page. Never retry automatically: an unknown outcome may already have sent the message.', { confirmationToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }, args => confirmations.send(args, subject), true);
  }
  if (directSend) register('send_message_direct', 'Send text to the exact Beeper chat ID immediately. Only send when the user explicitly requests it. Returns state: pending | sent | delivered | read | failed (delivered only when the network confirmed). Never retry automatically; an unknown outcome may already have sent the message.', { chatID, text: z.string().min(1).max(10000), waitSeconds }, args => directSend(args, subject), true);
  if (directSend) register('reply_to_message', 'Send a reply immediately to an exact message in an exact chat. Only send when explicitly requested. Never retry automatically; an unknown outcome may already have sent the reply.', { chatID, messageID: id, text: z.string().min(1).max(10000), waitSeconds }, ({chatID, messageID, text, waitSeconds}) => directSend({ chatID, text, replyToMessageID: messageID, waitSeconds }, subject), true);
  register('get_message_status', 'Get the delivery state of a message (final ID, pendingMessageID or Matrix event ID): pending | sent | delivered | read | failed. Read-only; safe to poll sparingly.', { chatID, messageID: id }, ({ chatID, messageID }) => statusReader.lookup(chatID, messageID));
  register('get_attachment_info', 'Get metadata of a message attachment (type, size, name, whether it can be downloaded) without downloading it.', { chatID, messageID: chatID, attachmentIndex: z.number().int().min(0).max(99) }, args => mediaReader.info(args));
  register('beeper_health', 'Report MCP and Beeper health: reachability, versions, connected accounts, available operations and the last upstream incident. Sends nothing.', {}, () => health());
  if (actions && oauthEnabled) {
    register('mark_chat_read', 'Mark a chat as read (optionally up to a message). May send a read receipt to the contact.', { chatID, messageID: id.optional() }, args => actions.markRead(args), true);
    register('mark_chat_unread', 'Mark a chat as unread locally.', { chatID }, args => actions.markUnread(args), true);
    register('save_chat_draft', 'Save a persistent draft in a Beeper chat (replaces any existing draft). Nothing is sent.', { chatID, text: z.string().min(1).max(10000) }, args => actions.setDraft(args), true);
    register('clear_chat_draft', 'Delete the draft of a chat.', { chatID }, args => actions.clearDraft(args), true);
    register('set_chat_state', 'Archive/unarchive, pin/unpin, mute/unmute or set low priority on a chat. Only the provided fields change.', { chatID, isArchived: z.boolean().optional(), isPinned: z.boolean().optional(), isMuted: z.boolean().optional(), isLowPriority: z.boolean().optional() }, args => actions.setState(args), true);
  }
  if (directSend && actions) {
    const reaction = z.string().min(1).max(32).describe('Reaction key, usually an emoji.');
    register('react_to_message', 'Add a reaction to an exact message. Only when explicitly requested; visible to the other party.', { chatID, messageID: id, reaction }, args => actions.react(args), true);
    register('remove_reaction', 'Remove your reaction from an exact message.', { chatID, messageID: id, reaction }, args => actions.unreact(args), true);
    register('edit_message', 'Edit one of your own messages (not supported by every network). Only when explicitly requested.', { chatID, messageID: id, text: z.string().min(1).max(10000) }, args => actions.editMessage(args), true);
    register('delete_message', 'Delete one of your own messages. Destructive; only when explicitly requested.', { chatID, messageID: id }, args => actions.deleteMessage(args), true);
    register('send_file', 'Send an image, PDF or document to an exact chat, with an optional caption. Provide either contentBase64 (small files, about 43 KB max) or fromAttachment (re-send an attachment of an existing message, up to 10 MB). Only when explicitly requested. Same state semantics and duplicate protection as send_message_direct.', {
      chatID, mimeType: z.enum([...SEND_TYPES.keys()]).optional(), fileName: z.string().min(1).max(100).optional(), caption: z.string().max(4000).optional(), replyToMessageID: id.optional(),
      contentBase64: z.string().max(MAX_BASE64_CHARS).optional(), fromAttachment: z.object({ chatID, messageID: chatID, attachmentIndex: z.number().int().min(0).max(99) }).optional(), waitSeconds,
    }, async args => {
      if (Boolean(args.contentBase64) === Boolean(args.fromAttachment)) throw new Error('Invalid request: provide exactly one of contentBase64 or fromAttachment');
      if (args.contentBase64 && (!args.mimeType || !args.fileName)) throw new Error('Invalid request: contentBase64 needs mimeType and fileName');
      const up = await actions.upload(args);
      if (!up.ok) return { accepted: false, state: 'rejected', code: up.code, error: up.error };
      return directSend({ chatID: args.chatID, text: args.caption || undefined, replyToMessageID: args.replyToMessageID, waitSeconds: args.waitSeconds, dedupeKey: `${up.sha256}:${up.fileName}`, attachment: { uploadID: up.uploadID, fileName: up.fileName, mimeType: up.mimeType } }, subject);
    }, true);
  }
  if (startChat) register('start_whatsapp_chat', 'Only when explicitly requested, find or open a WhatsApp 1:1 chat for a phone number (idempotent: reuses an existing chat). Returns status created | existing | resolved | not_on_whatsapp | invalid_number | unauthorized | unsupported | upstream_error | unknown_outcome and the chatID. No message or invitation is sent.', { accountID: chatID, phoneNumber: z.string().min(9).max(32).describe('International format starting with + (spaces, dots, dashes and parentheses are ignored). No country code is ever guessed.') }, args => startChat(args, startSubject), true, 'chats:start');
  return server;
}

class BackendError extends Error {
  constructor(category, requestId, status, reason) { super(category); this.category = category; this.requestId = requestId; this.status = status; this.reason = reason; }
}

export function makeBackend(port, token) {
  return async (path, params = {}, body, options = {}) => {
    const requestId = randomUUID();
    const start = performance.now();
    // Dynamic identifiers and query strings may contain private data.
    const route = path.replace(/^\/v1\/accounts\/[^/]+\/contacts$/, '/v1/accounts/:accountID/contacts').replace(/^\/v1\/chats\/(?!start$)[^/]+/, '/v1/chats/:chatID').replace(/^(\/v1\/chats\/:chatID\/messages\/)[^/]+/, '$1:messageID').replace(/(\/reactions\/)[^/]+$/, '$1:reaction');
    const method = options.method || (body === undefined ? 'GET' : 'POST');
    let status;
    try {
    const url = new URL(path, `http://127.0.0.1:${port}`);
    for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, String(value));
    const response = await fetch(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }), headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(options.timeoutMs || 10000), redirect: 'error' });
    status = response.status;
    if (!response.ok) {
      let reason;
      if (path === '/v1/chats/start' && response.body) {
        // Only recognize specific Beeper messages, never expose or log the body.
        const reader = response.body.getReader(); const chunks = []; let size = 0;
        try {
          for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 16384) { await reader.cancel(); break; } chunks.push(value); }
          if (size <= 16384) {
            const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            const phone = body?.user?.phoneNumber;
            if (status === 500 && result.code === 'CREATE_CHAT_FAILED' && typeof phone === 'string' && result.message === `createDM failed: the server said ${phone} is not on WhatsApp`) reason = 'RECIPIENT_NOT_ON_WHATSAPP';
            else if ([400, 422].includes(status) && typeof result.message === 'string' && /(invalid|malformed).{0,30}(phone|number)|(phone|number).{0,30}invalid/i.test(result.message)) reason = 'INVALID_NUMBER';
          }
        } catch { /* An unreadable error body is not evidence of rejection. */ }
      }
      throw new BackendError(reason || (status === 401 ? 'UNAUTHENTICATED' : status === 403 ? 'PERMISSION_DENIED' : status === 400 || status === 422 ? 'INVALID_ARGUMENT' : status === 429 ? 'RESOURCE_EXHAUSTED' : status === 408 || status === 504 ? 'DEADLINE_EXCEEDED' : status >= 500 ? 'UNAVAILABLE' : 'UPSTREAM_ERROR'), requestId, status, reason);
    }
    if (!response.body) { if (status === 204) { console.log(JSON.stringify({ event: 'beeper_upstream', request_id: requestId, route, method, status, duration_ms: Math.round(performance.now() - start) })); return {}; } throw new BackendError('INVALID_RESPONSE', requestId); }
    const reader = response.body.getReader();
    let size = 0; const chunks = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2_000_000) { await reader.cancel(); throw new BackendError('INVALID_RESPONSE', requestId); }
      chunks.push(value);
    }
    let parsed;
    if (size === 0) parsed = {};
    else try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new BackendError('INVALID_RESPONSE', requestId); }
    console.log(JSON.stringify({ event: 'beeper_upstream', request_id: requestId, route, method, status, duration_ms: Math.round(performance.now() - start) }));
    return parsed;
    } catch (error) {
      const failure = error instanceof BackendError ? error : new BackendError(error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'DEADLINE_EXCEEDED' : 'UNAVAILABLE', requestId);
      const tolerated = status !== undefined && options.tolerate?.includes(status);
      // Business outcomes and client errors (e.g. number not on WhatsApp, 404 on a lookup) are not server incidents.
      const rejection = Boolean(failure.reason) || (status >= 400 && status < 500 && ![401, 403, 408, 429].includes(status));
      if (!tolerated) incidents[rejection ? 'lastRejection' : 'last'] = { at: new Date().toISOString(), category: failure.category, route, status: status ?? null };
      console.log(JSON.stringify({ event: tolerated ? 'beeper_upstream_expected' : 'beeper_upstream_error', request_id: requestId, route, method, status: status ?? null, category: failure.category, duration_ms: Math.round(performance.now() - start) }));
      throw failure;
    }
  };
}

function safeEqual(value, expected) {
  const a = Buffer.from(value); const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createHttpServer({ mcpToken, beeperToken, beeperPort = 23374, backend = makeBackend(beeperPort, beeperToken), oauth, resourceMetadata, confirmations, sendMode = 'confirm', directSend, starterOptions = {} }) {
  if (typeof beeperToken !== 'string' || !beeperToken || (!oauth && (typeof mcpToken !== 'string' || Buffer.byteLength(mcpToken) < 32 || safeEqual(mcpToken, beeperToken))) || (oauth && !resourceMetadata)) throw new Error('Missing, weak, or reused authentication secrets');
  if (!Number.isInteger(beeperPort) || beeperPort < 1 || beeperPort > 65535) throw new Error('Invalid backend port');
  if (!['confirm', 'direct'].includes(sendMode) || (sendMode === 'direct' && !oauth)) throw new Error('Invalid send mode or OAuth required');
  const sender = sendMode === 'direct' ? (directSend || createDirectSender({ backend })) : undefined;
  const starter = oauth ? createChatStarter({ backend, ...starterOptions }) : undefined;
  const mediaReader = createMediaReader({ backend, port: beeperPort, token: beeperToken });
  const actions = createActions({ backend, port: beeperPort, token: beeperToken });
  const statusReader = createStatusReader({ backend });
  const health = async () => {
    const [info, accounts] = await Promise.allSettled([backend('/v1/info'), backend('/v1/accounts')]);
    const list = accounts.status === 'fulfilled' && Array.isArray(accounts.value) ? accounts.value : [];
    const reachable = info.status === 'fulfilled';
    const connected = list.filter(a => a.status === 'connected').length;
    const recent = incidents.last && Date.now() - Date.parse(incidents.last.at) < 600000;
    // Overall health reflects infrastructure only. lastRejection (business outcomes, client errors) never degrades it.
    const overall = !reachable ? 'down' : (!list.length || connected < list.length || recent) ? 'degraded' : 'ok';
    return {
      status: overall,
      mcp: { status: 'ok', version: VERSION, uptimeSeconds: Math.round((Date.now() - startedAt) / 1000), node: process.version, sendMode },
      beeper: { reachable: info.status === 'fulfilled', ...(info.status === 'fulfilled' ? { appVersion: info.value?.app?.version, serverStatus: info.value?.server?.status } : { error: info.reason?.category || 'UNAVAILABLE' }) },
      accounts: { total: list.length, connected: list.filter(a => a.status === 'connected').length, items: list.map(a => ({ accountID: a.accountID, network: a.network, status: a.status })) },
      operations: { read: info.status === 'fulfilled', send: sendMode === 'direct', startWhatsAppChat: Boolean(starter), attachments: true, sendFile: sendMode === 'direct', reactions: sendMode === 'direct' },
      lastIncident: incidents.last,
      lastRejection: incidents.lastRejection,
    };
  };
  let count = 0, windowStart = Date.now();
  return http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const fail = (status, message) => { res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(message); };
    try {
      if (Date.now() - windowStart >= 60000) { count = 0; windowStart = Date.now(); }
      if (++count > 120) return fail(429, 'Rate limit exceeded');
      if (confirmations?.handle(req, res)) return;
      if (oauth?.handle(req, res)) return;
      if (req.url !== '/mcp' && req.url !== '/beeper/mcp') return fail(404, 'Not found');
      if (req.headers.origin) return fail(403, 'Browser origins are not supported');
      const auth = req.headers.authorization || '';
      if (!auth.startsWith('Bearer ') || !(oauth ? oauth.validateBearer(auth.slice(7)) : safeEqual(auth.slice(7), mcpToken))) { res.setHeader('WWW-Authenticate', oauth ? `Bearer resource_metadata="${resourceMetadata}"` : 'Bearer'); return fail(401, 'Unauthorized'); }
      if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return fail(405, 'Method not allowed'); }
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) return fail(415, 'Expected JSON');
      if (Number(req.headers['content-length']) > 65536) return fail(413, 'Request too large');
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 65536) return fail(413, 'Request too large'); chunks.push(chunk); }
      let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return fail(400, 'Invalid JSON'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, 'Batch requests are not supported');
      if (!Object.hasOwn(body, 'id') && body.method !== 'notifications/initialized') return fail(400, 'Notification not supported');
      const server = createMcp(backend, Boolean(oauth), sendMode === 'confirm' ? confirmations : undefined, oauth?.subject?.(auth.slice(7)), sender, oauth?.subject?.(auth.slice(7), 'chats:start'), starter, mediaReader, { actions, statusReader, health });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => { void transport.close(); void server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch { if (!res.headersSent) fail(500, 'Internal error'); else res.end(); }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.MCP_PORT || '8776');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid MCP port');
  let beeperToken = process.env.BEEPER_ACCESS_TOKEN;
  let beeperPort = Number(process.env.BEEPER_PORT || '23374');
  if (!beeperToken && process.env.BEEPER_TARGET_FILE) {
    try {
      const target = JSON.parse(readFileSync(process.env.BEEPER_TARGET_FILE, 'utf8'));
      const baseURL = new URL(target.baseURL);
      if (target.type !== 'server' || baseURL.protocol !== 'http:' || baseURL.hostname !== '127.0.0.1' || baseURL.username || baseURL.password || baseURL.pathname !== '/' || baseURL.search || baseURL.hash) throw new Error();
      const targetPort = Number(baseURL.port || '80');
      if (process.env.BEEPER_PORT && beeperPort !== targetPort) throw new Error();
      beeperPort = targetPort;
      beeperToken = target.auth?.accessToken;
    } catch { throw new Error('Could not load Beeper Server target authentication'); }
  }
  let oauth, resourceMetadata;
  const sendMode = process.env.BEEPER_SEND_MODE || 'confirm';
  if (!['confirm', 'direct'].includes(sendMode)) throw new Error('Invalid BEEPER_SEND_MODE');
  if (process.env.OAUTH_ISSUER) {
    const issuer = process.env.OAUTH_ISSUER;
    const resource = process.env.OAUTH_RESOURCE;
    oauth = createOAuth({ issuer, resource, statePath: process.env.OAUTH_STATE_PATH, ownerPasswordHash: process.env.OAUTH_OWNER_PASSWORD_HASH, sendMode });
    resourceMetadata = new URL('/.well-known/oauth-protected-resource/beeper/mcp', resource).href;
  }
  const backend = makeBackend(beeperPort, beeperToken);
  const confirmations = oauth && sendMode === 'confirm' ? createConfirmations({ origin: new URL(process.env.OAUTH_ISSUER).origin, ownerPasswordHash: process.env.OAUTH_OWNER_PASSWORD_HASH, backend }) : undefined;
  const server = createHttpServer({ backend, confirmations, mcpToken: process.env.MCP_AUTH_TOKEN, beeperToken, beeperPort, oauth, resourceMetadata, sendMode });
  server.headersTimeout = 10000; server.requestTimeout = 15000;
  server.listen(port, '127.0.0.1', () => console.log(`Beeper confirmed-send MCP listening on 127.0.0.1:${port}`));
}
