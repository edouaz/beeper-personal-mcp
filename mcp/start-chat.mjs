// Idempotent "find or open" for a WhatsApp 1:1 chat. No message or invitation is ever sent.
//
// Root cause of the original failures (see README): POST /v1/chats/start is idempotent
// (the bridge's create_dm returns the existing portal), but Beeper Desktop API can answer
// 404 "User not found" while the bridge call actually succeeded and the new room is not yet
// indexed locally. A 404/5xx/timeout on this route is therefore NOT proof of failure.
// Since starting a chat sends nothing, reconciling by looking the chat up and re-asking is safe.
// (Unlike message sends, which are never retried automatically.)
const E164 = /^\+[1-9]\d{7,14}$/;
const CHAT_ID = /^![^\s/\\]+:[^\s/\\]+$/;
// Strips formatting only. A number without an explicit "+" (or "00") is rejected: we never guess a country.
export function normalizePhone(value) {
  if (typeof value !== 'string') return undefined;
  let v = value.trim().replace(/[\s.\-()]/g, '');
  if (v.startsWith('00')) v = `+${v.slice(2)}`;
  return E164.test(v) ? v : undefined;
}
const digits = value => typeof value === 'string' ? value.replace(/\D/g, '') : '';

export function createChatStarter({ backend, clock = Date.now, pause = ms => new Promise(resolve => setTimeout(resolve, ms)), maxScanPages = 5, reconcileDelays = [1500, 4000] }) {
  const attempts = [];
  // Look for an existing 1:1 chat whose participant has this phone number.
  async function findExisting(accountID, phoneNumber) {
    const wanted = digits(phoneNumber);
    let cursor, complete = false;
    for (let pageNo = 0; pageNo < maxScanPages; pageNo++) {
      const page = await backend('/v1/chats', { accountIDs: accountID, limit: 100, ...(cursor ? { cursor, direction: 'before' } : {}) });
      for (const chat of page.items || []) {
        if (chat.type !== 'single' || chat.accountID !== accountID || !CHAT_ID.test(chat.id || '')) continue;
        if ((chat.participants?.items || []).some(p => !p.isSelf && digits(p.phoneNumber) === wanted)) return { chat, complete: false };
      }
      if (!page.hasMore || !page.oldestCursor) { complete = true; break; }
      cursor = page.oldestCursor;
    }
    return { chat: undefined, complete };
  }
  const ok = (chat, status, phoneNumber, extra = {}) => ({ started: true, status, chatID: chat.id || chat.chatID, phoneNumber, network: 'WhatsApp', ...extra });
  // Concurrent identical requests share one run: no parallel start calls for the same account+number.
  const inflight = new Map();
  return (input, subject) => {
    const phone = normalizePhone(input?.phoneNumber);
    if (!subject || typeof input?.accountID !== 'string' || !input.accountID || input.accountID.length > 512 || !phone) return Promise.reject(new Error('Invalid account or E.164 phone number'));
    const key = JSON.stringify([input.accountID, phone]);
    if (inflight.has(key)) return inflight.get(key);
    const run = startOnce({ accountID: input.accountID, phoneNumber: phone }).finally(() => inflight.delete(key));
    inflight.set(key, run);
    return run;
  };
  async function startOnce({ accountID, phoneNumber }) {
    const accounts = await backend('/v1/accounts');
    const account = Array.isArray(accounts) && accounts.find(item => item.accountID === accountID);
    if (!account || account.network?.toLowerCase() !== 'whatsapp' || account.status !== 'connected') return { started: false, status: 'unsupported', code: 'ACCOUNT_UNAVAILABLE', retryable: false, error: 'Select a connected WhatsApp account.' };
    // Anti-abuse: opening chats probes WhatsApp registration, so keep a low global rate.
    const now = clock();
    while (attempts.length && attempts[0] <= now - 60000) attempts.shift();
    if (attempts.length >= 10) return { started: false, status: 'upstream_error', code: 'RATE_LIMITED', retryable: true, error: 'Chat start limit reached. Try later.' };
    attempts.push(now);

    let scan = { complete: false };
    try {
      scan = await findExisting(accountID, phoneNumber);
      if (scan.chat) return ok(scan.chat, 'existing', phoneNumber);
    } catch { /* The lookup is an optimization; start is itself idempotent. */ }

    let last;
    for (let attempt = 0; attempt <= reconcileDelays.length; attempt++) {
      try {
        const result = await backend('/v1/chats/start', {}, { accountID, user: { phoneNumber }, allowInvite: false });
        const chatID = result.id || result.chatID;
        if (typeof chatID !== 'string' || !CHAT_ID.test(chatID) || (result.accountID && result.accountID !== accountID)) throw new Error('Invalid response');
        // "created" only when a complete scan proved there was no chat beforehand; otherwise Beeper
        // does not tell us whether it reused or created the chat.
        return ok(result, scan.complete && attempt === 0 ? 'created' : 'resolved', phoneNumber, attempt ? { reconciledAfterError: last?.status ?? true } : {});
      } catch (error) {
        last = error;
        if (error?.reason === 'RECIPIENT_NOT_ON_WHATSAPP') return { started: false, status: 'not_on_whatsapp', code: 'RECIPIENT_NOT_ON_WHATSAPP', retryable: false, error: 'Beeper reports that this number is not on WhatsApp. Verify the number and country code.', ...(error.requestId ? { requestId: error.requestId } : {}) };
        if (error?.status === 401 || error?.status === 403) return { started: false, status: 'unauthorized', code: error.category, retryable: false, error: 'Beeper refused the request (authentication or permission).', requestId: error.requestId };
        if (error?.status === 400 || error?.status === 422) return { started: false, status: error.reason === 'INVALID_NUMBER' ? 'invalid_number' : 'upstream_error', code: error.reason === 'INVALID_NUMBER' ? 'INVALID_NUMBER' : error.category, retryable: false, error: error.reason === 'INVALID_NUMBER' ? 'Beeper rejected the phone number format.' : 'Beeper rejected the chat request as invalid.', requestId: error.requestId };
        if (error?.status === 429) return { started: false, status: 'upstream_error', code: error.category, retryable: true, error: 'Beeper rate limited the request. Try later.', requestId: error.requestId };
        if (attempt < reconcileDelays.length) {
          // 404 "User not found", 5xx or timeout: the bridge may have succeeded. Wait, look the chat up, ask again.
          await pause(reconcileDelays[attempt]);
          try { const found = await findExisting(accountID, phoneNumber); if (found.chat) return ok(found.chat, 'resolved', phoneNumber, { reconciledAfterError: error.status ?? error.category ?? true }); } catch { /* keep going */ }
        }
      }
    }
    const requestId = last?.requestId;
    // The server answered but never confirmed: report what is known, do not invent a diagnosis.
    return { started: null, status: last?.status === 404 || last?.status >= 500 ? 'upstream_error' : 'unknown_outcome', code: last?.category || 'OUTCOME_UNKNOWN', retryable: true, ...(last?.status ? { upstreamStatus: last.status } : {}), error: 'Beeper did not confirm the chat after bounded reconciliation. Check Beeper before retrying; no message was sent.', ...(requestId ? { requestId } : {}) };
  }
}
