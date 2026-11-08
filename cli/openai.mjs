import { join } from 'node:path';
import { emitKeypressEvents } from 'node:readline';

const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
export function openaiArgs(root, config, node = process.execPath) {
  // The official client parses this command; no shell or key interpolation is used.
  const command = [quote(node), quote(join(root, 'mcp/stdio.mjs')), ...(config.sendMode === 'direct' ? ['--allow-writes'] : [])].join(' ');
  return ['run', '--control-plane.tunnel-id', config.tunnelId, '--control-plane.api-key', 'env:CONTROL_PLANE_API_KEY', '--mcp.command', command, '--mcp.stdio-failure-policy', 'exit', '--health.listen-addr', '127.0.0.1:0'];
}
export async function runtimeKey() {
  const existing = process.env.CONTROL_PLANE_API_KEY || process.env.OPENAI_API_KEY;
  if (existing) return existing;
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Set CONTROL_PLANE_API_KEY in the environment, or start in a terminal for hidden entry.');
  process.stdout.write('OpenAI tunnel runtime key (hidden; used only for this session): ');
  const wasRaw = process.stdin.isRaw;
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const cleanup = () => {
      process.stdin.off('keypress', handler);
      process.stdin.setRawMode(Boolean(wasRaw));
      process.stdin.pause();
      process.stdout.write('\n');
    };
    const handler = (text, key = {}) => {
      if (key.ctrl && ['c', 'd'].includes(key.name)) { cleanup(); reject(new Error('Key entry cancelled.')); }
      else if (key.name === 'return') { cleanup(); value.trim() ? resolve(value.trim()) : reject(new Error('A runtime key is required.')); }
      else if (key.name === 'backspace') value = value.slice(0, -1);
      else if (!key.ctrl && !key.meta && text && !/[\r\n\x00-\x1f\x7f]/.test(text) && value.length < 4096) value += text;
    };
    process.stdin.on('keypress', handler);
  });
}
