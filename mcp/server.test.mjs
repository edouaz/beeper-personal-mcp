import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpServer, makeBackend } from './server.mjs';
import { createChatStarter } from './start-chat.mjs';

test('recognizes only the exact Beeper number rejection without logging private data', async () => {
  let message = 'createDM failed: the server said +32470000000 is not on WhatsApp';
  const upstream = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/accounts') return res.end(JSON.stringify([{ accountID: 'wa', network: 'WhatsApp', status: 'connected' }]));
    res.writeHead(500); res.end(JSON.stringify({ code: 'CREATE_CHAT_FAILED', message }));
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const logs = [], oldLog = console.log; console.log = line => logs.push(line);
  try {
    const start = createChatStarter({ backend: makeBackend(upstream.address().port, 'secret') });
    const args = { accountID: 'wa', phoneNumber: '+32470000000' };
    assert.equal((await start(args, 'owner')).code, 'RECIPIENT_NOT_ON_WHATSAPP');
    message = 'createDM failed: internal failure';
    assert.equal((await start(args, 'owner')).started, null);
    assert.doesNotMatch(logs.join('\n'), /32470000000|secret|internal failure/);
  } finally { console.log = oldLog; await new Promise(resolve => upstream.close(resolve)); }
});

test('MCP enforces authorization and read-only tools against a real mock HTTP backend', async () => {
  const requests = [];
  const backend = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, auth: req.headers.authorization });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ items: [{ id: 'test' }], hasMore: true, oldestCursor: 'cursor1' }));
  });
  backend.listen(0, '127.0.0.1'); await once(backend, 'listening');
  const token = 'a'.repeat(48);
  const server = createHttpServer({ mcpToken: token, beeperToken: 'backend-secret', beeperPort: backend.address().port });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  const client = new Client({ name: 'test-client', version: '1' });
  try {
    assert.equal((await fetch(url, { method: 'POST' })).status, 401);
    assert.equal((await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${'b'.repeat(48)}` } })).status, 401);
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' }, body: '{}' })).status, 403);
    assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'send_message' } }]) })).status, 400);
    assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'send_message' } }) })).status, 400);
    assert.equal(requests.length, 0);
    const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map(t => t.name).sort(), ['beeper_health', 'download_attachment', 'export_messages', 'get_attachment_info', 'get_chat', 'get_message_status', 'get_recent_conversations', 'get_unread_conversations', 'list_accounts', 'list_chats', 'list_messages', 'prepare_reply_draft', 'search_chats', 'search_contacts', 'search_messages'].sort());
    assert.ok(tools.tools.every(t => t.annotations.readOnlyHint));
    const response = await client.callTool({ name: 'list_messages', arguments: { chatID: '!chat:beeper.com', limit: 5, cursor: 'cursor0', direction: 'before' } });
    assert.equal(JSON.parse(response.content[0].text).oldestCursor, 'cursor1');
    const parsed = new URL(requests[0].url, 'http://127.0.0.1');
    assert.equal(parsed.pathname, '/v1/messages/search');
    assert.equal(parsed.searchParams.get('chatIDs'), '!chat:beeper.com');
    assert.equal(parsed.searchParams.get('limit'), '5');
    assert.equal(parsed.searchParams.get('cursor'), 'cursor0');
    assert.equal(requests[0].method, 'GET');
    assert.equal(requests[0].auth, 'Bearer backend-secret');
    await client.callTool({ name: 'search_contacts', arguments: { accountID: 'account:one', query: '+49123' } });
    const contactSearch = new URL(requests[1].url, 'http://127.0.0.1');
    assert.equal(contactSearch.pathname, '/v1/accounts/account%3Aone/contacts');
    assert.equal(contactSearch.searchParams.get('query'), '+49123');
    assert.equal((await client.callTool({ name: 'search_contacts', arguments: { accountID: '..', query: 'x' } })).isError, true);
    const exported = await client.callTool({ name: 'export_messages', arguments: { accountID: 'account:one', chatID: '!chat:beeper.com', dateAfter: '2026-01-01T00:00:00Z', cursor: 'resume', direction: 'after', limit: 5 } });
    assert.equal(JSON.parse(exported.content[0].text).oldestCursor, 'cursor1');
    const exportQuery = new URL(requests[2].url, 'http://127.0.0.1');
    assert.equal(exportQuery.pathname, '/v1/messages/search');
    for (const [key, value] of Object.entries({ accountIDs: 'account:one', chatIDs: '!chat:beeper.com', dateAfter: '2026-01-01T00:00:00Z', cursor: 'resume', direction: 'after', limit: '5' })) assert.equal(exportQuery.searchParams.get(key), value);
    for (const [name, args] of [['list_messages', { chatID: 'chat' }], ['export_messages', {}], ['search_messages', { query: 'word' }]]) {
      assert.equal((await client.callTool({ name, arguments: { ...args, limit: 21 } })).isError, true);
    }
    const denied = await client.callTool({ name: 'send_message', arguments: { chatID: 'x', text: 'x' } });
    assert.equal(denied.isError, true);
    const invalid = await client.callTool({ name: 'get_chat', arguments: { chatID: '../messages' } });
    assert.equal(invalid.isError, true);
    assert.equal(requests.length, 3);
    const draft = await client.callTool({ name: 'prepare_reply_draft', arguments: { text: 'Hello' } });
    assert.deepEqual(JSON.parse(draft.content[0].text), { draft: 'Hello', saved: false, sent: false });
    assert.equal(requests.length, 3);
  } finally {
    await client.close();
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => backend.close(resolve));
  }
});

test('refuses missing, weak, or reused secrets', () => {
  assert.throws(() => createHttpServer({ mcpToken: 'short', beeperToken: 'x' }));
  assert.throws(() => createHttpServer({ mcpToken: 'a'.repeat(32), beeperToken: 'a'.repeat(32) }));
});

test('OAuth mode routes metadata and does not accept the static token', async () => {
  const oauth = {
    handle(req, res) {
      if (req.url !== '/.well-known/oauth-protected-resource/beeper/mcp') return false;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
      return true;
    },
    validateBearer: token => token === 'oauth-token',
  };
  const metadata = 'https://example.com/.well-known/oauth-protected-resource/beeper/mcp';
  const server = createHttpServer({ mcpToken: 'a'.repeat(48), beeperToken: 'backend-secret', oauth, resourceMetadata: metadata, backend: async () => ({ items: [] }) });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/.well-known/oauth-protected-resource/beeper/mcp`)).status, 200);
    assert.equal((await fetch(`${base}/beeper/mcp`, { method: 'POST' })).status, 401);
    const response = await fetch(`${base}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${'a'.repeat(48)}` } });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('www-authenticate'), `Bearer resource_metadata="${metadata}"`);
    const client = new Client({ name: 'oauth-test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/beeper/mcp`), { requestInit: { headers: { Authorization: 'Bearer oauth-token' } } }));
    assert.ok((await client.listTools()).tools.length > 0);
    await client.close();
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('a stalled Beeper backend times out and returns a sanitized error', { timeout: 15000 }, async () => {
  const backend = http.createServer(() => {});
  backend.listen(0, '127.0.0.1'); await once(backend, 'listening');
  const server = createHttpServer({ mcpToken: 'a'.repeat(48), beeperToken: 'backend-secret', beeperPort: backend.address().port });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const client = new Client({ name: 'timeout-test', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${'a'.repeat(48)}` } } }));
    const result = await client.callTool({ name: 'list_accounts', arguments: {} });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /^Beeper upstream DEADLINE_EXCEEDED \(request_id: [0-9a-f-]+\)\.$/);
  } finally {
    await client.close();
    backend.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => backend.close(resolve));
  }
});

test('upstream errors expose a safe category and correlation ID, without backend details', async () => {
  const backend = http.createServer((req, res) => { res.writeHead(503); res.end('secret response'); });
  backend.listen(0, '127.0.0.1'); await once(backend, 'listening');
  const server = createHttpServer({ mcpToken: 'a'.repeat(48), beeperToken: 'backend-secret', beeperPort: backend.address().port });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const client = new Client({ name: 'error-test', version: '1' });
  const lines = [];
  const originalLog = console.log;
  console.log = line => lines.push(line);
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${'a'.repeat(48)}` } } }));
    const result = await client.callTool({ name: 'list_messages', arguments: { chatID: 'private-chat' } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /^Beeper upstream UNAVAILABLE \(request_id: [0-9a-f-]+\)\.$/);
    assert.doesNotMatch(result.content[0].text, /secret|private-chat/);
    const log = JSON.parse(lines[0]);
    assert.equal(log.category, 'UNAVAILABLE');
    assert.equal(log.status, 503);
    assert.equal(log.route, '/v1/messages/search');
    assert.ok(result.content[0].text.includes(log.request_id));
    assert.doesNotMatch(lines[0], /secret|private-chat/);
  } finally {
    console.log = originalLog;
    await client.close();
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => backend.close(resolve));
  }
});

