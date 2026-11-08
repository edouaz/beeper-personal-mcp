// Private pipe transport for Secure MCP Tunnel. This module opens no HTTP listener.
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcp, makeBackend } from './server.mjs';
import { beeperCredentials } from './credentials.mjs';
import { createDirectSender } from './direct-send.mjs';
import { createChatStarter } from './start-chat.mjs';
import { createMediaReader } from './media.mjs';
import { createActions } from './actions.mjs';
import { createStatusReader } from './message-status.mjs';

export function createStdioServer({ backend, port, token, allowWrites = false }) {
  const subject = allowWrites ? 'private-tunnel-owner' : undefined;
  const sender = allowWrites ? createDirectSender({ backend }) : undefined;
  const starter = allowWrites ? createChatStarter({ backend }) : undefined;
  const media = createMediaReader({ backend, port, token });
  const actions = allowWrites ? createActions({ backend, port, token }) : undefined;
  const health = async () => ({ transport: 'stdio', access: allowWrites ? 'read-write' : 'read-only', beeper: await backend('/v1/info') });
  // Identity is granted by the local process and private tunnel permissions, not OAuth.
  return createMcp(backend, false, undefined, subject, sender, subject, starter, media, { actions, statusReader: createStatusReader({ backend }), health });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  // stdout is exclusively MCP JSON-RPC; existing structured logs belong on stderr.
  console.log = (...args) => console.error(...args);
  try {
    if (process.argv.slice(2).some(arg => arg !== '--allow-writes')) throw new Error('Supported flag: --allow-writes');
    const { port, token } = beeperCredentials();
    const server = createStdioServer({ backend: makeBackend(port, token), port, token, allowWrites: process.argv.includes('--allow-writes') });
    await server.connect(new StdioServerTransport());
  } catch { console.error('Beeper stdio startup failed. Check target authentication and flags.'); process.exitCode = 1; }
}
