import { test } from 'node:test';
import assert from 'node:assert/strict';
import { environment, validateConfig } from './config.mjs';
import { openaiArgs } from './openai.mjs';
const config = { mode: 'openai', port: 8776, sendMode: 'confirm', tunnelId: 'tunnel_synthetic123' };
test('private tunnel uses stdio without OAuth, HTTP token, or app-level auth bypass', () => {
  const env = environment('/tmp/fixture', config);
  for (const key of ['OAUTH_ISSUER', 'OAUTH_RESOURCE', 'MCP_AUTH_TOKEN']) assert.equal(env[key], undefined);
  assert.equal(env.BEEPER_TARGET_FILE, '/tmp/fixture/state/beeper/targets/server.json');
  assert.throws(() => validateConfig({ ...config, tunnelId: '../invalid' }));
  assert.throws(() => validateConfig({ ...config, tunnelId: undefined }));
  const args = openaiArgs('/tmp/path with spaces', config, '/path/to/node');
  assert.ok(args.includes("'/path/to/node' '/tmp/path with spaces/mcp/stdio.mjs'"));
  assert.ok(!args.join(' ').includes('--allow-writes'));
  assert.match(openaiArgs('/tmp/fixture', { ...config, sendMode: 'direct' }).join(' '), /--allow-writes/);
  assert.ok(args.includes('env:CONTROL_PLANE_API_KEY'));
  assert.doesNotMatch(args.join(' '), /sk-/);
});
