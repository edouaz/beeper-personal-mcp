// Full flow against a stateful fake Beeper HTTP server (no real messages are ever sent):
// phoneNumber -> start_whatsapp_chat -> chatID -> send_message_direct -> get_message_status -> list_messages
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpServer } from './server.mjs';

const ACCOUNT = 'whatsapp.100';
const PHONE = '+32470000000';
const SECRET_TEXT = 'private body 7f3a';

function fakeBeeper({ failStartOnce = false } = {}) {
  const state = { chats: [], messages: [], posts: [], startCalls: 0, polls: 0 };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x'); let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined;
      const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
      if (url.pathname === '/v1/accounts') return send(200, [{ accountID: ACCOUNT, network: 'WhatsApp', status: 'connected' }]);
      if (url.pathname === '/v1/info') return send(200, { app: { version: '9.9.9' }, server: { status: 'running' } });
      if (url.pathname === '/v1/chats' && req.method === 'GET') return send(200, { items: state.chats, hasMore: false });
      if (url.pathname === '/v1/chats/start') {
        state.startCalls++;
        state.chats = [{ id: '!new:beeper.local', accountID: ACCOUNT, type: 'single', participants: { items: [{ isSelf: true }, { phoneNumber: PHONE }] } }];
        if (failStartOnce && state.startCalls === 1) return send(404, { message: 'User not found' }); // the real race: chat created, API says 404
        return send(200, state.chats[0]);
      }
      const m = url.pathname.match(/^\/v1\/chats\/([^/]+)\/messages(?:\/([^/]+))?$/);
      if (m && req.method === 'POST') { state.posts.push(body); state.messages.push({ id: '1954', chatID: '!new:beeper.local', isSender: true, text: body.text, sendStatus: { status: 'PENDING', timestamp: 't' } }); return send(200, { chatID: '!new:beeper.local', pendingMessageID: 'pend-1' }); }
      if (m && m[2] === 'pend-1') {
        if (++state.polls === 1) return send(404, { message: 'Message not found' }); // pending ID not resolvable yet
        state.messages[0].sendStatus = { status: 'SUCCESS', timestamp: 't' };
        return send(200, state.messages[0]);
      }
      if (url.pathname === '/v1/messages/search') return send(200, { items: state.messages, hasMore: false });
      if (url.pathname === '/v1/assets/upload/base64') { state.uploads = (state.uploads || []).concat(body); return send(200, { uploadID: 'up-1', fileName: body.fileName }); }
      if (url.pathname.startsWith('/v1/chats/')) { (state.other ||= []).push([req.method, decodeURIComponent(url.pathname), body]); return send(200, { success: true, id: '!new:beeper.local', unreadCount: 0 }); }
      send(404, { message: 'nope' });
    });
  });
  return { server, state };
}

