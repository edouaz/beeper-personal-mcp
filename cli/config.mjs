import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

export function validateConfig(config) {
  if (!['local', 'remote', 'tunnel'].includes(config.mode)) throw new Error('Mode must be local, remote or tunnel.');
  if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) throw new Error('Port must be between 1024 and 65535.');
  if (!['confirm', 'direct'].includes(config.sendMode)) throw new Error('Send mode must be confirm or direct.');
  if (config.mode === 'remote') {
    const url = new URL(config.origin);
    if (url.protocol !== 'https:' || url.origin !== config.origin || url.username || url.password || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Use a public HTTPS origin, for example https://mcp.example.com (no path or trailing slash).');
  }
  return config;
}
export function saveConfig(root, config) {
  validateConfig(config);
  const state = join(root, 'state');
  mkdirSync(state, { recursive: true, mode: 0o700 });
  chmodSync(state, 0o700);
  // Never overwrite an existing installation or its credentials.
  writeFileSync(join(state, 'setup.json'), JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
export function loadConfig(root) {
  return validateConfig(JSON.parse(readFileSync(join(root, 'state/setup.json'), 'utf8')));
}
export function environment(root, config, origin = config.origin) {
  validateConfig(config);
  const env = { ...process.env };
  // Do not inherit a second authentication mode from the caller's shell.
  for (const key of ['OAUTH_ISSUER', 'OAUTH_RESOURCE', 'OAUTH_STATE_PATH', 'OAUTH_OWNER_PASSWORD_HASH', 'MCP_AUTH_TOKEN', 'BEEPER_ACCESS_TOKEN', 'BEEPER_PORT']) delete env[key];
  env.MCP_PORT = String(config.port);
  env.BEEPER_TARGET_FILE = join(root, 'state/beeper/targets/server.json');
  env.BEEPER_SEND_MODE = config.sendMode;
  if (config.mode === 'local') {
    env.MCP_AUTH_TOKEN = config.localToken;
    if (!/^[A-Za-z0-9_-]{43}$/.test(config.localToken || '')) throw new Error('Invalid local token; restore state/setup.json from your private backup.');
  } else {
    validateConfig({ ...config, mode: 'remote', origin });
    env.OAUTH_ISSUER = `${origin}/beeper/oauth`;
    env.OAUTH_RESOURCE = `${origin}/beeper/mcp`;
    // A temporary tunnel must never reuse grants for an earlier hostname.
    env.OAUTH_STATE_PATH = join(root, config.mode === 'tunnel' ? 'state/oauth-tunnel.json' : 'state/oauth.json');
    env.OAUTH_OWNER_PASSWORD_HASH = config.ownerHash;
  }
  return env;
}
export const configured = root => existsSync(join(root, 'state/setup.json'));
