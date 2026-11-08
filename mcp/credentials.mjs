import { readFileSync } from 'node:fs';

export function beeperCredentials(env = process.env) {
  let token = env.BEEPER_ACCESS_TOKEN;
  let port = Number(env.BEEPER_PORT || '23374');
  if (!token && env.BEEPER_TARGET_FILE) {
    try {
      const target = JSON.parse(readFileSync(env.BEEPER_TARGET_FILE, 'utf8'));
      const url = new URL(target.baseURL);
      if (target.type !== 'server' || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error();
      const targetPort = Number(url.port || '80');
      if (env.BEEPER_PORT && port !== targetPort) throw new Error();
      port = targetPort;
      token = target.auth?.accessToken;
    } catch { throw new Error('Could not load Beeper Server target authentication'); }
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535 || typeof token !== 'string' || !token) throw new Error('Missing Beeper authentication or invalid backend port');
  return { token, port };
}
