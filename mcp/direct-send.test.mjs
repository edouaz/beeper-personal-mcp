import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpServer } from './server.mjs';
import { createDirectSender } from './direct-send.mjs';

test('direct sends require OAuth send scope and block duplicates and ambiguous retries', async () => {
  let time = 1000000, fail = false;
  const calls = [], logs = [];
  const backend = async (...args) => { if (/\/messages\/pending$/.test(args[0])) return { id: 'm1', isSender: true, sendStatus: { status: 'SUCCESS', timestamp: 't' } }; calls.push(args); if (fail) throw new Error('private'); return { pendingMessageID: 'pending' }; };
  const directSend = createDirectSender({ backend, clock: () => time, log: event => logs.push(event) });
  const oauth = { handle: () => false, validateBearer: t => ['write', 'read'].includes(t), subject: t => t === 'write' ? 'client' : undefined };
  const server = createHttpServer({ beeperToken: 'backend-secret', oauth, resourceMetadata: 'https://example.com/meta', sendMode: 'direct', directSend });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const clients = [];
  const clientFor = async token => { const c = new Client({ name: 'test', version: '1' }); clients.push(c); await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } })); return c; };
  try {
    const client = await clientFor('write'), reader = await clientFor('read');
    const tools = (await client.listTools()).tools;
    const tool = tools.find(t => t.name === 'send_message_direct');
    assert.ok(tool); assert.equal(tool.annotations.readOnlyHint, false); assert.equal(tool.annotations.openWorldHint, true);
    assert.deepEqual(tool._meta.securitySchemes[0].scopes, ['messages:read', 'messages:send']);
    assert.equal(tools.some(t => t.name === 'send_message' || t.name === 'prepare_message'), false);
    const args = { chatID: '!chat:example', text: 'private text' };
    const send = (c, arguments_) => c.callTool({ name: 'send_message_direct', arguments: arguments_ });
    assert.equal((await send(reader, args)).isError, true);
    assert.equal((await send(client, { ...args, chatID: '../x' })).isError, true);
    assert.equal(calls.length, 0);
    const results = await Promise.all([send(client, args), send(client, args)]);
    assert.deepEqual(results.map(r => JSON.parse(r.content[0].text).accepted).sort(), [false, true]);
    assert.deepEqual(calls[0], ['/v1/chats/!chat%3Aexample/messages', {}, { text: args.text }]);
    assert.equal(calls.length, 1);
    fail = true;
    const unknown = await send(client, { ...args, text: 'other private text' });
    assert.equal(JSON.parse(unknown.content[0].text).accepted, null);
    assert.equal(JSON.parse((await send(client, { ...args, text: 'other private text' })).content[0].text).accepted, false);
    assert.equal(calls.length, 2);
    fail = false;
    for (let i = 0; i < 3; i++) assert.equal(JSON.parse((await send(client, { ...args, text: `message ${i}` })).content[0].text).accepted, true);
    assert.equal(JSON.parse((await send(client, { ...args, text: 'over limit' })).content[0].text).accepted, false);
    assert.equal(calls.length, 5);
    time += 600001;
    assert.equal(JSON.parse((await send(client, args)).content[0].text).accepted, true);
    assert.ok(logs.includes('duplicate_blocked')); assert.ok(logs.includes('rate_limited')); assert.ok(logs.includes('outcome_unknown'));
    assert.ok(logs.every(x => !x.includes('private') && !x.includes(args.chatID)));
  } finally { await Promise.all(clients.map(c => c.close())); await new Promise(resolve => server.close(resolve)); }
});

test('direct mode requires OAuth and invalid modes fail closed', () => {
  assert.throws(() => createHttpServer({ mcpToken: 'x'.repeat(32), beeperToken: 'secret', sendMode: 'direct' }));
  assert.throws(() => createHttpServer({ mcpToken: 'x'.repeat(32), beeperToken: 'secret', sendMode: 'unknown' }));
});

test('replies use the send scope and shared duplicate guard', async () => {
  const calls = [];
  const backend = async (...args) => { if (/\/messages\/pending$/.test(args[0])) return { id: 'm1', isSender: true, sendStatus: { status: 'SUCCESS', timestamp: 't' } }; calls.push(args); return { pendingMessageID: 'pending' }; };
  const oauth = { handle: () => false, validateBearer: t => ['write', 'read'].includes(t), subject: t => t === 'write' ? 'client' : undefined };
  const server = createHttpServer({ beeperToken: 'secret', oauth, resourceMetadata: 'https://example.com/meta', sendMode: 'direct', directSend: createDirectSender({ backend, log: () => {} }) });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const clients = [];
  const clientFor = async token => { const c = new Client({ name: 'test', version: '1' }); clients.push(c); await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } })); return c; };
  try {
    const writer = await clientFor('write'), reader = await clientFor('read');
    const tool = (await writer.listTools()).tools.find(t => t.name === 'reply_to_message');
    assert.deepEqual(tool._meta.securitySchemes[0].scopes, ['messages:read', 'messages:send']);
    const args = { chatID: '!chat:example', messageID: '$message', text: 'reply' };
    assert.equal((await reader.callTool({ name: 'reply_to_message', arguments: args })).isError, true);
    assert.equal(JSON.parse((await writer.callTool({ name: 'reply_to_message', arguments: args })).content[0].text).accepted, true);
    assert.equal(JSON.parse((await writer.callTool({ name: 'reply_to_message', arguments: args })).content[0].text).accepted, false);
    assert.deepEqual(calls, [['/v1/chats/!chat%3Aexample/messages', {}, { text: 'reply', replyToMessageID: '$message' }]]);
  } finally { await Promise.all(clients.map(c => c.close())); await new Promise(resolve => server.close(resolve)); }
});
