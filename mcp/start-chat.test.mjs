import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatStarter } from './start-chat.mjs';

const ACCOUNTS = [{ accountID: 'wa', network: 'WhatsApp', status: 'connected' }, { accountID: 'ig', network: 'Instagram', status: 'connected' }];
const CHAT = '!chat:example';
const err = (status, extra = {}) => Object.assign(new Error('x'), { status, category: 'UPSTREAM_ERROR', requestId: 'req-1', ...extra });
const make = (handlers, opts = {}) => {
  const calls = [];
  const backend = async (path, params, body) => {
    calls.push([path, params, body]);
    if (path === '/v1/accounts') return ACCOUNTS;
    return handlers[path](params, body, calls.filter(c => c[0] === path).length);
  };
  return { calls, start: createChatStarter({ backend, pause: async () => {}, ...opts }) };
};
const empty = { '/v1/chats': async () => ({ items: [], hasMore: false }) };
const args = { accountID: 'wa', phoneNumber: '+32470000000' };
const starts = calls => calls.filter(c => c[0] === '/v1/chats/start').length;

test('validates input and only starts on a connected WhatsApp account, without invite or message', async () => {
  const { start, calls } = make({ ...empty, '/v1/chats/start': async () => ({ id: CHAT, accountID: 'wa' }) });
  await assert.rejects(start({ accountID: 'wa', phoneNumber: '0470000000' }, 'owner'));
  await assert.rejects(start(args, undefined));
  assert.equal((await start({ accountID: 'ig', phoneNumber: '+32470000000' }, 'owner')).status, 'unsupported');
  assert.deepEqual(await start(args, 'owner'), { started: true, status: 'created', chatID: CHAT, phoneNumber: '+32470000000', network: 'WhatsApp' });
  assert.deepEqual(calls.find(c => c[0] === '/v1/chats/start')[2], { accountID: 'wa', user: { phoneNumber: '+32470000000' }, allowInvite: false });
});

test('returns an existing chat without calling start (idempotent)', async () => {
  const { start, calls } = make({ '/v1/chats': async () => ({ items: [{ id: CHAT, accountID: 'wa', type: 'single', participants: { items: [{ isSelf: true, phoneNumber: '+32499999999' }, { phoneNumber: '+32 470 000 000' }] } }], hasMore: false }), '/v1/chats/start': async () => { throw new Error('must not be called'); } });
  assert.deepEqual(await start(args, 'owner'), { started: true, status: 'existing', chatID: CHAT, phoneNumber: '+32470000000', network: 'WhatsApp' });
  assert.equal(starts(calls), 0);
});

test('regression: 404 "User not found" while the bridge created the chat is reconciled, not reported as failure', async () => {
  let listCalls = 0;
  const { start, calls } = make({
    '/v1/chats': async () => ++listCalls < 2 ? { items: [], hasMore: false } : { items: [{ id: CHAT, accountID: 'wa', type: 'single', participants: { items: [{ phoneNumber: '+32470000000' }] } }], hasMore: false },
    '/v1/chats/start': async () => { throw err(404); },
  });
  const result = await start(args, 'owner');
  assert.equal(result.started, true); assert.equal(result.status, 'resolved'); assert.equal(result.chatID, CHAT);
  assert.equal(starts(calls), 1);
});

test('a retried start succeeds after a transient error', async () => {
  const { start, calls } = make({ ...empty, '/v1/chats/start': async (_p, _b, n) => { if (n === 1) throw err(500, { category: 'UNAVAILABLE' }); return { id: CHAT }; } });
  const result = await start(args, 'owner');
  assert.equal(result.started, true); assert.equal(result.status, 'resolved'); assert.ok('reconciledAfterError' in result);
  assert.equal(starts(calls), 2);
});

test('explicit not-on-WhatsApp rejection is final and never retried', async () => {
  const { start, calls } = make({ ...empty, '/v1/chats/start': async () => { throw err(500, { reason: 'RECIPIENT_NOT_ON_WHATSAPP' }); } });
  const result = await start(args, 'owner');
  assert.equal(result.status, 'not_on_whatsapp'); assert.equal(result.started, false); assert.equal(result.requestId, 'req-1');
  assert.equal(starts(calls), 1);
});

