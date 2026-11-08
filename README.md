<p align="center"><img src="docs/assets/banner.svg" alt="Beeper Personal MCP — Your conversations, connected" width="100%"></p>

<p align="center">
<a href="LICENSE">MIT license</a> · <a href="docs/INSTALL.md">Installation</a> · <a href="docs/CAPABILITIES.md">Capabilities</a> · <a href="CONTRIBUTING.md">Contributing</a>
</p>

A personal, self-hosted [Model Context Protocol](https://modelcontextprotocol.io/) gateway for [Beeper](https://developers.beeper.com/). Connect an assistant to the conversations already in your Beeper account: search, catch up, read attachments, and send messages with your approval.

**Independent community project. Not affiliated with Beeper or Apple.** Pre-release; one owner per installation. Your instance stays private even though this code is public.

## Start here

You need **Node.js 20.19+ with npm**, Git, and a Beeper account. Linux x86_64 is the validated deployment platform. The gateway is portable Node.js; the CLI and Beeper Server depend on their own OS support. Native Windows is not supported by the shell wrapper; use Linux/WSL.

```sh
git clone https://github.com/edouaz/beeper-personal-mcp.git
cd beeper-personal-mcp
npm ci
npm run setup
npm start
```

The setup assistant installs the gateway dependencies and runs the official Beeper CLI to install, sign in and verify your Beeper Server. It creates private credentials under `state/`. No manual `.env` editing is needed for a new installation. Your email/device verification still requires your participation.

Choose your connection:

| Mode | Best for | What you need |
| --- | --- | --- |
| `local` (default) | A local MCP client using HTTP and a bearer token; read tools | Nothing public; binds to `127.0.0.1` |
| `tunnel` | Trying ChatGPT over HTTPS with OAuth and approved sends | [cloudflared](https://developers.cloudflare.com/tunnel/downloads/); temporary hostname |
| `remote` | An always-on instance with a stable HTTPS address | Your own domain + Caddy or a named Cloudflare Tunnel |

```sh
npm run setup -- --mode tunnel                         # temporary HTTPS; install cloudflared first
npm run setup -- --mode remote --url https://mcp.example.com
npm run doctor                                        # local readiness checks
node cli/index.mjs connection                          # PRIVATE local client config, shown in terminal
./bin/beeper status                                   # official Beeper CLI, isolated project state
```

Run **one** setup variant in a fresh checkout. For remote and tunnel modes, save the owner password shown once by setup. Start with `npm start`, then use the printed HTTPS MCP URL with OAuth in ChatGPT. Availability of custom MCP connections depends on your client/account. See the [complete installation guide](docs/INSTALL.md), including client settings, stable tunnels, services, updates and migration.

Temporary tunnels change address on every start and are for development. This gateway uses JSON HTTP responses rather than SSE, which Quick Tunnels do not support. A remote ChatGPT connection cannot reach your computer’s localhost.

## What it does

- Search accounts, chats, contacts and messages; get unread conversations and resumable exports.
- Read bounded image/PDF attachments without giving the assistant arbitrary filesystem access.
- Use OAuth with PKCE, scoped access and owner approval for remote connections.
- Prepare a message for approval on a protected page before a single send attempt. Advanced direct-send mode is opt-in.
- Report `pending`, `sent`, `delivered`, `read` or `failed` from available evidence. An accepted send is not a delivery receipt.
- Support reactions, drafts, chat state, edit/delete and WhatsApp find-or-open where the connected network supports them; availability depends on the authorization mode.

See [capabilities and test coverage](docs/CAPABILITIES.md). Local bearer mode exposes read tools and a local draft helper; sending and other mutations require OAuth. No bulk messaging, auto-replies or automatic send retries.

## How it fits together

```text
Local client ── bearer token ──┐
                              ├─ MCP gateway (127.0.0.1) ── Beeper Server ── your networks
ChatGPT ── HTTPS + OAuth ──────┘
           Caddy or tunnel
```

The public code never includes your Beeper credentials, conversations, OAuth state or server binary. All runtime state belongs to you in `state/`. The optional [event forwarder](mcp/EVENTS.md) and [plugin integration generator](plugin-integration/README.md) are included but not enabled by setup.

## Development

```sh
npm ci
npm --prefix mcp ci
npm run check
npm test
```

Tests use mocks and a fake Beeper server. They do not access your account or send real messages. Live checks are separately gated; see [CONTRIBUTING.md](CONTRIBUTING.md). CI checks syntax, tests, dependency audits and accidental private files on Node 20, 22 and 24.

## Privacy, limits and license

Read the [security model](docs/SECURITY-MODEL.md) and [security policy](SECURITY.md). Keep `state/` private and back it up securely. OAuth callbacks currently support **ChatGPT only**. Other local clients can use the bearer mode; the HTTP configuration format depends on the client. Consent pages are currently in French. Duplicate/rate protections are in memory and reset at restart. One owner per instance; this is not a multi-user SaaS.

[MIT](LICENSE) applies to this repository. Beeper Server is proprietary software downloaded from Beeper by its official CLI; it is not redistributed here. Beeper, Apple and network names belong to their respective owners. The visual identity uses original artwork; see [brand notes](docs/BRAND.md).

[Troubleshooting](docs/TROUBLESHOOTING.md) · [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md)
