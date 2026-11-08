import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { beeperCredentials } from './credentials.mjs';

for (const allowWrites of [false, true]) test(`private pipe: reads work; writes ${allowWrites ? 'explicitly enabled' : 'absent by default'}; logs do not corrupt stdout`, async () => {
  const writes = [];
  const upstream = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer synthetic-backend-key');
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST') {
      let body = ''; for await (const chunk of req) body += chunk;
      writes.push(JSON.parse(body));
      return res.end(JSON.stringify({ pendingMessageID: 'pending-test' }));
    }
    res.end(JSON.stringify([{ accountID: 'test', network: 'whatsapp', status: 'connected' }]));
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const transport = new StdioClientTransport({ command: process.execPath, args: [new URL('./stdio.mjs', import.meta.url).pathname, ...(allowWrites ? ['--allow-writes'] : [])], env: { BEEPER_ACCESS_TOKEN: 'synthetic-backend-key', BEEPER_PORT: String(upstream.address().port) }, stderr: 'pipe' });
  const client = new Client({ name: 'private-tunnel-test', version: '1' });
  let logs = '';
  transport.stderr?.on('data', data => { logs += data; });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.equal(tools.some(tool => tool.name === 'send_message_direct'), allowWrites);
    assert.equal(tools.some(tool => tool.name === 'set_chat_state'), allowWrites);
    assert.equal(tools.some(tool => tool.name === 'start_whatsapp_chat'), allowWrites);
    assert.ok(tools.every(tool => !tool._meta?.securitySchemes?.some(s => s.type === 'oauth2')));
    const result = await client.callTool({ name: 'list_accounts', arguments: {} });
    assert.equal(JSON.parse(result.content[0].text)[0].accountID, 'test');
    if (allowWrites) {
      const args = { chatID: '!synthetic:example.com', text: 'Synthetic fixture', waitSeconds: 0 };
      const first = await client.callTool({ name: 'send_message_direct', arguments: args });
      assert.equal(JSON.parse(first.content[0].text).state, 'pending');
      const second = await client.callTool({ name: 'send_message_direct', arguments: args });
      assert.equal(JSON.parse(second.content[0].text).state, 'duplicate_blocked');
    } else {
      assert.equal((await client.callTool({ name: 'send_message_direct', arguments: {} })).isError, true);
    }
    assert.equal(writes.length, allowWrites ? 1 : 0);
    assert.match(logs, /tool_call/);
    assert.doesNotMatch(logs, /synthetic-backend-key|Synthetic fixture/);
  } finally { await client.close(); await new Promise(resolve => upstream.close(resolve)); }
});
test('stdio credentials fail closed without backend authentication', () => {
  for (const env of [{}, { BEEPER_ACCESS_TOKEN: 'test', BEEPER_PORT: '0' }, { BEEPER_TARGET_FILE: '/nonexistent' }]) assert.throws(() => beeperCredentials(env));
  assert.deepEqual(beeperCredentials({ BEEPER_ACCESS_TOKEN: 'test', BEEPER_PORT: '23374' }), { port: 23374, token: 'test' });
});
