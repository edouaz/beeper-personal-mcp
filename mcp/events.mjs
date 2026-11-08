import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

// The Beeper stream is an upsert feed, not a guaranteed new-message feed.
export function createForwarder({ port, token, webhook, secret, chats = [], accounts = [], fetcher = fetch, connect = (url, options) => new WebSocket(url, options), log = console.log, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const url = new URL(webhook);
  if (url.username || url.password || url.hash || !(url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) throw new Error('Webhook must be HTTPS or loopback HTTP, without credentials or fragment');
  if (Buffer.byteLength(secret || '') < 32 || !token || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid event configuration');
  if (chats.includes('*')) throw new Error('Omit chat IDs to subscribe to all chats');
  let stopped = false, socket, reconnect, ping, draining = false, delay = 1000;
  const queue = [], seen = new Map();
  async function drain() {
    if (draining) return;
    draining = true;
    while (queue.length && !stopped) {
      const item = queue[0]; let delivered = false;
      try {
        if (accounts.length) {
          const chatID = item.event.chatID;
          if (typeof chatID !== 'string' || !chatID || chatID === '.' || chatID === '..' || /[\\/]/.test(chatID)) { queue.shift(); continue; }
          const response = await fetcher(`http://127.0.0.1:${port}/v1/chats/${encodeURIComponent(chatID)}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000), redirect: 'error' });
          if (!response.ok) throw new Error('Lookup failed');
          const chat = await response.json();
          if (!accounts.includes(chat.accountID)) { queue.shift(); continue; }
        }
        const signature = createHmac('sha256', secret).update(item.body).digest('hex');
        const response = await fetcher(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-beeper-signature': `sha256=${signature}`, 'x-beeper-event-id': item.id }, body: item.body, redirect: 'error', signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw new Error('Delivery failed');
        delivered = true;
      } catch { /* No URL, token, response body or message is logged. */ }
      if (delivered) { queue.shift(); continue; }
      if (++item.attempts >= 5) { queue.shift(); log('Event delivery failed after retries'); }
      else await pause(Math.min(30000, 1000 * 2 ** (item.attempts - 1)));
    }
    draining = false;
  }
  function accept(data) {
    if (data.length > 262144) { log('Oversized event dropped'); return; }
    const body = data.toString(); let event;
    try { event = JSON.parse(body); } catch { return; }
    if (event?.type !== 'message.upserted') return;
    if (chats.length && !chats.includes(event.chatID)) return;
    const id = createHash('sha256').update(body).digest('hex');
    const now = Date.now();
    for (const [key, at] of seen) if (now - at > 600000) seen.delete(key);
    if (seen.has(id)) return;
    if (queue.length >= 128) { log('Event queue full; event dropped'); return; }
    seen.set(id, now); if (seen.size > 2048) seen.delete(seen.keys().next().value);
    queue.push({ event, body, id, attempts: 0 }); void drain();
  }
  function start() {
    if (stopped) return;
    socket = connect(`ws://127.0.0.1:${port}/v1/ws`, { headers: { Authorization: `Bearer ${token}` }, handshakeTimeout: 10000, maxPayload: 262144, followRedirects: false });
    let alive = true;
    socket.on('open', () => { delay = 1000; socket.send(JSON.stringify({ type: 'subscriptions.set', chatIDs: chats.length ? chats : ['*'] })); log('Event stream connected'); });
    socket.on('pong', () => { alive = true; });
    socket.on('message', accept);
    socket.on('error', () => {});
    ping = setInterval(() => { if (!alive) return socket.terminate(); alive = false; if (socket.readyState === WebSocket.OPEN) socket.ping(); }, 30000);
    socket.on('close', () => { clearInterval(ping); if (!stopped) { log('Event stream disconnected; reconnecting'); reconnect = setTimeout(start, delay); delay = Math.min(delay * 2, 30000); } });
  }
  return { start, stop() { stopped = true; clearTimeout(reconnect); clearInterval(ping); socket?.terminate(); }, accept };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const target = JSON.parse(readFileSync(process.env.BEEPER_TARGET_FILE, 'utf8'));
  const base = new URL(target.baseURL);
  if (target.type !== 'server' || base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error('Invalid Beeper target');
  const parseList = value => value ? value.split(',').map(s => s.trim()).filter(Boolean) : [];
  const worker = createForwarder({ port: Number(base.port || 80), token: target.auth?.accessToken, webhook: process.env.BEEPER_WEBHOOK_URL, secret: process.env.BEEPER_WEBHOOK_SECRET, chats: parseList(process.env.BEEPER_EVENT_CHAT_IDS), accounts: parseList(process.env.BEEPER_EVENT_ACCOUNT_IDS) });
  worker.start();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { worker.stop(); process.exit(0); });
}
