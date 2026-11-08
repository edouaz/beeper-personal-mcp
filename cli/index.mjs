#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync, openSync, closeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { openaiArgs, runtimeKey } from './openai.mjs';
import { configured, saveConfig, loadConfig, validateConfig, environment } from './config.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const beeper = join(root, 'bin/beeper');
const children = new Set();
let stopping = false;
function launch(command, args, options = {}) {
  const child = spawn(command, args, { cwd: root, stdio: 'inherit', ...options });
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}
function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = launch(command, args, options);
    child.once('error', () => reject(new Error(`Cannot run ${command}. Check that it is installed and on PATH.`)));
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited with status ${code}.`)));
  });
}
function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  // Do not stop the Beeper process managed by its own CLI.
  setTimeout(() => { for (const child of children) child.kill('SIGKILL'); process.exit(code); }, 2000).unref();
  process.exitCode = code;
}
process.on('SIGINT', () => stop(130));
process.on('SIGTERM', () => stop(143));

async function setup(options) {
  if (configured(root)) throw new Error('Already configured. Your credentials were preserved. Use start or doctor; see docs/INSTALL.md to change modes.');
  if (existsSync(join(root, 'state/mcp.env'))) throw new Error('Existing manual deployment detected. See docs/INSTALL.md before migrating; no files were changed.');
  const rl = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
  const ask = async (question, fallback) => {
    if (!rl) return fallback;
    return (await rl.question(question)).trim() || fallback;
  };
  let mode, origin, email, tunnelId, allowWrites;
  try {
    console.log('\nBeeper Personal MCP · Your conversations, connected.\n');
    mode = options.mode || await ask('Connection: local / openai (private ChatGPT) / tunnel (Cloudflare) / remote [local]: ', 'local');
    origin = options.url;
    if (mode === 'remote' && !origin) origin = await ask('Public HTTPS origin (https://mcp.example.com): ', '');
    if (mode === 'openai') {
      tunnelId = options['tunnel-id'] || await ask('OpenAI tunnel_id (from Platform tunnel settings): ', '');
      allowWrites = options['allow-writes'] || (await ask('Enable direct writes through your private tunnel? yes / no [no]: ', 'no')).toLowerCase() === 'yes';
    }
    email = options.email || await ask('Beeper account email (Enter to use Beeper’s own prompt): ', '');
  } finally { rl?.close(); }
  const config = validateConfig({ version: 1, mode, port: Number(options.port || 8776), sendMode: allowWrites ? 'direct' : 'confirm', ...(tunnelId ? { tunnelId } : {}), ...(origin ? { origin } : {}) });
  if (['remote', 'tunnel'].includes(mode) && !process.stdout.isTTY) throw new Error('Remote setup must run in a terminal so the owner password is shown privately.');
  if (mode === 'openai') await run('tunnel-client', ['--version']);
  if (mode === 'tunnel') await run('cloudflared', ['--version']);
  console.log('Installing locked MCP dependencies…');
  await run('npm', ['ci', '--prefix', join(root, 'mcp')]);
  console.log('Setting up your Beeper Server. Complete login and device verification when asked.');
  await run(beeper, ['setup', '--server', '--install', '-t', 'server', ...(email ? ['--email', email] : [])]);
  // Server may be reachable before authentication has completed: require a saved credential.
  const target = JSON.parse(readFileSync(join(root, 'state/beeper/targets/server.json'), 'utf8'));
  if (!target.auth?.accessToken) throw new Error('Beeper login is incomplete. Finish verification with bin/beeper, then run setup again.');
  let password;
  if (mode === 'local') config.localToken = randomBytes(32).toString('base64url');
  else if (mode !== 'openai') {
    const { hashOwnerPassword } = await import('../mcp/oauth.mjs');
    password = randomBytes(32).toString('base64url');
    config.ownerHash = hashOwnerPassword(password);
  }
  saveConfig(root, config);
  if (password) console.log(`\nSave this owner password in your password manager (shown once):\n\n${password}\n`);
  console.log('Ready. Start the gateway with: npm start\nCheck your setup with: npm run doctor');
  if (mode === 'local') console.log('Local mode exposes read tools. Run node cli/index.mjs connection to show the private client configuration.');
}
async function tunnel(port) {
  return new Promise((resolve, reject) => {
    let output = '', found = false;
    const child = launch('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], { stdio: ['ignore', 'ignore', 'pipe'] });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Tunnel timed out. Check cloudflared, your network, and ~/.cloudflared/config.yaml.')); }, 45000);
    child.once('error', () => { clearTimeout(timer); reject(new Error('Install cloudflared first; see docs/INSTALL.md.')); });
    child.stderr.on('data', chunk => {
      output = (output + chunk.toString()).slice(-16384);
      const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/);
      if (match && !found) { found = true; clearTimeout(timer); resolve(match[0]); }
    });
    child.once('exit', () => {
      clearTimeout(timer);
      if (!found) reject(new Error('Tunnel stopped before assigning an address. Check cloudflared configuration and network access.'));
      else if (!stopping) { console.error('Tunnel stopped. Restart npm start and reconnect the new address.'); stop(1); }
    });
  });
}
async function start() {
  const config = loadConfig(root);
  if (config.mode === 'openai') {
    const key = await runtimeKey();
    await run(beeper, ['targets', 'start', 'server']);
    console.log(`\nPrivate OpenAI tunnel: ${config.tunnelId}\nIn ChatGPT: Add custom MCP server → Connection: Tunnel → select this tunnel → No authentication.\nAccess: ${config.sendMode === 'direct' ? 'READ + DIRECT WRITES (keep client approvals enabled)' : 'read-only'}. No public hostname or OAuth login.\nPress Ctrl+C to stop the tunnel.\n`);
    await run('tunnel-client', openaiArgs(root, config), { env: { ...environment(root, config), CONTROL_PLANE_API_KEY: key } });
    stop(0);
    return;
  }
  // Avoid launching a tunnel toward a different process already listening on this port.
  const { createServer } = await import('node:net');
  await new Promise((resolve, reject) => { const probe = createServer(); probe.once('error', () => reject(new Error(`Port ${config.port} is already in use.`))); probe.listen(config.port, '127.0.0.1', () => probe.close(resolve)); });
  await run(beeper, ['targets', 'start', 'server']);
  let origin = config.origin;
  if (config.mode === 'tunnel') {
    origin = await tunnel(config.port);
    rmSync(join(root, 'state/oauth-tunnel.json'), { force: true });
    console.log('Temporary tunnel: this address changes each start. Reconnect your client after restarting.');
  }
  const env = environment(root, config, origin);
  console.log(`\nMCP URL: ${config.mode === 'local' ? `http://127.0.0.1:${config.port}/mcp` : `${origin}/beeper/mcp`}\nPress Ctrl+C to stop the gateway${config.mode === 'tunnel' ? ' and tunnel' : ''}.\n`);
  await run(process.execPath, [join(root, 'mcp/server.mjs')], { env });
  stop(0);
}
async function doctor() {
  let failed = false;
  const check = (label, okay) => { console.log(`${okay ? '✓' : '✗'} ${label}`); if (!okay) failed = true; };
  check('Guided setup configured', configured(root));
  if (!configured(root)) { process.exitCode = 1; return; }
  const config = loadConfig(root);
  check('Beeper target saved', existsSync(join(root, 'state/beeper/targets/server.json')));
  try { await run(beeper, ['doctor', '-t', 'server']); } catch { failed = true; }
  if (config.mode === 'openai') {
    await run('tunnel-client', ['--version']);
    console.log(`Private tunnel: ${config.tunnelId}. Check the local admin UI printed by tunnel-client for readiness and polling. No HTTP gateway runs in this mode.`);
    process.exitCode = failed ? 1 : 0;
    return;
  }
  try {
    const response = await fetch(`http://127.0.0.1:${config.port}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(3000) });
    check('Gateway running and rejects unauthenticated requests', response.status === 401);
  } catch { check('Gateway running (start with npm start)', false); }
  console.log(`Mode: ${config.mode}. This checks local readiness, not remote TLS, OAuth or message delivery.`);
  process.exitCode = failed ? 1 : 0;
}
function connection() {
  const config = loadConfig(root);
  if (config.mode === 'openai') { console.log(`ChatGPT connection: Tunnel, ID: ${config.tunnelId}, authentication: None. Access: ${config.sendMode === 'direct' ? 'read-write' : 'read-only'}.`); return; }
  if (config.mode !== 'local') { console.log('Use the HTTPS MCP URL printed by npm start, with OAuth. See docs/INSTALL.md.'); return; }
  if (!process.stdout.isTTY) throw new Error('Run in a terminal: this prints your private local bearer token.');
  console.log('Private client configuration — never share or commit this:');
  console.log(JSON.stringify({ mcpServers: { beeper: { type: 'http', url: `http://127.0.0.1:${config.port}/mcp`, headers: { Authorization: `Bearer ${config.localToken}` } } } }, null, 2));
}
const help = `Beeper Personal MCP\n\n  ./bin/setup                    Install, configure and launch\n  npm ci                         Install the official Beeper CLI\n  npm run setup                  Guided first-time setup\n  npm start                      Start the configured gateway\n  npm run doctor                 Check local readiness\n  node cli/index.mjs connection   Show local client settings (private)\n\nSetup flags: --mode local|openai|tunnel|remote --url https://mcp.example.com\n            --email you@example.com --port 8776\n            --tunnel-id tunnel_... --allow-writes (OpenAI mode only)\n\nLocal mode is read-only. OpenAI uses a private stdio tunnel (no OAuth).\nPublic tunnel and remote modes use OAuth with owner approval.\nCloudflared must be installed separately for temporary tunnels.\nDocumentation: docs/INSTALL.md\n`;
try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { mode: { type: 'string' }, url: { type: 'string' }, email: { type: 'string' }, 'tunnel-id': { type: 'string' }, 'allow-writes': { type: 'boolean' }, port: { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
  const command = positionals[0];
  if (values.help || !command || command === 'help') console.log(help);
  else if (command === 'onboard') {
    if (!existsSync(join(root, 'node_modules/.bin/beeper'))) await run('npm', ['ci', '--prefix', root]);
    if (!configured(root)) await setup(values);
    // Reuse the normal runner and its lock in a fresh child process.
    await run(process.execPath, [fileURLToPath(import.meta.url), 'start']);
  }
  else if (command === 'setup') await setup(values);
  else if (command === 'start') {
    // One CLI instance per checkout; avoid invalidating a running tunnel's grants.
    const lock = join(root, 'state/gateway.lock');
    let fd;
    try { fd = openSync(lock, 'wx', 0o600); } catch (error) {
      if (error.code === 'EEXIST') throw new Error('Gateway lock exists. If no gateway is running, remove state/gateway.lock after an unclean shutdown.');
      throw error;
    }
    process.once('exit', () => { closeSync(fd); rmSync(lock, { force: true }); });
    await start();
  } else if (command === 'doctor') await doctor();
  else if (command === 'connection') connection();
  else throw new Error(`Unknown command: ${command}. Use --help.`);
} catch (error) { console.error(`\nBeeper MCP: ${error.message}`); stop(1); }
