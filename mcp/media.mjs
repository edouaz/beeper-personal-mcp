export const MAX_BYTES = 3_000_000;
const types = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf']);

export function validSignature(bytes, mime) {
  if (mime === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mime === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  if (mime === 'image/gif') return ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'));
  if (mime === 'image/webp') return bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  return bytes.subarray(0, 5).toString('ascii') === '%PDF-';
}

export function createMediaReader({ backend, port, token, fetchImpl = fetch }) {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || typeof token !== 'string' || !token) throw new Error('Invalid media configuration');
  const validID = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && value !== '.' && value !== '..' && !/[\/\\]/.test(value);
  const select = async ({ chatID, messageID, attachmentIndex }) => {
    if (!validID(chatID) || !validID(messageID) || !Number.isInteger(attachmentIndex) || attachmentIndex < 0) throw new Error('Invalid attachment selection');
    const message = await backend(`/v1/chats/${encodeURIComponent(chatID)}/messages/${encodeURIComponent(messageID)}`);
    if (message.chatID !== chatID || message.id !== messageID || !Array.isArray(message.attachments)) throw new Error('Message or attachment not found');
    const attachment = message.attachments[attachmentIndex];
    if (!attachment) throw new Error('Message or attachment not found');
    const mediaURL = [attachment.id, attachment.srcURL].find(value => typeof value === 'string' && /^(?:mxc|localmxc):\/\/[^\s/?#]+\/[^\s?#]+$/.test(value));
    return { attachment, mediaURL };
  };
  const read = async args => {
    const { attachment, mediaURL } = await select(args);
    if (!types.has(attachment.mimeType)) throw new Error('Unsupported attachment type (JPEG, PNG, GIF, WebP and PDF only)');
    if (attachment.fileSize !== undefined && (!Number.isSafeInteger(attachment.fileSize) || attachment.fileSize < 0 || attachment.fileSize > MAX_BYTES)) throw new Error('Attachment too large');
    if (!mediaURL) throw new Error('Unsupported attachment URL: media is unavailable or expired');
    const url = new URL('/v1/assets/serve', `http://127.0.0.1:${port}`);
    url.searchParams.set('url', mediaURL);
    const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (response.status === 404 || response.status === 410) throw new Error('Attachment unavailable: media is expired or no longer stored');
    if (!response.ok || !response.body) throw new Error('Attachment download failed');
    const length = response.headers.get('content-length');
    if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) { await response.body.cancel(); throw new Error('Attachment too large'); }
    const reader = response.body.getReader();
    const chunks = []; let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) { await reader.cancel(); throw new Error('Attachment too large'); }
      chunks.push(value);
    }
    const bytes = Buffer.concat(chunks);
    if (!validSignature(bytes, attachment.mimeType)) throw new Error('Attachment type mismatch');
    const data = bytes.toString('base64');
    return attachment.mimeType === 'application/pdf'
      ? { type: 'resource', resource: { uri: 'urn:beeper:attachment', mimeType: attachment.mimeType, blob: data } }
      : { type: 'image', mimeType: attachment.mimeType, data };
  };
  // Metadata only: no download, no media bytes in memory.
  read.info = async args => {
    const { attachment, mediaURL } = await select(args);
    return {
      type: attachment.type, mimeType: attachment.mimeType, fileName: attachment.fileName, fileSize: attachment.fileSize, width: attachment.size?.width, height: attachment.size?.height, duration: attachment.duration,
      downloadable: Boolean(mediaURL) && types.has(attachment.mimeType) && (attachment.fileSize === undefined || attachment.fileSize <= MAX_BYTES),
      reason: !mediaURL ? 'media URL unavailable or expired' : !types.has(attachment.mimeType) ? 'unsupported type for inline download' : attachment.fileSize > MAX_BYTES ? `larger than ${MAX_BYTES} bytes` : undefined,
    };
  };
  return read;
}
