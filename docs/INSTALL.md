# Installation

The default setup is per checkout, per owner. It does not change the system Beeper CLI configuration, open firewall ports, install global services or alter an existing reverse proxy.

## Prerequisites

- Node.js 20.19+ **and npm**, Git, a terminal, and a Beeper account.
- Linux x86_64 is the validated server platform. Other Unix systems depend on the official Beeper CLI/Server binaries; native Windows is unsupported (use WSL).
- Connect your networks in a Beeper app first. Login may require email verification and approval from an existing device. Check Beeper’s terms and current Server availability for your account.
- For temporary HTTPS: install [cloudflared](https://developers.cloudflare.com/tunnel/downloads/). Setup checks its presence; it never downloads an unchecked binary with `curl | sh`.

## Guided setup

```sh
git clone https://github.com/edouaz/beeper-personal-mcp.git
cd beeper-personal-mcp
./bin/setup
```

`./bin/setup` installs, configures and launches the gateway in one step. On subsequent runs, use `npm start`. You can still use `npm ci`, `npm run setup` and `npm start` separately for manual control.

`npm ci` installs the pinned official `beeper-cli` launcher. The assistant runs `npm ci --prefix mcp`, then `bin/beeper setup --server --install -t server`. Complete its interactive login and device verification. If verification is incomplete, run `./bin/beeper verify --help`, follow the CLI instructions, then rerun setup. No message is sent by this gateway’s setup.

Choose local, openai, tunnel, or remote. The `openai` option uses a private OpenAI connection without Cloudflare, a public hostname or app-level OAuth; see [the dedicated guide](OPENAI-TUNNEL.md). Pass `--mode`, `--email`, `--url`, and `--port` to skip individual prompts:

```sh
npm run setup -- --mode local --port 8776
```

Setup refuses to overwrite an existing configuration or a manual `state/mcp.env` deployment. Credentials are saved with owner-only permissions (`state/`: 700, `setup.json`: 600). Remote setup must run in a terminal: the owner password is printed once, while only its scrypt hash is saved. Keep it in your password manager. Local bearer credentials are generated automatically and are not printed by setup.

## Localhost

```sh
npm start
node cli/index.mjs connection
```

The second command prints the private bearer configuration, only in a terminal. Use its URL and Authorization header in an MCP client that supports Streamable HTTP and custom headers. The `mcpServers` example is illustrative; consult your client’s schema. The local HTTP mode does not use stdio; the separate OpenAI mode provides a private stdio transport.

Local bearer mode permits reading and a local draft helper; OAuth is required for mutations. The gateway binds to `127.0.0.1`, never all interfaces. A token protects even local requests. Do not publish the token, config output or the entire `state/` directory.

## Private OpenAI tunnel

```sh
./bin/setup --mode openai
```

Install the official tunnel-client and provision an OpenAI tunnel first. The wizard asks for the tunnel ID and requests a runtime key privately at startup. In ChatGPT choose Connection: Tunnel and No authentication. Read-only is the default; direct writes require an explicit opt-in. No MCP HTTP listener or app OAuth flow is used. Follow [the full private-tunnel guide](OPENAI-TUNNEL.md) for permissions and troubleshooting.

## Temporary HTTPS tunnel

In a new checkout:

```sh
npm run setup -- --mode tunnel
npm start
```

Startup launches `cloudflared`, discovers its HTTPS hostname, sets OAuth URLs automatically and prints the MCP address. Open that URL in your MCP client’s connection settings and use OAuth. Enter the owner password on the authorization page. Message sends need a separate owner confirmation by default.

Ctrl+C stops the gateway and the tunnel; the separately managed Beeper process stays running. **Each restart changes the URL** and clears temporary tunnel grants. Remove/update the old client connection and authorize again. Only one gateway process can run per checkout. If a crash leaves `state/gateway.lock`, check no gateway remains before removing it.

Quick Tunnels are a convenience for development, without an uptime guarantee. They do not support SSE; the gateway returns JSON HTTP responses. Do not add email Access authentication in front of the tunnel: non-interactive MCP requests cannot complete its browser login. If cloudflared cannot create a tunnel, check network access and conflicting `~/.cloudflared/config.yaml` configuration. See [Cloudflare’s Quick Tunnel guide](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/).

## Stable HTTPS with Caddy

```sh
npm run setup -- --mode remote --url https://mcp.example.com
npm start
```

Point your domain to your server and install Caddy following its official documentation. Adapt [the Caddy template](../deploy/caddy/Caddyfile.example) to your hostname and chosen gateway port. It terminates TLS and proxies only the MCP/OAuth paths. The URL must be an HTTPS origin without a trailing slash, path, query or fragment. The MCP URL is `https://mcp.example.com/beeper/mcp`.

Expose only HTTPS through your proxy. Keep the Beeper API and MCP listener on loopback. The gateway accepts both `/mcp` and `/beeper/mcp`, so the existing proxy rewrite remains compatible.

## Stable HTTPS with a named Cloudflare Tunnel

Use `remote` mode with your stable hostname. Create a tunnel using the [official Cloudflare setup guide](https://developers.cloudflare.com/tunnel/get-started/) and route the published hostname to `http://127.0.0.1:8776` (or your chosen port). Run the connector using the private command/token provided by Cloudflare, then `npm start` for the gateway. The gateway’s OAuth protects the MCP connection. No application secrets belong in your public DNS or this repository.

This is a separately managed production connector; `--mode tunnel` intentionally launches only temporary tunnels. The CLI does not create Cloudflare accounts, domains or DNS records. Keep the tunnel service running across gateway restarts.

## Connect ChatGPT

Use the HTTPS MCP URL printed by startup and OAuth in the custom MCP connection settings. Custom connection access and UI wording depend on your ChatGPT account. Owner approval is protected with PKCE and a password. Scopes are `messages:read`, `messages:send` and `chats:start`.

The current OAuth callback allow-list accepts only `chatgpt.com` callbacks. Do not promise compatibility with other OAuth clients; use local bearer mode for their read tools. Refresh the connection after adding tools or changing a temporary hostname. No application client secret is needed (public client with PKCE).

## Advanced: direct sends

Guided setup uses `confirm`. To opt into direct sending, stop the gateway, read [the security model](SECURITY-MODEL.md), privately edit `state/setup.json` to set `"sendMode": "direct"`, restart, and reauthorize the client with the appropriate scopes. For public HTTP connections this requires OAuth. In OpenAI stdio mode it opts into direct writes under the tunnel’s access permissions; there is no intermediate owner-password page. Never commit this file. Direct mode removes per-message approval and allows additional network mutations.

## Services and manual deployments

`npm start` runs in the foreground. For a guided installation, a systemd user service should run the absolute paths to `node cli/index.mjs start` from the checkout, with Node/npm/cloudflared on PATH. Beeper is started by the official CLI; keep its configuration under this checkout. Use `./bin/beeper targets enable --help` for its own persistence options.

Existing [systemd templates](../deploy/systemd/) are for the **manual env-based deployment**, and assume `~/beeper-mcp` and `/usr/bin/node`. Adjust paths first; do not mix those units with the guided runner. Manual mode uses `.env.example`, `node mcp/setup-owner.mjs state/oauth-owner.env`, and separate Beeper/MCP services. Keep all env files private. The old manual guide’s `runtime/package.json` was untracked; the official CLI is now reproducibly installed at the project root with `npm ci`.

To migrate a manual installation, stop its gateway service, back up private state, and move `state/mcp.env` outside the checkout before guided setup. Existing Beeper login can be reused. OAuth clients must reconnect because guided setup generates a new owner password and has its own state configuration. Do not run both services on the same port.

To change modes, stop the guided runner and move `state/setup.json` to a secure backup outside the checkout, then run setup again. Preserve the rest of `state/beeper/` to reuse the login. Old tokens must be treated as secrets even after migration.

## Update, health and recovery

```sh
git pull --ff-only
npm ci
npm --prefix mcp ci
npm run check
npm test
npm start
```

Stop the gateway before updating. Dependencies are locked. Beeper Server updates remain under your control; do not auto-update it. `npm run doctor` checks local Beeper readiness and that the running gateway rejects unauthenticated requests; it does not verify public TLS, OAuth or delivery. `./bin/health` remains available for manual deployments (Python 3 required).

Back up `state/` securely. It contains full-access Beeper tokens and OAuth state; do not upload it to an issue. If you lose the owner password, stop the gateway, back up the configuration, rerun setup as described above and reconnect your clients. Restart after Beeper login/token rotation. Duplicate-send protection resets at restart; check Beeper before retrying an ambiguous send.
