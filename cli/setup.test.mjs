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

test('OpenAI setup and startup keep runtime credentials out of config and arguments', () => {
  const root = mkdtempSync(join(tmpdir(), 'beeper-openai-fixture-'));
  try {
    cpSync(new URL('.', import.meta.url), join(root, 'cli'), { recursive: true });
    mkdirSync(join(root, 'bin')); mkdirSync(join(root, 'mcp'));
    const mock = (name, content) => writeFileSync(join(root, 'bin', name), '#!/bin/sh\nset -eu\n' + content, { mode: 0o700 });
    mock('npm', 'exit 0\n');
    mock('beeper', 'mkdir -p state/beeper/targets\nprintf \'%s\' \'{"type":"server","baseURL":"http://127.0.0.1:23374","auth":{"accessToken":"synthetic-test-token"}}\' > state/beeper/targets/server.json\n');
    mock('tunnel-client', 'if [ "$1" = "--version" ]; then echo mock-tunnel; exit 0; fi\nexec "$TEST_NODE" capture.mjs "$@"\n');
    writeFileSync(join(root, 'capture.mjs'), "import { writeFileSync } from 'node:fs'; writeFileSync('capture.json', JSON.stringify({ args: process.argv.slice(2), hasKey: process.env.CONTROL_PLANE_API_KEY === 'synthetic-runtime-key', target: process.env.BEEPER_TARGET_FILE }));");
    const env = { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, TEST_NODE: process.execPath, CONTROL_PLANE_API_KEY: 'synthetic-runtime-key' };
    const setup = spawnSync(process.execPath, [join(root, 'cli/index.mjs'), 'setup', '--mode', 'openai', '--tunnel-id', 'tunnel_synthetic123'], { cwd: root, env, encoding: 'utf8', timeout: 5000 });
    assert.equal(setup.status, 0, setup.stderr);
    const config = readFileSync(join(root, 'state/setup.json'), 'utf8');
    assert.doesNotMatch(config, /synthetic-runtime-key|ownerHash|localToken/);
    const start = spawnSync(process.execPath, [join(root, 'cli/index.mjs'), 'start'], { cwd: root, env, encoding: 'utf8', timeout: 5000 });
    assert.equal(start.status, 0, start.stderr);
    assert.doesNotMatch(start.stdout + start.stderr, /synthetic-runtime-key/);
    const capture = JSON.parse(readFileSync(join(root, 'capture.json')));
    assert.equal(capture.hasKey, true);
    assert.doesNotMatch(capture.args.join(' '), /synthetic-runtime-key|--allow-writes/);
    assert.equal(capture.target, join(root, 'state/beeper/targets/server.json'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
