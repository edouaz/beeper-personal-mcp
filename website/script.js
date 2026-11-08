const guideBase = 'https://github.com/edouaz/beeper-personal-mcp/blob/main/docs/';
const modes = {
  openai: { tag: 'PRIVATE OPENAI CONNECTION', title: 'Local server. Private connection.', description: 'Use OpenAI’s Secure MCP Tunnel to reach your local Beeper gateway without a public hostname or an app-level OAuth login.', prereq: 'First install the official tunnel-client and create a tunnel in OpenAI Platform. You need a runtime key and permission to use that tunnel.', command: './bin/setup --mode openai', after: 'The assistant installs dependencies, signs you in to Beeper, and launches the tunnel. Enter your tunnel ID when asked; the runtime key is hidden and stays in memory. Then select Tunnel in ChatGPT and choose No authentication.', guide: 'OPENAI-TUNNEL.md' },
  local: { tag: 'JUST YOUR MACHINE', title: 'A local connection, by default.', description: 'Connect a local MCP client over HTTP. Nothing is exposed publicly, and a generated bearer token protects your gateway.', prereq: 'You need a local MCP client that supports Streamable HTTP and an Authorization header. This mode exposes read tools; ChatGPT in the cloud cannot reach localhost directly.', command: './bin/setup --mode local', after: 'The assistant installs dependencies, completes Beeper login, and starts the gateway. In another terminal, run node cli/index.mjs connection to display your private client configuration. Never share its bearer token.', guide: 'INSTALL.md#localhost' },
  tunnel: { tag: 'TEMPORARY PUBLIC HTTPS', title: 'Try it without buying a domain.', description: 'A Cloudflare Quick Tunnel gives your local gateway a temporary public HTTPS address. OAuth protects access to your account.', prereq: 'Install cloudflared first. No Cloudflare account or domain is needed for a Quick Tunnel. The hostname changes at each restart, so reconnect your client after restarting.', command: './bin/setup --mode tunnel', after: 'Save the owner password shown once. Connect ChatGPT to the printed HTTPS MCP URL with OAuth. Each message requires separate owner approval by default. This option is for testing, not a permanent service.', guide: 'INSTALL.md#temporary-https-tunnel' },
  remote: { tag: 'YOUR STABLE HTTPS ENDPOINT', title: 'A home for an always-on bridge.', description: 'Use your own domain with Caddy, a named tunnel, or another HTTPS reverse proxy. The gateway keeps listening on loopback.', prereq: 'You need a stable hostname and a configured HTTPS reverse proxy. Replace mcp.example.com with your own origin. Cloudflare is optional; Caddy can handle HTTPS directly.', command: './bin/setup --mode remote --url https://mcp.example.com', after: 'Save the generated owner password. Proxy the MCP and OAuth paths to the local gateway, then connect ChatGPT using the printed MCP URL and OAuth. See the full installation guide for proxy and service examples.', guide: 'INSTALL.md#stable-https-with-caddy' }
};
for (const button of document.querySelectorAll('[data-mode]')) button.addEventListener('click', () => {
  const mode = modes[button.dataset.mode];
  for (const other of document.querySelectorAll('[data-mode]')) other.setAttribute('aria-pressed', String(other === button));
  for (const field of ['tag', 'title', 'description', 'prereq', 'after']) document.getElementById(`mode-${field}`).textContent = mode[field];
  document.getElementById('setup-code').textContent = `git clone https://github.com/edouaz/beeper-personal-mcp.git\ncd beeper-personal-mcp\n${mode.command}`;
  document.getElementById('mode-guide').href = guideBase + mode.guide;
});
for (const button of document.querySelectorAll('[data-copy]')) button.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(document.getElementById(button.dataset.copy).textContent);
    button.textContent = 'Copied ✓';
    document.getElementById('copy-status').textContent = 'Setup commands copied.';
    setTimeout(() => { button.textContent = 'Copy commands'; }, 2000);
  } catch {
    button.textContent = 'Select text to copy';
    document.getElementById('copy-status').textContent = 'Clipboard unavailable. Select the commands and copy them manually.';
  }
});
