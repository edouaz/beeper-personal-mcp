import { pageHeader } from './page.mjs';
import express from 'express';
import { randomBytes } from 'node:crypto';
import { checkPassword } from './oauth.mjs';

const random = () => randomBytes(32).toString('base64url');
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

export function createConfirmations({ origin, ownerPasswordHash, backend, clock = Date.now }) {
  if (new URL(origin).origin !== origin || !origin.startsWith('https://')) throw new Error('Invalid confirmation origin');
  const pending = new Map();
  let failed = 0, lockedUntil = 0;
  const lookup = token => {
    for (const [key, item] of pending) if (item.expires <= clock()) pending.delete(key);
    const item = pending.get(token);
    if (!item) throw new Error('Confirmation expired or consumed');
    return item;
  };
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" });
    next();
  });
  app.use(express.urlencoded({ extended: false, limit: '2kb' }));
  const path = '/beeper/oauth/confirm';
  app.get(path, (req, res) => {
    try {
      const item = lookup(req.query.request);
      item.csrf = random();
      res.type('html').send(`<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Confirmer le message Beeper</title>${pageHeader}<h1>Autoriser cet envoi</h1><p>Conversation : <strong>${escape(item.title)}</strong></p><p>Réseau : ${escape(item.network)}</p><p>Identifiant exact : <code>${escape(item.chatID)}</code></p><pre style="white-space:pre-wrap;unicode-bidi:plaintext">${escape(item.text)}</pre><p>Cette autorisation expire après 10 minutes et permet un seul essai d’envoi. Le bouton autorise ChatGPT à envoyer ce message exact.</p><form method="post" action="${path}"><input type="hidden" name="request" value="${escape(req.query.request)}"><input type="hidden" name="csrf" value="${item.csrf}"><label>Mot de passe propriétaire <input type="password" name="password" autocomplete="current-password" required maxlength="256"></label><button type="submit">J’autorise cet envoi exact</button></form></main></body></html>`);
    } catch { res.status(410).send('Confirmation expirée ou déjà utilisée.'); }
  });
  app.post(path, (req, res) => {
    if (req.get('origin') !== origin) return res.status(403).send('Origine invalide.');
    if (clock() < lockedUntil) return res.status(429).send('Trop de tentatives. Réessayez plus tard.');
    try {
      const item = lookup(req.body?.request);
      if (!item.csrf || req.body.csrf !== item.csrf) return res.status(403).send('Formulaire invalide.');
      if (!checkPassword(req.body.password, ownerPasswordHash)) {
        if (++failed >= 5) { failed = 0; lockedUntil = clock() + 15 * 60 * 1000; }
        return res.status(401).send('Authentification refusée.');
      }
      failed = 0; item.approved = true; delete item.csrf;
      res.type('html').send(`<!doctype html><html lang="fr"><meta charset="utf-8"><title>Message autorisé</title>${pageHeader}<p>Autorisation enregistrée. Revenez dans ChatGPT pour terminer cet envoi. Aucun message n’a été envoyé par cette page.</p></main></body></html>`);
    } catch { res.status(410).send('Confirmation expirée ou déjà utilisée.'); }
  });
  app.use((error, _req, res, _next) => res.status(error.status === 413 ? 413 : 400).send('Requête invalide.'));
  return {
    handle(req, res) { if (new URL(req.url, origin).pathname !== path) return false; app(req, res); return true; },
    async prepare({ chatID, text }, subject) {
      if (!subject || typeof chatID !== 'string' || !/^![^\s/\\]+:[^\s/\\]+$/.test(chatID) || typeof text !== 'string' || !text.trim() || text.length > 10000) throw new Error('Invalid draft or missing send scope');
      for (const [key, item] of pending) if (item.expires <= clock()) pending.delete(key);
      if (pending.size >= 100) throw new Error('Too many pending confirmations');
      const chat = await backend(`/v1/chats/${encodeURIComponent(chatID)}`);
      if (chat.id !== chatID) throw new Error('Chat identity mismatch');
      const confirmationToken = random();
      const item = { chatID, text, title: String(chat.title || chatID), network: String(chat.network || chat.accountID || 'Beeper'), subject, expires: clock() + 600000, approved: false };
      pending.set(confirmationToken, item);
      return { confirmationToken, confirmationURL: `${origin}${path}?request=${confirmationToken}`, chatID, title: item.title, network: item.network, text, expiresAt: new Date(item.expires).toISOString(), sent: false };
    },
    async send({ confirmationToken }, subject) {
      const item = lookup(confirmationToken);
      if (!subject || item.subject !== subject || !item.approved) throw new Error('Owner confirmation required');
      // Consume before awaiting the backend: never retry an ambiguous send automatically.
      pending.delete(confirmationToken);
      try {
        const result = await backend(`/v1/chats/${encodeURIComponent(item.chatID)}/messages`, {}, { text: item.text });
        if (typeof result.pendingMessageID !== 'string' || !result.pendingMessageID) throw new Error('Invalid send response');
        return { accepted: true, delivered: false, chatID: result.chatID || item.chatID, pendingMessageID: result.pendingMessageID };
      } catch {
        return { accepted: null, confirmationConsumed: true, error: 'Send outcome unknown. Check Beeper before preparing another send; never retry automatically.' };
      }
    },
  };
}
