# Private OpenAI tunnel

Run Beeper on your machine and connect ChatGPT without Cloudflare, a public hostname, a certificate or an app-level OAuth login. This mode uses the official OpenAI Secure MCP Tunnel and a local stdio server. It opens no MCP HTTP listener.

The tunnel is authenticated: OpenAI Platform permissions and a runtime API key control access. “No authentication” in the ChatGPT app settings means **no extra app-level authentication**, not an anonymous internet endpoint.

## Before setup

1. Download and install the official [tunnel-client](https://github.com/openai/tunnel-client/releases/latest) for your machine. Put the executable on PATH. Do not confuse it with `cloudflared`; this mode does not use the Cloudflare Quick Tunnel option.
2. In [OpenAI Platform tunnel settings](https://platform.openai.com/settings/organization/tunnels), create or reuse a tunnel and note its `tunnel_id`. Associate the target ChatGPT workspace and the appropriate Platform organization. Creating/managing requires Tunnels Read + Manage; using it requires Read + Use. Your ChatGPT workspace must also permit custom MCP connections.
3. Create a restricted runtime API key with tunnel access. Use a runtime key, not an organization admin key. Keep it out of chat, shell history and config files. The CLI accepts hidden terminal entry when starting, or the `CONTROL_PLANE_API_KEY` environment variable supplied by your secret manager.

These account steps and installing the supported tunnel client are prerequisites; the project cannot grant account permissions or create an organization for you. See [OpenAI’s current tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) for availability and permissions.

## Install and launch

From a fresh clone, with Node.js 20.19+ and npm:

```sh
./bin/setup --mode openai
```

The command installs locked dependencies, asks for the tunnel ID, completes the official Beeper login/verification and starts the client. The gateway’s default is **read-only**. The runtime key is requested with hidden input at startup and is kept only in that process’s environment. It is never stored in `state/setup.json` or passed as a command argument.

For a later start, use `npm start`. If a secret manager supplies `CONTROL_PLANE_API_KEY` (or the official client’s fallback, `OPENAI_API_KEY`), no key prompt is needed. The tunnel ID is an identifier, not a credential; it can be passed via `--tunnel-id` during setup.

The runner invokes the official client in the foreground with a private command equivalent to:

```text
tunnel-client run --control-plane.tunnel-id <your-tunnel-id> --mcp.command '<node> <checkout>/mcp/stdio.mjs' --mcp.stdio-failure-policy exit --health.listen-addr 127.0.0.1:0
```

Paths are quoted by the CLI; use `./bin/setup` rather than copying placeholders above. MCP frames use stdin/stdout; structured gateway logs go to stderr. The only HTTP listener added by tunnel-client is its own loopback admin/health UI on an ephemeral port, shown by that client. The Beeper API remains on loopback.

## Connect ChatGPT

While `npm start` is running:

1. Add a custom MCP server in ChatGPT.
2. Choose **Connection: Tunnel** and select the same tunnel (or enter its ID).
3. Choose **No authentication** for this stdio server. There is no OAuth issuer or owner-password page in this mode.
4. Test discovery, then ask for `beeper_health` or another read-only operation. Do not send a message as a connectivity test.

If the tunnel is missing from the list, verify the workspace association and Read + Use permissions. A healthy local process is not proof of a working ChatGPT connection; check tunnel-client’s `/ui` for readiness/polling and complete an actual read-only call from ChatGPT.

## Optional writes

At setup, explicitly answer yes to direct writes, or use:

```sh
./bin/setup --mode openai --allow-writes
```

For an existing guided OpenAI setup, stop the runner and privately change `sendMode` in `state/setup.json` from `confirm` to `direct`, then restart and refresh the client’s tool list. In OpenAI mode `confirm` means read-only: there is no browser confirmation page.

Direct writes enable sends, reactions, drafts/chat state and WhatsApp chat creation. They do not require a second OAuth flow or per-message password. Keep ChatGPT’s tool-action confirmations enabled and send only when explicitly requested. Anyone with usable access to this tunnel can invoke the enabled tools. Rate limits and duplicate guards still apply; ambiguous sends are never retried automatically.

## What this option is for

This is a **private connection**, including personal development/testing where the account supports it. It is not a way to distribute a private tunnel as a public ChatGPT plugin. Public distribution requires a stable public HTTPS MCP endpoint and applicable review/authentication requirements. The repository and GitHub Pages site contain only source, docs and brand assets; they do not host your Beeper service.

## Lifecycle and troubleshooting

- Ctrl+C stops the foreground tunnel client. It supervises its stdio child. The separately managed Beeper Server stays running.
- Run only one active tunnel-client per tunnel ID for this stdio deployment.
- `npm run doctor` checks Beeper and the installed tunnel-client version. It does **not** claim that OpenAI polling, tunnel permissions or ChatGPT discovery succeeded.
- Missing executable: install the supported official release and confirm `tunnel-client --version` works.
- Missing runtime key: start in a terminal for hidden entry or provide the environment variable through your secret manager.
- No ready state: inspect the tunnel client’s local UI and confirm outbound HTTPS to OpenAI, permissions and workspace association. Do not paste raw secret-bearing logs into public issues.
- Revocation: stop the client, revoke its runtime key/tunnel access in OpenAI Platform, and reconnect only after rotating credentials. No app OAuth grants exist in this mode.

Integration tests exercise the stdio server and its authorization boundary with a fake Beeper server. The command options were checked against official tunnel-client v0.0.20. End-to-end OpenAI readiness requires the user’s tunnel permissions, key and ChatGPT connection; it is not exercised by CI.
