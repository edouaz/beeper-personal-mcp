// Maps Beeper's sendStatus / receipts to explicit states. Never reports "delivered" unless the network said so.
export function summarizeMessage(message, fallback = {}) {
  const send = message?.sendStatus;
  const delivered = Array.isArray(send?.deliveredToUsers) && send.deliveredToUsers.length > 0;
  const seen = message?.seen;
  const read = seen === true || typeof seen === 'string' || (seen !== null && typeof seen === 'object');
  let state = 'unknown';
  if (send?.status === 'PENDING') state = 'pending';
  else if (send?.status === 'FAIL_RETRIABLE' || send?.status === 'FAIL_PERMANENT') state = 'failed';
  else if (send?.status === 'SUCCESS') state = read ? 'read' : delivered ? 'delivered' : 'sent';
  else if (message && !send && message.isSender) state = 'sent';
  return {
    state,
    delivered: state === 'delivered' || state === 'read',
    read: state === 'read',
    ...(message?.id ? { messageID: message.id } : {}),
    ...(send?.status ? { sendStatus: send.status } : {}),
    ...(state === 'failed' ? { retriable: send.status === 'FAIL_RETRIABLE', retryable: send.status === 'FAIL_RETRIABLE', ...(typeof send.reason === 'string' ? { failureReason: send.reason.slice(0, 100) } : {}) } : {}),
    ...fallback,
  };
}

export function createStatusReader({ backend, pause = ms => new Promise(resolve => setTimeout(resolve, ms)), clock = Date.now }) {
  const lookup = async (chatID, messageID) => {
    // Accepts a final message ID, a pendingMessageID, or a Matrix event ID.
    const message = await backend(`/v1/chats/${encodeURIComponent(chatID)}/messages/${encodeURIComponent(messageID)}`, {}, undefined, { tolerate: [404] });
    return summarizeMessage(message);
  };
  return {
    lookup,
    // Bounded wait. Errors while polling never imply failure: report the last known state.
    async wait(chatID, messageID, seconds) {
      const deadline = clock() + Math.min(Math.max(seconds, 0), 30) * 1000;
      let last = { state: 'pending', delivered: false, read: false };
      for (let delay = 400; ; delay = Math.min(delay * 1.5, 2000)) {
        try { last = await lookup(chatID, messageID); if (last.state !== 'pending' && last.state !== 'unknown') return last; } catch { /* pending id may not resolve yet */ }
        if (clock() + delay >= deadline) return { ...last, waitTimedOut: true };
        await pause(delay);
      }
    },
  };
}
