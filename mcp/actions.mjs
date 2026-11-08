import { createHash } from 'node:crypto';
import { validSignature } from './media.mjs';

const CHAT_ID = /^![^\s/\\]+:[^\s/\\]+$/;
const REF = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && value !== '.' && value !== '..' && !/[\/\\\s]/.test(value);
// Allowlist only. No HTML, SVG, scripts, archives or executables.
export const SEND_TYPES = new Map([
  ['image/jpeg', 'image'], ['image/png', 'image'], ['image/gif', 'image'], ['image/webp', 'image'], ['application/pdf', 'file'],
  ['text/plain', 'file'], ['text/csv', 'file'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'file'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'file'],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'file'],
]);
export const MAX_SEND_BYTES = 10_000_000;
export const MAX_BASE64_CHARS = 58_000; // fits the 64 KiB MCP request cap

export function safeFileName(name) {
  const base = String(name ?? '').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').replace(/^\.+/, '').trim().slice(0, 100);
  if (!base) throw new Error('Invalid file name');
  return base;
}

const fail = (code, message, extra = {}) => ({ ok: false, code, retryable: false, error: message, ...extra });

export function createActions({ backend, port, token, fetchImpl = fetch, clock = Date.now, log = () => {} }) {
  const stamps = [];
  const limited = () => { const now = clock(); while (stamps.length && stamps[0] <= now - 60000) stamps.shift(); if (stamps.length >= 30) return true; stamps.push(now); return false; };
  const chat = value => { if (typeof value !== 'string' || !CHAT_ID.test(value)) throw new Error('Invalid chat ID'); return encodeURIComponent(value); };
  const ref = value => { if (!REF(value)) throw new Error('Invalid ID'); return encodeURIComponent(value); };
  // Action failures with a definitive HTTP rejection are reported as such; anything else stays "unknown".
  const run = async fn => {
    if (limited()) return fail('RATE_LIMITED', 'Action limit reached. Try later.', { retryable: true });
    try { return await fn(); } catch (error) {
      if (error?.category) return { ok: error.status && error.status < 500 && error.status !== 408 ? false : null, code: error.category, retryable: false, ...(error.status ? { upstreamStatus: error.status } : {}), error: error.status === 404 ? 'Beeper could not find the target.' : error.status && error.status < 500 ? 'Beeper rejected the request.' : 'Beeper did not confirm the action; check Beeper before retrying.', ...(error.requestId ? { requestId: error.requestId } : {}) };
      throw error;
    }
  };
  const summary = c => ({ chatID: c.id, unreadCount: c.unreadCount, isMarkedUnread: c.isMarkedUnread, isArchived: c.isArchived, isPinned: c.isPinned, isMuted: c.isMuted, isLowPriority: c.isLowPriority, draft: c.draft ? { text: c.draft.text, attachments: Object.keys(c.draft.attachments || {}).length } : null });

  async function upload({ contentBase64, fromAttachment, fileName, mimeType }) {
    let bytes, name = fileName, mime = mimeType;
    if (fromAttachment) {
      const message = await backend(`/v1/chats/${chat(fromAttachment.chatID)}/messages/${ref(fromAttachment.messageID)}`);
      const attachment = message.attachments?.[fromAttachment.attachmentIndex];
      if (!attachment) return fail('ATTACHMENT_NOT_FOUND', 'Message or attachment not found.');
      mime = mime || attachment.mimeType; name = name || attachment.fileName || 'attachment';
      if (attachment.fileSize !== undefined && attachment.fileSize > MAX_SEND_BYTES) return fail('FILE_TOO_LARGE', 'File exceeds the size limit.');
      const mediaURL = [attachment.id, attachment.srcURL].find(value => typeof value === 'string' && /^(?:mxc|localmxc):\/\/[^\s/?#]+\/[^\s?#]+$/.test(value));
      if (!mediaURL) return fail('MEDIA_UNAVAILABLE', 'Attachment is expired or unavailable.');
      const url = new URL('/v1/assets/serve', `http://127.0.0.1:${port}`); url.searchParams.set('url', mediaURL);
      const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(30000) });
      if (!response.ok || !response.body) return fail('MEDIA_UNAVAILABLE', 'Attachment is expired or unavailable.');
      const chunks = []; let size = 0; const reader = response.body.getReader();
      for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > MAX_SEND_BYTES) { await reader.cancel(); return fail('FILE_TOO_LARGE', 'File exceeds the size limit.'); } chunks.push(value); }
      bytes = Buffer.concat(chunks);
    } else {
      if (typeof contentBase64 !== 'string' || contentBase64.length > MAX_BASE64_CHARS || !/^[A-Za-z0-9+/]+={0,2}$/.test(contentBase64)) return fail('INVALID_CONTENT', 'Invalid or oversized base64 content (max about 43 KB; use fromAttachment for larger files).');
      bytes = Buffer.from(contentBase64, 'base64');
    }
    if (!SEND_TYPES.has(mime)) return fail('UNSUPPORTED_TYPE', 'File type is not allowed.', { allowed: [...SEND_TYPES.keys()] });
    if (!bytes.length || bytes.length > MAX_SEND_BYTES) return fail('FILE_TOO_LARGE', 'Empty file or file exceeds the size limit.');
    if (/^(image\/|application\/pdf)/.test(mime) && !validSignature(bytes, mime)) return fail('TYPE_MISMATCH', 'File content does not match its declared type.');
    const uploaded = await backend('/v1/assets/upload/base64', {}, { content: bytes.toString('base64'), fileName: safeFileName(name), mimeType: mime }, { timeoutMs: 60000 });
    if (typeof uploaded.uploadID !== 'string' || uploaded.error) return fail('UPLOAD_FAILED', 'Beeper could not store the file.');
    return { ok: true, uploadID: uploaded.uploadID, fileName: uploaded.fileName || safeFileName(name), mimeType: mime, fileSize: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  }

  return {
    upload, summary,
    react: ({ chatID, messageID, reaction }) => run(async () => {
      if (typeof reaction !== 'string' || !reaction || reaction.length > 32) throw new Error('Invalid reaction');
      const result = await backend(`/v1/chats/${chat(chatID)}/messages/${ref(messageID)}/reactions`, {}, { reactionKey: reaction });
      return { ok: result.success === true, chatID, messageID, reaction };
    }),
    unreact: ({ chatID, messageID, reaction }) => run(async () => {
      if (typeof reaction !== 'string' || !reaction || reaction.length > 32) throw new Error('Invalid reaction');
      const result = await backend(`/v1/chats/${chat(chatID)}/messages/${ref(messageID)}/reactions/${encodeURIComponent(reaction)}`, {}, undefined, { method: 'DELETE' });
      return { ok: result.success !== false, chatID, messageID, reaction };
    }),
    markRead: ({ chatID, messageID }) => run(async () => ({ ok: true, ...summary(await backend(`/v1/chats/${chat(chatID)}/read`, {}, messageID ? { messageID } : {})) })),
    markUnread: ({ chatID }) => run(async () => ({ ok: true, ...summary(await backend(`/v1/chats/${chat(chatID)}/unread`, {}, {})) })),
    // Beeper only accepts a non-empty draft over an empty one, so clear first.
    setDraft: ({ chatID, text, attachmentUploadID }) => run(async () => {
      const id = chat(chatID);
      await backend(`/v1/chats/${id}`, {}, { draft: null }, { method: 'PATCH' });
      const draft = { text, ...(attachmentUploadID ? { attachments: { a1: { uploadID: attachmentUploadID } } } : {}) };
      return { ok: true, ...summary(await backend(`/v1/chats/${id}`, {}, { draft }, { method: 'PATCH' })) };
    }),
    clearDraft: ({ chatID }) => run(async () => ({ ok: true, ...summary(await backend(`/v1/chats/${chat(chatID)}`, {}, { draft: null }, { method: 'PATCH' })) })),
    setState: ({ chatID, isArchived, isPinned, isMuted, isLowPriority }) => run(async () => {
      const patch = Object.fromEntries(Object.entries({ isArchived, isPinned, isMuted, isLowPriority }).filter(([, v]) => typeof v === 'boolean'));
      if (!Object.keys(patch).length) throw new Error('No state change requested');
      return { ok: true, ...summary(await backend(`/v1/chats/${chat(chatID)}`, {}, patch, { method: 'PATCH' })) };
    }),
    // Only the user's own messages may be changed.
    editMessage: ({ chatID, messageID, text }) => run(async () => {
      const path = `/v1/chats/${chat(chatID)}/messages/${ref(messageID)}`;
      const own = await backend(path);
      if (own.isSender !== true) return fail('NOT_OWN_MESSAGE', 'Only your own messages can be edited.');
      const result = await backend(path, {}, { text }, { method: 'PUT' });
      return { ok: true, chatID, messageID, ...(result.success === undefined ? {} : { success: result.success }) };
    }),
    deleteMessage: ({ chatID, messageID }) => run(async () => {
      const path = `/v1/chats/${chat(chatID)}/messages/${ref(messageID)}`;
      const own = await backend(path);
      if (own.isSender !== true) return fail('NOT_OWN_MESSAGE', 'Only your own messages can be deleted.');
      await backend(path, {}, undefined, { method: 'DELETE' });
      return { ok: true, chatID, messageID };
    }),
    log,
  };
}
