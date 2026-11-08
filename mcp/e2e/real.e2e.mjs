// Opt-in end-to-end checks against a REAL Beeper Server. Not part of `npm test`.
//
//   BEEPER_E2E=1 BEEPER_TARGET_FILE=... BEEPER_E2E_ACCOUNT=whatsapp.123 BEEPER_E2E_PHONE=+32... npm run e2e
//
// By default this only reads and opens a chat (no message is sent). Sending needs a second, explicit opt-in
// and a recipient who agreed to receive test messages:  BEEPER_E2E_SEND=1 BEEPER_E2E_TEXT="..."
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeBackend } from '../server.mjs';
import { createChatStarter } from '../start-chat.mjs';
import { createDirectSender } from '../direct-send.mjs';

const enabled = process.env.BEEPER_E2E === '1';
const skip = enabled ? false : 'set BEEPER_E2E=1 to run real-account checks';
const need = name => { const v = process.env[name]; if (!v) throw new Error(`${name} is required`); return v; };
const setup = () => {
  const target = JSON.parse(readFileSync(need('BEEPER_TARGET_FILE'), 'utf8'));
  const port = Number(new URL(target.baseURL).port || 80);
  return makeBackend(port, target.auth.accessToken);
};

test('real: health and accounts are reachable', { skip }, async () => {
  const backend = setup();
  assert.equal((await backend('/v1/info')).server.status, 'running');
  assert.ok((await backend('/v1/accounts')).some(a => a.status === 'connected'));
});

test('real: start_whatsapp_chat returns a usable chat and sends nothing', { skip }, async () => {
  const backend = setup();
  const start = createChatStarter({ backend });
  const result = await start({ accountID: need('BEEPER_E2E_ACCOUNT'), phoneNumber: need('BEEPER_E2E_PHONE') }, 'e2e');
  assert.equal(result.started, true, JSON.stringify(result));
  assert.match(result.chatID, /^!.+:.+$/);
  const chat = await backend(`/v1/chats/${encodeURIComponent(result.chatID)}`);
  assert.equal(chat.isReadOnly, false);
});

test('real: send one message and follow its state (needs BEEPER_E2E_SEND=1)', { skip: enabled && process.env.BEEPER_E2E_SEND === '1' ? false : 'set BEEPER_E2E=1 and BEEPER_E2E_SEND=1' }, async () => {
  const backend = setup();
  const started = await createChatStarter({ backend })({ accountID: need('BEEPER_E2E_ACCOUNT'), phoneNumber: need('BEEPER_E2E_PHONE') }, 'e2e');
  assert.equal(started.started, true);
  const result = await createDirectSender({ backend, log: () => {} })({ chatID: started.chatID, text: need('BEEPER_E2E_TEXT'), waitSeconds: 15 }, 'e2e');
  assert.equal(result.accepted, true, JSON.stringify(result));
  assert.ok(['sent', 'delivered', 'read'].includes(result.state), `state: ${result.state}`);
});
