import { createHmac, randomBytes } from 'node:crypto';
import { createStatusReader } from './message-status.mjs';

export function createDirectSender({ backend, clock = Date.now, pause, log = event => console.log(`direct_send ${event}`) }) {
  const key = randomBytes(32), attempts = new Map(), rate = [];
  const status = createStatusReader({ backend, clock, ...(pause ? { pause } : {}) });
  const send = async ({ chatID, text, replyToMessageID, attachment, dedupeKey, waitSeconds = 8 }, subject) => {
    if (!subject || typeof chatID !== 'string' || !/^![^\s/\\]+:[^\s/\\]+$/.test(chatID) || (text !== undefined && (typeof text !== 'string' || !text.trim() || text.length > 10000)) || (text === undefined && !attachment) || (replyToMessageID !== undefined && (typeof replyToMessageID !== 'string' || !replyToMessageID.trim() || replyToMessageID.length > 512)) || !Number.isFinite(waitSeconds)) throw new Error('Invalid message');
    const time = clock();
    for (const [hash, expires] of attempts) if (expires <= time) attempts.delete(hash);
    while (rate.length && rate[0] <= time - 60000) rate.shift();
    const hash = createHmac('sha256', key).update(JSON.stringify([chatID, text ?? null, replyToMessageID ?? null, dedupeKey ?? null])).digest('hex');
    if (attempts.has(hash)) { log('duplicate_blocked'); return { accepted: false, state: 'duplicate_blocked', retryable: false, error: 'Duplicate blocked for 10 minutes. Check Beeper before retrying.' }; }
    if (rate.length >= 5 || attempts.size >= 1000) { log('rate_limited'); return { accepted: false, state: 'rate_limited', retryable: true, error: 'Send limit reached. Try later.' }; }
    // Reserve before awaiting: concurrent calls and ambiguous failures cannot be retried.
    attempts.set(hash, time + 600000); rate.push(time); log('attempt');
    let result;
    try {
      result = await backend(`/v1/chats/${encodeURIComponent(chatID)}/messages`, {}, { ...(text === undefined ? {} : { text }), ...(replyToMessageID === undefined ? {} : { replyToMessageID }), ...(attachment ? { attachment } : {}) });
      if (typeof result.pendingMessageID !== 'string' || !result.pendingMessageID) throw new Error('Invalid response');
    } catch (error) {
      // A definitive rejection (4xx other than timeout) means nothing was sent; anything else is unknown.
      if ([400, 401, 403, 404, 409, 422].includes(error?.status)) {
        attempts.delete(hash); log('rejected');
        return { accepted: false, state: 'rejected', code: error.category, retryable: false, error: 'Beeper rejected the message; nothing was sent.', ...(error.requestId ? { requestId: error.requestId } : {}) };
      }
      log('outcome_unknown');
      return { accepted: null, state: 'unknown_outcome', code: 'OUTCOME_UNKNOWN', retryable: false, checkBeforeRetry: true, error: 'Send outcome unknown. Check Beeper before retrying; do not retry automatically.' };
    }
    log('accepted');
    const outChat = result.chatID || chatID;
    const base = { accepted: true, chatID: outChat, pendingMessageID: result.pendingMessageID };
    if (waitSeconds <= 0) return { ...base, state: 'pending', delivered: false, read: false };
    const final = await status.wait(outChat, result.pendingMessageID, waitSeconds);
    if (final.state === 'failed') attempts.delete(hash); // the user may deliberately retry a confirmed failure
    log(`state_${final.state}`);
    return { ...base, ...final };
  };
  send.status = status.lookup;
  return send;
}
