import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMediaReader } from './media.mjs';

const args = { chatID: '!chat:example', messageID: '$message', attachmentIndex: 0 };
const attachment = { id: 'mxc://example/media', mimeType: 'image/png', fileSize: 8 };
const png = Buffer.from('89504e470d0a1a0a', 'hex');
function setup(item = attachment, body = png, options = {}) {
  const calls = [];
  const backend = async path => { calls.push(path); return { chatID: args.chatID, id: args.messageID, attachments: [item] }; };
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return new Response(body, options); };
  return { calls, read: createMediaReader({ backend, port: 23374, token: 'secret', fetchImpl }) };
}

test('retrieves only a selected message attachment through the fixed local server', async () => {
  const { calls, read } = setup();
  assert.deepEqual(await read(args), { type: 'image', mimeType: 'image/png', data: png.toString('base64') });
  assert.equal(calls[0], '/v1/chats/!chat%3Aexample/messages/%24message');
  assert.equal(calls[1].url.origin, 'http://127.0.0.1:23374');
  assert.equal(calls[1].url.pathname, '/v1/assets/serve');
  assert.equal(calls[1].url.searchParams.get('url'), attachment.id);
  assert.equal(calls[1].init.headers.Authorization, 'Bearer secret');
  assert.equal(calls[1].init.redirect, 'error');
});

test('rejects untrusted selections, MIME types, paths and mismatched content', async () => {
  for (const item of [
    { ...attachment, id: 'file:///etc/passwd' },
    { ...attachment, id: 'https://example.com/file' },
    { ...attachment, mimeType: 'text/html' },
    { ...attachment, fileSize: 3_000_001 },
  ]) { const { read, calls } = setup(item); await assert.rejects(read(args)); assert.equal(calls.length, 1); }
  const { read } = setup();
  await assert.rejects(read({ ...args, chatID: '../secret' }));
  await assert.rejects(read({ ...args, attachmentIndex: 1 }));
  await assert.rejects(setup(attachment, Buffer.from('not png')).read(args));
  await assert.rejects(setup(attachment, png, { status: 302 }).read(args));
});

test('enforces streaming limit and emits PDFs as embedded resources', async () => {
  await assert.rejects(setup({ ...attachment, fileSize: undefined }, Buffer.alloc(3_000_001)).read(args), /large/);
  const pdf = Buffer.from('%PDF-1.7\n');
  const { read } = setup({ ...attachment, mimeType: 'application/pdf', fileSize: pdf.length }, pdf);
  assert.deepEqual(await read(args), { type: 'resource', resource: { uri: 'urn:beeper:attachment', mimeType: 'application/pdf', blob: pdf.toString('base64') } });
});
