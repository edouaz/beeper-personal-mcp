import test from 'node:test';
import assert from 'node:assert/strict';
import { createActions, safeFileName } from './actions.mjs';
import { summarizeMessage, createStatusReader } from './message-status.mjs';

const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(16)]).toString('base64');
const CHAT = '!c:example';
const decode = path => decodeURIComponent(path);
const recorder = (responses = {}) => {
  const calls = [];
  return { calls, backend: async (path, params, body, options) => {
    const method = options?.method || (body === undefined ? 'GET' : 'POST');
    calls.push({ path: decode(path), body, method });
    const r = responses[`${method} ${decode(path)}`];
    if (r instanceof Error) throw r;
    return r ?? {};
  } };
};

test('message states never claim delivery without network confirmation', () => {
  const t = 'ts';
  assert.equal(summarizeMessage({ sendStatus: { status: 'PENDING', timestamp: t } }).state, 'pending');
  const sent = summarizeMessage({ sendStatus: { status: 'SUCCESS', timestamp: t } });
  assert.equal(sent.state, 'sent'); assert.equal(sent.delivered, false);
  assert.equal(summarizeMessage({ sendStatus: { status: 'SUCCESS', timestamp: t, deliveredToUsers: ['@u'] } }).state, 'delivered');
  assert.equal(summarizeMessage({ sendStatus: { status: 'SUCCESS', timestamp: t, deliveredToUsers: ['@u'] }, seen: true }).state, 'read');
  const failed = summarizeMessage({ sendStatus: { status: 'FAIL_PERMANENT', timestamp: t, reason: 'blocked' } });
  assert.deepEqual([failed.state, failed.retriable, failed.failureReason], ['failed', false, 'blocked']);
});

test('bounded wait leaves pending, survives lookup errors and times out without claiming failure', async () => {
  let now = 0, n = 0;
  const pause = async ms => { now += ms; };
  const reader = createStatusReader({ backend: async () => { n++; if (n === 1) throw new Error('not resolvable yet'); return n < 4 ? { sendStatus: { status: 'PENDING' } } : { sendStatus: { status: 'SUCCESS' } }; }, clock: () => now, pause });
  assert.equal((await reader.wait(CHAT, 'p', 20)).state, 'sent');
  const stuck = createStatusReader({ backend: async () => ({ sendStatus: { status: 'PENDING' } }), clock: () => now, pause });
  const result = await stuck.wait(CHAT, 'p', 3);
  assert.equal(result.state, 'pending'); assert.equal(result.waitTimedOut, true);
});

test('reactions, read state, drafts and chat state use the exact official routes', async () => {
  const { backend, calls } = recorder({ [`POST /v1/chats/${CHAT}/messages/m1/reactions`]: { success: true } });
  const a = createActions({ backend, port: 1, token: 't' });
  assert.equal((await a.react({ chatID: CHAT, messageID: 'm1', reaction: '👍' })).ok, true);
  await a.unreact({ chatID: CHAT, messageID: 'm1', reaction: '👍' });
  await a.markRead({ chatID: CHAT }); await a.markUnread({ chatID: CHAT });
  await a.setDraft({ chatID: CHAT, text: 'hello' });
  await a.setState({ chatID: CHAT, isArchived: true, isPinned: false, bogus: 1 });
  const base = `/v1/chats/${CHAT}`;
  assert.deepEqual(calls.map(c => [c.method, c.path]), [
    ['POST', `${base}/messages/m1/reactions`], ['DELETE', `${base}/messages/m1/reactions/👍`], ['POST', `${base}/read`], ['POST', `${base}/unread`],
    ['PATCH', base], ['PATCH', base], ['PATCH', base],
  ]);
  assert.equal(calls[4].body.draft, null); assert.deepEqual(calls[5].body, { draft: { text: 'hello' } });
  assert.deepEqual(calls[6].body, { isArchived: true, isPinned: false });
  await assert.rejects(a.setState({ chatID: CHAT }), /No state change/);
  await assert.rejects(a.react({ chatID: '../x', messageID: 'm', reaction: 'a' }), /Invalid chat ID/);
});

