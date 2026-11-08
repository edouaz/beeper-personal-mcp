import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createForwarder } from './events.mjs';

const secret = 's'.repeat(32);
const wait = () => new Promise(resolve => setTimeout(resolve, 20));
const opts = { port: 23374, token: 'token', secret, webhook: 'https://example.org/hook', log() {} };

test('filters and deduplicates events, signs exact body, refuses redirects', async () => {
  const requests = [];
  const f = createForwarder({ ...opts, chats: ['chat'], fetcher: async (url, options) => { requests.push(options); return { ok: true }; } });
  const body = JSON.stringify({ type: 'message.upserted', chatID: 'chat', messageID: 'message' });
  f.accept(Buffer.from(body)); f.accept(Buffer.from(body));
  f.accept(Buffer.from(JSON.stringify({ type: 'message.upserted', chatID: 'other' })));
  f.accept(Buffer.from(JSON.stringify({ type: 'chat.upserted', chatID: 'chat' })));
  await wait();
  assert.equal(requests.length, 1); assert.equal(requests[0].body, body);
  assert.equal(requests[0].headers['x-beeper-signature'], `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`);
  assert.equal(requests[0].redirect, 'error'); f.stop();
});

test('account filter resolves chat and rejects nonmatching accounts', async () => {
  const calls = [];
  const f = createForwarder({ ...opts, accounts: ['allowed'], fetcher: async (url, options) => { calls.push([String(url), options]); return calls.length === 1 ? { ok: true, json: async () => ({ accountID: 'other' }) } : { ok: true }; } });
  f.accept(Buffer.from(JSON.stringify({ type: 'message.upserted', chatID: 'chat' })));
  await wait(); assert.equal(calls.length, 1); f.stop();
});

test('subscribes and reconnects after a socket closes', async () => {
  const sockets = [];
  const f = createForwarder({ ...opts, chats: ['chat'], connect(url, options) { assert.equal(url, 'ws://127.0.0.1:23374/v1/ws'); assert.equal(options.headers.Authorization, 'Bearer token'); const socket = new EventEmitter(); socket.send = data => { socket.sent = JSON.parse(data); }; socket.terminate = () => {}; sockets.push(socket); return socket; } });
  f.start(); sockets[0].emit('open'); assert.deepEqual(sockets[0].sent, { type: 'subscriptions.set', chatIDs: ['chat'] });
  sockets[0].emit('close'); await new Promise(resolve => setTimeout(resolve, 1050)); assert.equal(sockets.length, 2); f.stop();
});

test('rejects insecure webhook or weak signing secret', () => {
  assert.throws(() => createForwarder({ ...opts, webhook: 'http://example.org' }));
  assert.throws(() => createForwarder({ ...opts, secret: 'short' }));
});

test('delivery retries are bounded and retain the same event ID', async () => {
  const requests = [], logs = [];
  const f = createForwarder({ ...opts, pause: async () => {}, log: message => logs.push(message), fetcher: async (url, options) => { requests.push(options); return { ok: false }; } });
  f.accept(Buffer.from(JSON.stringify({ type: 'message.upserted', chatID: 'chat', ids: ['m'] })));
  await wait();
  assert.equal(requests.length, 5);
  assert.equal(new Set(requests.map(request => request.headers['x-beeper-event-id'])).size, 1);
  assert.deepEqual(logs, ['Event delivery failed after retries']); f.stop();
});