async function setup(options) {
  const beeper = fakeBeeper(options); beeper.server.listen(0, '127.0.0.1'); await once(beeper.server, 'listening');
  const oauth = { handle: () => false, validateBearer: t => t === 'owner', subject: () => 'owner' };
  const mcp = createHttpServer({ beeperToken: 'backend-secret', beeperPort: beeper.server.address().port, oauth, resourceMetadata: 'https://example.com/meta', sendMode: 'direct' });
  mcp.listen(0, '127.0.0.1'); await once(mcp, 'listening');
  const client = new Client({ name: 'flow', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcp.address().port}/mcp`), { requestInit: { headers: { Authorization: 'Bearer owner' } } }));
  const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
  return { beeper, call, client, close: async () => { await client.close(); await new Promise(r => mcp.close(r)); await new Promise(r => beeper.server.close(r)); } };
}

test('mock end-to-end: number -> chat -> send -> status -> list, with the 404 race and a pending lookup 404', async () => {
  const logs = [], old = console.log; console.log = line => logs.push(String(line));
  const { beeper, call, close } = await setup({ failStartOnce: true });
  try {
    const started = await call('start_whatsapp_chat', { accountID: ACCOUNT, phoneNumber: '+32 470 00 00 00' });
    assert.equal(started.started, true); assert.equal(started.chatID, '!new:beeper.local'); assert.equal(started.status, 'resolved');
    assert.equal(beeper.state.posts.length, 0, 'opening a chat must not send anything');
    const sent = await call('send_message_direct', { chatID: started.chatID, text: SECRET_TEXT, waitSeconds: 5 });
    assert.deepEqual([sent.accepted, sent.state, sent.delivered, sent.read], [true, 'sent', false, false]);
    assert.equal(sent.pendingMessageID, 'pend-1');
    assert.equal((await call('get_message_status', { chatID: started.chatID, messageID: sent.pendingMessageID })).state, 'sent');
    const listed = await call('list_messages', { chatID: started.chatID });
    assert.equal(listed.items[0].text, SECRET_TEXT);
    const duplicate = await call('send_message_direct', { chatID: started.chatID, text: SECRET_TEXT });
    assert.deepEqual([duplicate.accepted, duplicate.state], [false, 'duplicate_blocked']);
    assert.equal(beeper.state.posts.length, 1, 'exactly one message reached Beeper');
    const health = await call('beeper_health', {});
    assert.equal(health.beeper.reachable, true); assert.equal(health.accounts.connected, 1);
    assert.notEqual(health.lastIncident?.route, '/v1/chats/:chatID/messages/:messageID', 'expected pending lookups are not incidents');
  } finally { console.log = old; await close(); }
  const joined = logs.join('\n');
  assert.doesNotMatch(joined, new RegExp(`${SECRET_TEXT}|32470000000|backend-secret|!new:beeper`), 'logs must not contain message text, numbers, IDs or secrets');
  assert.match(joined, /"event":"tool_call","tool":"start_whatsapp_chat"/);
});

test('parallel identical sends reach Beeper once', async () => {
  const { beeper, call, close } = await setup();
  try {
    const args = { chatID: '!new:beeper.local', text: 'parallel', waitSeconds: 0 };
    const results = await Promise.all([call('send_message_direct', args), call('send_message_direct', args), call('send_message_direct', args)]);
    assert.deepEqual(results.map(r => r.accepted).sort(), [false, false, true]);
    assert.equal(beeper.state.posts.length, 1);
  } finally { await close(); }
});

test('an unreachable Beeper produces an unknown outcome for sends, never a retry', async () => {
  const { beeper, call, close } = await setup();
  await new Promise(r => beeper.server.close(r));
  try {
    const result = await call('send_message_direct', { chatID: '!x:beeper.local', text: 'hi' });
    assert.deepEqual([result.accepted, result.state], [null, 'unknown_outcome']);
    assert.deepEqual((await call('send_message_direct', { chatID: '!x:beeper.local', text: 'hi' })).state, 'duplicate_blocked');
  } finally { await new Promise(r => r()); await close().catch(() => {}); }
});

test('actions are wired through MCP with the official routes, and files respect validation and duplicate protection', async () => {
  const { beeper, call, client, close } = await setup();
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(8)]).toString('base64');
  const chatID = '!new:beeper.local';
  try {
    const names = (await client.listTools()).tools.map(t => t.name);
    for (const name of ['send_file', 'react_to_message', 'remove_reaction', 'edit_message', 'delete_message', 'mark_chat_read', 'mark_chat_unread', 'save_chat_draft', 'clear_chat_draft', 'set_chat_state', 'get_message_status', 'beeper_health', 'start_whatsapp_chat']) assert.ok(names.includes(name), name);
    assert.equal((await call('react_to_message', { chatID, messageID: 'm1', reaction: '👍' })).ok, true);
    assert.equal((await call('mark_chat_read', { chatID })).ok, true);
    assert.equal((await call('save_chat_draft', { chatID, text: 'draft' })).ok, true);
    assert.equal((await call('set_chat_state', { chatID, isPinned: true })).ok, true);
    assert.deepEqual(beeper.state.other.map(x => x[0]), ['POST', 'POST', 'PATCH', 'PATCH', 'PATCH']);
    assert.equal(beeper.state.posts.length, 0, 'none of these actions sends a message');
    const file = { chatID, mimeType: 'image/png', fileName: 'p.png', contentBase64: png, caption: 'cap', waitSeconds: 0 };
    const sent = await call('send_file', file);
    assert.deepEqual([sent.accepted, sent.state], [true, 'pending']);
    assert.deepEqual(beeper.state.posts[0], { text: 'cap', attachment: { uploadID: 'up-1', fileName: 'p.png', mimeType: 'image/png' } });
    assert.equal((await call('send_file', file)).state, 'duplicate_blocked');
    assert.equal(beeper.state.uploads.length, 2, 'duplicate upload is harmless; the message was blocked');
    const html = await client.callTool({ name: 'send_file', arguments: { ...file, mimeType: 'text/html', caption: 'x2' } });
    assert.equal(html.isError, true, 'disallowed MIME types are rejected by the schema');
    const neither = await client.callTool({ name: 'send_file', arguments: { chatID, waitSeconds: 0 } });
    assert.equal(neither.isError, true);
    assert.equal(beeper.state.posts.length, 1);
  } finally { await close(); }
});