test('edit and delete are limited to own messages', async () => {
  const { backend, calls } = recorder({ [`GET /v1/chats/${CHAT}/messages/mine`]: { isSender: true }, [`GET /v1/chats/${CHAT}/messages/theirs`]: { isSender: false } });
  const a = createActions({ backend, port: 1, token: 't' });
  assert.equal((await a.deleteMessage({ chatID: CHAT, messageID: 'theirs' })).code, 'NOT_OWN_MESSAGE');
  assert.equal((await a.editMessage({ chatID: CHAT, messageID: 'theirs', text: 'x' })).code, 'NOT_OWN_MESSAGE');
  assert.equal(calls.some(c => c.method === 'DELETE' || c.method === 'PUT'), false);
  assert.equal((await a.deleteMessage({ chatID: CHAT, messageID: 'mine' })).ok, true);
});

test('upstream rejection vs unknown failure are reported distinctly, without raw bodies', async () => {
  const bad = Object.assign(new Error('x'), { category: 'INVALID_ARGUMENT', status: 422, requestId: 'r' });
  const down = Object.assign(new Error('x'), { category: 'UNAVAILABLE', status: 503, requestId: 'r2' });
  const a = createActions({ backend: async (_p, _q, _b, o) => { throw o?.method === 'DELETE' ? down : bad; }, port: 1, token: 't' });
  assert.equal((await a.markUnread({ chatID: CHAT })).ok, false);
  const unknown = await a.unreact({ chatID: CHAT, messageID: 'm', reaction: 'a' });
  assert.equal(unknown.ok, null); assert.equal(unknown.requestId, 'r2');
});

test('file uploads validate type, signature, size, name and origin', async () => {
  const { backend, calls } = recorder({ 'POST /v1/assets/upload/base64': { uploadID: 'up1', fileName: 'a.png' } });
  const a = createActions({ backend, port: 1, token: 't' });
  const ok = await a.upload({ contentBase64: PNG, fileName: '../../etc/pass wd.png', mimeType: 'image/png' });
  assert.equal(ok.ok, true); assert.equal(ok.uploadID, 'up1'); assert.equal(calls[0].body.fileName, 'pass wd.png');
  assert.equal((await a.upload({ contentBase64: PNG, fileName: 'a.html', mimeType: 'text/html' })).code, 'UNSUPPORTED_TYPE');
  assert.equal((await a.upload({ contentBase64: Buffer.from('MZ not an image').toString('base64'), fileName: 'a.png', mimeType: 'image/png' })).code, 'TYPE_MISMATCH');
  assert.equal((await a.upload({ contentBase64: '!!', fileName: 'a.png', mimeType: 'image/png' })).code, 'INVALID_CONTENT');
  assert.equal((await a.upload({ contentBase64: 'A'.repeat(60000), fileName: 'a.png', mimeType: 'image/png' })).code, 'INVALID_CONTENT');
  assert.throws(() => safeFileName('///'), /Invalid file name/);
  assert.equal(calls.length, 1);
});

test('forwarding an attachment accepts only mxc URLs from the exact message and enforces the size limit', async () => {
  const msg = { attachments: [{ id: 'mxc://example/abc', mimeType: 'image/png', fileName: 'x.png', fileSize: 20 }, { id: 'file:///etc/passwd', mimeType: 'image/png' }, { id: 'mxc://e/big', mimeType: 'image/png', fileSize: 99_000_000 }] };
  const { backend, calls } = recorder({ [`GET /v1/chats/${CHAT}/messages/m`]: msg, 'POST /v1/assets/upload/base64': { uploadID: 'up2' } });
  let served;
  const fetchImpl = async url => { served = String(url); return new Response(Buffer.from(PNG, 'base64')); };
  const a = createActions({ backend, port: 5, token: 't', fetchImpl });
  const ok = await a.upload({ fromAttachment: { chatID: CHAT, messageID: 'm', attachmentIndex: 0 } });
  assert.equal(ok.ok, true); assert.match(served, /^http:\/\/127\.0\.0\.1:5\/v1\/assets\/serve\?url=mxc/);
  assert.equal((await a.upload({ fromAttachment: { chatID: CHAT, messageID: 'm', attachmentIndex: 1 } })).code, 'MEDIA_UNAVAILABLE');
  assert.equal((await a.upload({ fromAttachment: { chatID: CHAT, messageID: 'm', attachmentIndex: 2 } })).code, 'FILE_TOO_LARGE');
  assert.equal((await a.upload({ fromAttachment: { chatID: CHAT, messageID: 'm', attachmentIndex: 7 } })).code, 'ATTACHMENT_NOT_FOUND');
  assert.equal(calls.filter(c => c.path === '/v1/assets/upload/base64').length, 1);
});