test('maps auth, invalid number and rate-limit rejections without retrying', async () => {
  for (const [error, status] of [[err(401, { category: 'UNAUTHENTICATED' }), 'unauthorized'], [err(403, { category: 'PERMISSION_DENIED' }), 'unauthorized'], [err(422, { category: 'INVALID_ARGUMENT', reason: 'INVALID_NUMBER' }), 'invalid_number'], [err(422, { category: 'INVALID_ARGUMENT' }), 'upstream_error'], [err(429, { category: 'RESOURCE_EXHAUSTED' }), 'upstream_error']]) {
    const { start, calls } = make({ ...empty, '/v1/chats/start': async () => { throw error; } });
    const result = await start(args, 'owner');
    assert.equal(result.status, status); assert.equal(result.started, false);
    assert.equal(starts(calls), 1);
  }
});

test('timeouts stay unknown_outcome after bounded reconciliation, and never loop', async () => {
  const { start, calls } = make({ ...empty, '/v1/chats/start': async () => { throw Object.assign(new Error('t'), { category: 'DEADLINE_EXCEEDED' }); } });
  const result = await start(args, 'owner');
  assert.equal(result.status, 'unknown_outcome'); assert.equal(result.started, null);
  assert.equal(starts(calls), 3);
});

test('persistent 5xx is reported as an upstream error with its status, not an invented diagnosis', async () => {
  const { start } = make({ ...empty, '/v1/chats/start': async () => { throw err(502, { category: 'UNAVAILABLE' }); } });
  const result = await start(args, 'owner');
  assert.equal(result.status, 'upstream_error'); assert.equal(result.upstreamStatus, 502); assert.match(result.error, /no message was sent/);
});

test('global rate limit protects against number probing', async () => {
  let time = 0;
  const { start } = make({ ...empty, '/v1/chats/start': async () => ({ id: CHAT }) }, { clock: () => time });
  for (let i = 0; i < 10; i++) assert.equal((await start(args, 'owner')).started, true);
  assert.equal((await start(args, 'owner')).code, 'RATE_LIMITED');
  time += 60001;
  assert.equal((await start(args, 'owner')).started, true);
});

test('normalizes formatting but never guesses a country code', async () => {
  const { normalizePhone } = await import('./start-chat.mjs');
  assert.equal(normalizePhone('+32 470-00.00 (00)'), '+32470000000');
  assert.equal(normalizePhone('0032470000000'), '+32470000000');
  for (const bad of ['0470000000', '470000000', '+0470000000', '+32', '+3247000000000000', 'abc', '', undefined, null, 5]) assert.equal(normalizePhone(bad), undefined);
  const { start, calls } = make({ ...empty, '/v1/chats/start': async () => ({ id: CHAT }) });
  assert.equal((await start({ accountID: 'wa', phoneNumber: '+32 470 00 00 00' }, 'owner')).phoneNumber, '+32470000000');
  assert.deepEqual(calls.find(c => c[0] === '/v1/chats/start')[2].user, { phoneNumber: '+32470000000' });
});

test('concurrent identical calls share a single start; different numbers do not', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const { start, calls } = make({ ...empty, '/v1/chats/start': async () => { await gate; return { id: CHAT }; } });
  const a = start(args, 'owner'), b = start({ ...args, phoneNumber: '+32 470 000 000' }, 'owner'), c = start({ ...args, phoneNumber: '+32470000001' }, 'owner');
  await new Promise(resolve => setTimeout(resolve, 20)); release();
  const results = await Promise.all([a, b, c]);
  assert.ok(results.every(r => r.started === true));
  assert.equal(starts(calls), 2);
  assert.strictEqual(results[0], results[1]);
});

test('disconnected WhatsApp account and unreachable Beeper are explicit, and nothing is started', async () => {
  const calls = [];
  const down = createChatStarter({ backend: async path => { calls.push(path); return [{ accountID: 'wa', network: 'WhatsApp', status: 'disconnected' }]; } });
  const result = await down(args, 'owner');
  assert.deepEqual([result.started, result.status, result.code], [false, 'unsupported', 'ACCOUNT_UNAVAILABLE']);
  assert.deepEqual(calls, ['/v1/accounts']);
  const offline = createChatStarter({ backend: async () => { throw Object.assign(new Error('x'), { category: 'UNAVAILABLE', requestId: 'r' }); } });
  await assert.rejects(offline(args, 'owner'));
});

test('a created chat whose ID is malformed is never reported as success', async () => {
  const { start } = make({ ...empty, '/v1/chats/start': async () => ({ id: 'not a chat id' }) });
  const result = await start(args, 'owner');
  assert.notEqual(result.started, true);
});
