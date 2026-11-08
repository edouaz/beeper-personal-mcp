import { pageHeader } from './page.mjs';
import express from 'express';
import { randomBytes, createHash, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { authorizationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import { tokenHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/token.js';
import { clientRegistrationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/register.js';
import { InvalidClientMetadataError, InvalidGrantError, InvalidTargetError, InvalidScopeError } from '@modelcontextprotocol/sdk/server/auth/errors.js';

const random = () => randomBytes(32).toString('base64url');
const digest = value => createHash('sha256').update(value).digest('hex');
const now = () => Math.floor(Date.now() / 1000);
const SCOPES = ['messages:read', 'messages:send', 'chats:start'];

// The password is created offline as scrypt$<hex salt>$<hex hash>, with a random
// high-entropy password. It is never included in a URL or persisted here.
export function hashOwnerPassword(password) {
  if (typeof password !== 'string' || password.length < 32 || password.length > 256) throw new Error('Owner password must contain 32 to 256 characters');
  const salt = randomBytes(16).toString('hex');
  return `scrypt$${salt}$${scryptSync(password, salt, 32).toString('hex')}`;
}
export function checkPassword(password, stored) {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt' || !/^[0-9a-f]{32}$/.test(parts[1]) || !/^[0-9a-f]{64}$/.test(parts[2]) || typeof password !== 'string' || password.length > 256) return false;
  const actual = scryptSync(password, parts[1], 32);
  return timingSafeEqual(actual, Buffer.from(parts[2], 'hex'));
}
function validCallback(uri) {
  try {
    const u = new URL(uri);
    return u.protocol === 'https:' && u.hostname === 'chatgpt.com' && !u.port && !u.username && !u.password && !u.search && !u.hash &&
      (u.pathname === '/connector_platform_oauth_redirect' || /^\/connector\/oauth\/[A-Za-z0-9_-]+$/.test(u.pathname));
  } catch { return false; }
}

export function createOAuth({ issuer, resource, statePath, ownerPasswordHash, sendMode = 'confirm' }) {
  if (!['confirm', 'direct'].includes(sendMode)) throw new Error('Invalid send mode');
  const issuerURL = new URL(issuer); const resourceURL = new URL(resource);
  if (issuerURL.protocol !== 'https:' || resourceURL.protocol !== 'https:' || issuerURL.origin !== resourceURL.origin || issuerURL.username || issuerURL.password || resourceURL.username || resourceURL.password || issuerURL.search || issuerURL.hash || resourceURL.search || resourceURL.hash || issuerURL.pathname !== '/beeper/oauth' || resourceURL.pathname !== '/beeper/mcp') throw new Error('Invalid OAuth URLs');
  if (!/^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$/.test(ownerPasswordHash || '')) throw new Error('Invalid owner password hash');
  let data;
  try { data = JSON.parse(readFileSync(statePath, 'utf8')); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    data = { clients: {}, codes: {}, tokens: {}, refresh: {}, usedRefresh: {} };
  }
  if (!data.clients || !data.codes || !data.tokens) throw new Error('Invalid OAuth state');
  data.refresh ||= {};
  data.usedRefresh ||= {};
  const pending = new Map();
  let failed = 0, lockedUntil = 0;
  const save = () => {
    for (const key of ['codes', 'tokens', 'refresh', 'usedRefresh']) for (const [id, item] of Object.entries(data[key])) if (item.expires <= now()) delete data[key][id];
    const tmp = `${statePath}.${randomBytes(8).toString('hex')}.tmp`;
    writeFileSync(tmp, JSON.stringify(data), { mode: 0o600, flag: 'wx' });
    renameSync(tmp, statePath); chmodSync(statePath, 0o600);
  };
  const clientsStore = {
    getClient: id => data.clients[id],
    registerClient: client => {
      if (Object.keys(data.clients).length >= 100 || client.token_endpoint_auth_method !== 'none' || !Array.isArray(client.redirect_uris) || client.redirect_uris.length !== 1 || !client.redirect_uris.every(validCallback) || client.grant_types?.some(x => !['authorization_code', 'refresh_token'].includes(x)) || client.response_types?.some(x => x !== 'code')) throw new InvalidClientMetadataError('Unsupported client registration');
      data.clients[client.client_id] = client; save(); return client;
    },
  };
  const issueTokens = (clientId, refreshExpires, family = random(), scope = 'messages:read') => {
    const access = random(), refresh = random();
    data.tokens[digest(access)] = { clientId, expires: now() + 3600, resource: resourceURL.href, scope, family };
    data.refresh[digest(refresh)] = { clientId, expires: refreshExpires, resource: resourceURL.href, scope, family };
    save();
    return { access_token: access, token_type: 'Bearer', expires_in: 3600, refresh_token: refresh, scope };
  };
  const provider = {
    clientsStore,
    async authorize(client, params, res) {
      if (params.resource?.href !== resourceURL.href) throw new InvalidTargetError('Invalid resource');
      if (params.scopes?.some(s => !SCOPES.includes(s)) || (params.scopes?.length && !params.scopes.includes('messages:read'))) throw new InvalidScopeError('Invalid scope');
      if (!/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge)) throw new InvalidGrantError('Invalid PKCE challenge');
      for (const [key, value] of pending) if (value.expires <= now()) pending.delete(key);
      if (pending.size >= 100) return res.status(429).send('Too many pending requests');
      const nonce = random(), browser = random(); pending.set(nonce, { clientId: client.client_id, params, browser, expires: now() + 300 });
      res.append('Set-Cookie', `__Host-beeper-approval=${browser}; Path=/; Max-Age=300; Secure; HttpOnly; SameSite=Strict`);
      res.set({ 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'", 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' });
      res.type('html').send(`<!doctype html><html lang="fr"><meta charset="utf-8"><title>Authorize Beeper</title>${pageHeader}<h1>Autoriser Beeper</h1><p>Autoriser les accès demandés par ChatGPT : ${params.scopes?.includes('messages:send') ? (sendMode === 'direct' ? 'lecture et envoi direct de messages sans confirmation sur une page intermédiaire.' : 'lecture et préparation d’envois. Chaque envoi exige une nouvelle approbation avec votre mot de passe sur la page de confirmation.') : 'lecture.'} ${params.scopes?.includes('chats:start') ? 'Autoriser aussi la création ou ouverture de conversations WhatsApp par numéro.' : ''}</p><form method="post" action="/beeper/oauth/approve"><input type="hidden" name="request" value="${nonce}"><label>Owner password <input name="password" type="password" autocomplete="current-password" required></label><button type="submit">Authorize</button></form></main></body></html>`);
    },
    async challengeForAuthorizationCode(client, code) {
      const item = data.codes[digest(code)];
      if (!item || item.expires <= now() || item.clientId !== client.client_id) throw new InvalidGrantError('Invalid code');
      return item.challenge;
    },
    async exchangeAuthorizationCode(client, code, _verifier, redirectUri, target) {
      const key = digest(code), item = data.codes[key];
      if (!item || item.expires <= now() || item.clientId !== client.client_id || item.redirectUri !== redirectUri || target?.href !== resourceURL.href) throw new InvalidGrantError('Invalid code');
      delete data.codes[key];
      return issueTokens(client.client_id, now() + 30 * 86400, random(), item.scope);
    },
    async exchangeRefreshToken(client, token, scopes, target) {
      const key = digest(token), item = data.refresh[key];
      const used = data.usedRefresh[key];
      if (!item && used && used.expires > now() && used.clientId === client.client_id && target?.href === resourceURL.href) {
        for (const bucket of ['refresh', 'tokens']) for (const [id, value] of Object.entries(data[bucket])) if (value.family === used.family) delete data[bucket][id];
        save();
        throw new InvalidGrantError('Refresh token reuse detected');
      }
      if (!item || item.expires <= now() || item.clientId !== client.client_id || item.resource !== resourceURL.href || target?.href !== resourceURL.href || scopes?.some(scope => !item.scope.split(' ').includes(scope))) throw new InvalidGrantError('Invalid refresh token');
      delete data.refresh[key];
      data.usedRefresh[key] = item;
      return issueTokens(client.client_id, item.expires, item.family, scopes?.length ? scopes.join(' ') : item.scope);
    },
  };
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => { res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }); if (Number(req.headers['content-length']) > 8192) return res.status(413).send('Request too large'); next(); });
  app.use(express.json({ limit: '8kb' }));
  app.use(express.urlencoded({ extended: false, limit: '8kb' }));
  app.use((error, _req, res, _next) => res.status(error.status === 413 ? 413 : 400).send('Invalid request body'));
  const base = issuerURL.pathname;
  app.get('/.well-known/oauth-protected-resource/beeper/mcp', (_req, res) => res.json({ resource: resourceURL.href, authorization_servers: [issuerURL.href], scopes_supported: SCOPES, bearer_methods_supported: ['header'] }));
  app.get('/.well-known/oauth-authorization-server/beeper/oauth', (_req, res) => res.json({ issuer: issuerURL.href, authorization_endpoint: `${issuerURL.href}/authorize`, token_endpoint: `${issuerURL.href}/token`, registration_endpoint: `${issuerURL.href}/register`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], scopes_supported: SCOPES }));
  app.use(`${base}/authorize`, authorizationHandler({ provider }));
  app.use(`${base}/token`, tokenHandler({ provider }));
  app.use(`${base}/register`, clientRegistrationHandler({ clientsStore }));
  app.post(`${base}/approve`, express.urlencoded({ extended: false, limit: '2kb' }), (req, res) => {
    const origin = req.get('origin'), referer = req.get('referer');
    let refererOrigin;
    try { if (referer) refererOrigin = new URL(referer).origin; } catch { return res.status(403).send('Invalid origin'); }
    if ((origin && origin !== 'null' && origin !== issuerURL.origin) || (referer && refererOrigin !== issuerURL.origin) || req.get('sec-fetch-site') === 'cross-site') return res.status(403).send('Invalid origin');
    if (Date.now() < lockedUntil) return res.status(429).send('Too many attempts; try again later');
    const request = pending.get(req.body.request);
    if (!request || request.expires <= now()) return res.status(400).send('Authorization request expired');
    const cookies = (req.get('cookie') || '').split(';').map(cookie => cookie.trim()).filter(cookie => cookie.startsWith('__Host-beeper-approval='));
    if (cookies.length !== 1 || cookies[0] !== `__Host-beeper-approval=${request.browser}`) return res.status(403).send('Invalid approval');
    if (!checkPassword(req.body.password, ownerPasswordHash)) {
      if (++failed >= 5) { failed = 0; lockedUntil = Date.now() + 15 * 60 * 1000; }
      return res.status(401).send('Authorization failed');
    }
    failed = 0; pending.delete(req.body.request);
    const code = random(), params = request.params;
    data.codes[digest(code)] = { clientId: request.clientId, challenge: params.codeChallenge, redirectUri: params.redirectUri, resource: resourceURL.href, scope: (params.scopes?.length ? params.scopes : ['messages:read']).join(' '), expires: now() + 300 }; save();
    const redirect = new URL(params.redirectUri); redirect.searchParams.set('code', code);
    if (params.state) redirect.searchParams.set('state', params.state);
    return res.redirect(303, redirect.href);
  });
  const paths = new Set(['/.well-known/oauth-protected-resource/beeper/mcp', '/.well-known/oauth-authorization-server/beeper/oauth', `${base}/authorize`, `${base}/token`, `${base}/register`, `${base}/approve`]);
  return {
    handle(req, res) { if (!paths.has(new URL(req.url, issuerURL.origin).pathname)) return false; app(req, res); return true; },
    subject(token, scope = 'messages:send') { const item = typeof token === 'string' && data.tokens[digest(token)]; return item && item.expires > now() && item.resource === resourceURL.href && item.scope?.split(' ').includes(scope) ? item.clientId : undefined; },
    validateBearer(token) { const item = typeof token === 'string' && data.tokens[digest(token)]; return !!item && item.expires > now() && item.resource === resourceURL.href; },
  };
}