test('starting a WhatsApp chat requires its own OAuth scope and validates inputs', async () => {
  const calls = [];
  const backend = async (path, params, body) => {
    calls.push({ path, params, body });
    if (path === '/v1/accounts') return [{ accountID: 'wa', network: 'whatsapp', status: 'connected' }];
    if (path === '/v1/chats/start') return { id: '!mock:example' };
    throw new Error('Unexpected call');
  };
  const oauth = {
    handle: () => false,
    validateBearer: token => ['read', 'send', 'start'].includes(token),
    subject: (token, scope = 'messages:send') => (token === 'send' && scope === 'messages:send') || (token === 'start' && scope === 'chats:start') ? 'owner' : undefined,
  };
  const server = createHttpServer({ beeperToken: 'backend-secret', oauth, resourceMetadata: 'https://example.com/meta', backend, sendMode: 'direct', directSend: async () => ({ sent: true }) });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const clients = [];
  try {
    for (const token of ['read', 'send', 'start']) {
      const client = new Client({ name: 'scope-test', version: '1' });
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
      clients.push(client);
    }
    const args = { accountID: 'wa', phoneNumber: '+32470000000' };
    for (const client of clients.slice(0, 2)) assert.equal((await client.callTool({ name: 'start_whatsapp_chat', arguments: args })).isError, true);
    assert.equal((await clients[2].callTool({ name: 'send_message_direct', arguments: { chatID: 'chat', text: 'hello' } })).isError, true);
    assert.equal((await clients[2].callTool({ name: 'start_whatsapp_chat', arguments: { ...args, phoneNumber: '0470000000' } })).isError, true);
    assert.equal(calls.length, 0);
    const result = await clients[2].callTool({ name: 'start_whatsapp_chat', arguments: args });
    assert.deepEqual(JSON.parse(result.content[0].text), { started: true, chatID: '!mock:example', status: 'resolved', phoneNumber: '+32470000000', network: 'WhatsApp' });
    assert.deepEqual(calls.map(call => call.path), ['/v1/accounts', '/v1/chats', '/v1/chats/start']);
    assert.deepEqual(calls[2].body, { accountID: 'wa', user: { phoneNumber: '+32470000000' }, allowInvite: false });
    // Starting a chat is idempotent and sends nothing, so repeating it is allowed.
    assert.equal(JSON.parse((await clients[2].callTool({ name: 'start_whatsapp_chat', arguments: args })).content[0].text).started, true);
    assert.equal(calls.filter(call => call.path === '/v1/chats/start').length, 2);
  } finally {
    for (const client of clients) await client.close();
    await new Promise(resolve => server.close(resolve));
  }
});
