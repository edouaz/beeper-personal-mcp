// Regression tests for two real-world scenarios observed on 2026-11-06, reproduced at HTTP level with fake data:
//   A) a registered business: contact found, no chat in the list, Beeper answers 404 "User not found" although
//      the bridge created the chat (race), then the chat is resolvable.
//   B) a number not on WhatsApp: the bridge answers 404 to create_dm and Beeper's API surfaces it as HTTP 500
//      CREATE_CHAT_FAILED "createDM failed: the server said <number> is not on WhatsApp".
// Numbers below are fake. No real recipient is ever contacted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpServer } from './server.mjs';

const ACCOUNT = 'whatsapp.100';
const A = '+32470000001', B = '+3220000002';
const CHAT_A = '!ixAAAAAAAAAAAAAAAAAA:beeper.local';

function fake(behaviour) {
  const state = { starts: 0, sends: 0, requests: [] };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x'); let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined;
      const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
      state.requests.push(`${req.method} ${url.pathname}`);
      if (url.pathname === '/v1/accounts') return send(200, [{ accountID: ACCOUNT, network: 'WhatsApp', status: 'connected' }]);
      if (url.pathname === '/v1/info') return send(200, { app: { version: '4.3.271' }, server: { status: 'running' } });
      if (url.pathname === `/v1/accounts/${ACCOUNT}/contacts`) return send(200, { items: [{ id: '@whatsapp_lid-1:beeper.local', fullName: 'Shop', phoneNumber: A }] });
      if (url.pathname === '/v1/chats/search') return send(200, { items: [], hasMore: false });
      if (url.pathname === '/v1/chats' && req.method === 'GET') return send(200, { items: state.chat ? [state.chat] : [], hasMore: false });
      if (url.pathname === '/v1/chats/start') { state.starts++; return behaviour.start(state, body, send); }
      if (/\/messages$/.test(url.pathname) && req.method === 'POST') { state.sends++; return send(200, { pendingMessageID: 'p' }); }
      send(404, { message: 'nope' });
    });
  });
  return { server, state };
}
const chatFor = phone => ({ id: CHAT_A, accountID: ACCOUNT, type: 'single', participants: { items: [{ isSelf: true }, { phoneNumber: phone, cannotMessage: false }] } });

