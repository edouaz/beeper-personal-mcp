import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { environment, loadConfig, saveConfig, validateConfig } from './config.mjs';
const base = { mode: 'local', port: 8776, sendMode: 'confirm', localToken: 'a'.repeat(43) };
test('new setup is private, roundtrips and cannot overwrite credentials', () => {
  const root = mkdtempSync(join(tmpdir(), 'beeper-setup-'));
  try {
    saveConfig(root, base);
    assert.deepEqual(loadConfig(root), base);
    assert.equal(statSync(join(root, 'state')).mode & 0o777, 0o700);
    assert.equal(statSync(join(root, 'state/setup.json')).mode & 0o777, 0o600);
    assert.throws(() => saveConfig(root, { ...base, port: 9000 }), /EEXIST/);
    assert.equal(JSON.parse(readFileSync(join(root, 'state/setup.json'))).port, 8776);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('remote origins reject insecure URLs, credentials and path injection', () => {
  for (const origin of ['http://mcp.example.com', 'https://user:pass@mcp.example.com', 'https://mcp.example.com/path', 'https://mcp.example.com?x=1', 'https://localhost', 'https://mcp.example.com/']) {
    assert.throws(() => validateConfig({ ...base, mode: 'remote', origin }));
  }
  assert.equal(validateConfig({ ...base, mode: 'remote', origin: 'https://mcp.example.com' }).mode, 'remote');
  for (const port of [0, 80, 65536, NaN, 8776.5]) assert.throws(() => validateConfig({ ...base, port }));
});
test('mode environments isolate auth and keep tunnel grants separate', () => {
  const previous = process.env.OAUTH_ISSUER;
  process.env.OAUTH_ISSUER = 'https://old.example.com/beeper/oauth';
  try {
    const local = environment('/tmp/fixture', base);
    assert.equal(local.OAUTH_ISSUER, undefined);
    assert.equal(local.MCP_AUTH_TOKEN, base.localToken);
    assert.throws(() => environment('/tmp/fixture', { ...base, localToken: '' }));
    const remote = environment('/tmp/fixture', { ...base, mode: 'tunnel', ownerHash: 'hash' }, 'https://test.trycloudflare.com');
    assert.equal(remote.MCP_AUTH_TOKEN, undefined);
    assert.equal(remote.OAUTH_RESOURCE, 'https://test.trycloudflare.com/beeper/mcp');
    assert.equal(remote.OAUTH_STATE_PATH, '/tmp/fixture/state/oauth-tunnel.json');
  } finally { if (previous === undefined) delete process.env.OAUTH_ISSUER; else process.env.OAUTH_ISSUER = previous; }
});
test('CLI help is safe without dependencies, unknown flags and commands fail', () => {
  const cli = new URL('./index.mjs', import.meta.url);
  const help = spawnSync(process.execPath, [cli.pathname, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Guided first-time setup/);
  for (const arg of ['--invalid', 'invalid']) {
    const result = spawnSync(process.execPath, [cli.pathname, arg], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Beeper MCP:/);
  }
});
