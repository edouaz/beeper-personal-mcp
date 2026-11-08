import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('clean checkout local setup installs, logs in and preserves credentials on rerun', () => {
  const root = mkdtempSync(join(tmpdir(), 'beeper-cli-fixture-'));
  try {
    cpSync(new URL('.', import.meta.url), join(root, 'cli'), { recursive: true });
    mkdirSync(join(root, 'bin'));
    mkdirSync(join(root, 'mcp'));
    const mock = (name, content) => writeFileSync(join(root, 'bin', name), '#!/bin/sh\nset -eu\n' + content, { mode: 0o700 });
    mock('npm', 'echo "mock dependency install"\n');
    mock('beeper', 'mkdir -p state/beeper/targets\nprintf \'%s\' \'{"type":"server","baseURL":"http://127.0.0.1:23374","auth":{"accessToken":"synthetic-test-token"}}\' > state/beeper/targets/server.json\n');
    const run = () => spawnSync(process.execPath, [join(root, 'cli/index.mjs'), 'setup', '--mode', 'local'], { cwd: root, env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}` }, encoding: 'utf8', timeout: 5000 });
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    const config = readFileSync(join(root, 'state/setup.json'), 'utf8');
    assert.match(JSON.parse(config).localToken, /^[A-Za-z0-9_-]{43}$/);
    assert.doesNotMatch(first.stdout, new RegExp(JSON.parse(config).localToken));
    const second = run();
    assert.equal(second.status, 1);
    assert.match(second.stderr, /Already configured/);
    assert.equal(readFileSync(join(root, 'state/setup.json'), 'utf8'), config);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