async function setup(behaviour) {
  const beeper = fake(behaviour); beeper.server.listen(0, '127.0.0.1'); await once(beeper.server, 'listening');
  const oauth = { handle: () => false, validateBearer: () => true, subject: () => 'owner' };
  const mcp = createHttpServer({ beeperToken: 'backend-secret', beeperPort: beeper.server.address().port, oauth, resourceMetadata: 'https://example.com/meta', sendMode: 'direct', starterOptions: { reconcileDelays: [5, 5] } });
  mcp.listen(0, '127.0.0.1'); await once(mcp, 'listening');
  const client = new Client({ name: 'cases', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcp.address().port}/mcp`), { requestInit: { headers: { Authorization: 'Bearer t' } } }));
  const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
  return { beeper, call, close: async () => { await client.close(); await new Promise(r => mcp.close(r)); await new Promise(r => beeper.server.close(r)); } };
}
const quiet = async fn => { const old = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = old; } };

test('case A: contact found, no chat in list, 404 race -> resolved chatID, nothing sent, no duplicate creation', async () => {
  const { beeper, call, close } = await setup({ start: (state, body, send) => {
    state.chat = chatFor(body.user.phoneNumber); // the bridge created it
    return state.starts === 1 ? send(404, { message: 'User not found' }) : send(200, state.chat);
  } });
  try {
    const contacts = await call('search_contacts', { accountID: ACCOUNT, query: A });
    assert.equal(contacts.items[0].phoneNumber, A);
    assert.deepEqual((await call('search_chats', { query: A })).items, []);
    const result = await quiet(() => call('start_whatsapp_chat', { accountID: ACCOUNT, phoneNumber: A }));
    assert.equal(result.started, true); assert.equal(result.status, 'resolved'); assert.equal(result.chatID, CHAT_A);
    assert.equal(result.reconciledAfterError, 404);
    assert.equal(beeper.state.sends, 0, 'opening a chat never sends');
    assert.ok(beeper.state.starts <= 2, `bounded start calls, got ${beeper.state.starts}`);
    // a repeated call is served from the existing chat without another creation request
    const again = await quiet(() => call('start_whatsapp_chat', { accountID: ACCOUNT, phoneNumber: A }));
    assert.deepEqual([again.status, again.chatID], ['existing', CHAT_A]);
    assert.equal(beeper.state.starts, 1, 'no second creation request');
    const health = await call('beeper_health', {});
    assert.equal(health.status, 'ok'); assert.equal(health.lastIncident, null);
  } finally { await close(); }
});

test('case B: number not on WhatsApp -> stable business error, one request, no chatID, health stays ok', async () => {
  const { beeper, call, close } = await setup({ start: (_state, body, send) => send(500, { code: 'CREATE_CHAT_FAILED', message: `createDM failed: the server said ${body.user.phoneNumber} is not on WhatsApp` }) });
  try {
    const result = await quiet(() => call('start_whatsapp_chat', { accountID: ACCOUNT, phoneNumber: B }));
    assert.deepEqual([result.started, result.status, result.code, result.retryable], [false, 'not_on_whatsapp', 'RECIPIENT_NOT_ON_WHATSAPP', false]);
    assert.match(result.requestId, /^[0-9a-f-]{36}$/);
    assert.equal('chatID' in result, false, 'a failed resolution never carries a chatID');
    assert.equal(beeper.state.starts, 1, 'a definitive business answer is not retried');
    assert.equal(beeper.state.sends, 0);
    const health = await quiet(() => call('beeper_health', {}));
    assert.equal(health.status, 'ok', 'a business rejection must not look like a server failure');
    assert.equal(health.lastIncident, null);
    assert.equal(health.lastRejection.category, 'RECIPIENT_NOT_ON_WHATSAPP'); assert.equal(health.lastRejection.status, 500);
  } finally { await close(); }
});

test('a bare HTTP 500, or a message about another number, is never turned into not_on_whatsapp', async () => {
  for (const reply of [{ code: 'CREATE_CHAT_FAILED', message: 'createDM failed: internal failure' }, { code: 'CREATE_CHAT_FAILED', message: 'createDM failed: the server said +32470000009 is not on WhatsApp' }, { message: 'boom' }]) {
    const { beeper, call, close } = await setup({ start: (_s, _b, send) => send(500, reply) });
    try {
      const result = await quiet(() => call('start_whatsapp_chat', { accountID: ACCOUNT, phoneNumber: B }));
      assert.equal(result.status, 'upstream_error'); assert.equal(result.retryable, true);
      assert.equal('chatID' in result, false); assert.equal(beeper.state.starts, 3, 'bounded reconciliation only');
      assert.equal(beeper.state.sends, 0);
      const health = await quiet(() => call('beeper_health', {}));
      assert.equal(health.status, 'degraded'); assert.equal(health.lastIncident.status, 500);
    } finally { await close(); }
  }
});

test('a persistent 404 and a success without a valid chat ID never produce a fake chatID', async () => {
  for (const start of [(_s, _b, send) => send(404, { message: 'User not found' }), (_s, _b, send) => send(200, { id: 'garbage' }), (_s, _b, send) => send(200, {})]) {
    const { beeper, call, close } = await setup({ start });
    try {
      const result = await quiet(() => call('start_whatsapp_chat', { accountID: ACCOUNT, phoneNumber: A }));
      assert.notEqual(result.started, true); assert.equal('chatID' in result, false);
      assert.ok(['upstream_error', 'unknown_outcome'].includes(result.status), result.status);
      assert.equal(beeper.state.sends, 0); assert.equal(beeper.state.starts, 3);
    } finally { await close(); }
  }
});

test('resolving a chat says nothing about delivery: a send still starts as pending/unknown', async () => {
  const { call, close } = await setup({ start: (state, body, send) => { state.chat = chatFor(body.user.phoneNumber); return send(200, state.chat); } });
  try {
    const started = await quiet(() => call('start_whatsapp_chat', { accountID: ACCOUNT, phoneNumber: A }));
    assert.equal('delivered' in started, false, 'a resolved chat carries no delivery claim');
    const sent = await quiet(() => call('send_message_direct', { chatID: started.chatID, text: 'hello', waitSeconds: 0 }));
    assert.deepEqual([sent.accepted, sent.state, sent.delivered], [true, 'pending', false]);
  } finally { await close(); }
});
