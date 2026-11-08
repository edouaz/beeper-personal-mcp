# Security model

This is a single-owner gateway: OAuth identifies the client, not separate humans. Whoever holds the owner password and a valid grant can read all your chats and, depending on the mode, send messages.

## Layers

1. **Network**: the MCP binds to `127.0.0.1` only. A reverse proxy or tunnel adds TLS; the Caddy example also adds a 64 KB body cap. The gateway enforces its own body limit. Guided local mode requires a random bearer token and exposes read tools. Browser `Origin` headers, batch JSON-RPC and non-POST requests are rejected; global limit 120 requests/minute.
2. **Authentication**: OAuth 2.1 authorization-code + PKCE, dynamic client registration restricted to ChatGPT callbacks, scrypt-hashed owner password, rotating refresh tokens. Grants made before a scope existed never gain it through refresh.
3. **Authorization (scopes)**: `messages:read` for all reads; `messages:send` for every write that affects chats; `chats:start` separately for `start_whatsapp_chat`. Read tools carry `readOnlyHint`; write tools are annotated as destructive and open-world so clients can ask the user to confirm.
4. **Send policy**
   - `BEEPER_SEND_MODE=confirm` (default): `prepare_message` returns an owner-only confirmation URL; the owner re-enters the password and approves the exact text; `send_message` then attempts once.
   - `direct`: `send_message_direct`, `reply_to_message`, `send_file`, reactions, edit and delete act immediately when the model calls them. Prompt injection from message content could try to cause sends; keep your client's per-action confirmation enabled, and prefer `confirm` if you read untrusted chats.
5. **Abuse limits** (in memory, reset on restart): 5 direct sends/minute, identical message to the same chat blocked 10 minutes, 30 other write actions/minute, 10 chat starts/minute. Sends are never retried automatically; an unknown outcome is reported as such.
6. **Input handling**: strict IDs (no path characters), E.164 normalization that never guesses a country, files only from a MIME allow-list with signature checks, 10 MB cap, sanitized names, no local-filesystem access, only `mxc://` / `localmxc://` media URLs from the exact message.
7. **Logs**: JSON lines with tool name, normalized route, HTTP status, duration and category. No tokens, message text, chat IDs, phone numbers or query strings. Verified by tests.

## Known limits

- The Beeper API token in `state/beeper/targets/server.json` is all-powerful and the service runs as your user; systemd sandboxing limits writes but is not isolation from your other processes. A dedicated Unix user is better.
- Duplicate protection is process-local. Rate limits are global, not per client.
- Edit, delete, reaction and file tools share the `messages:send` scope; there is no finer permission.
- The consent page is currently in French.
- WhatsApp may restrict accounts that contact many unknown numbers. This project limits its own rate but does not bypass any WhatsApp protection and offers no bulk messaging.

## If something leaks

Stop the gateway. Delete `state/oauth.json` and `state/oauth-tunnel.json` to revoke OAuth grants. For guided setup, move `state/setup.json` to a secure private backup and rerun setup to rotate the owner password or local bearer token, then reconnect clients. For manual deployments, rotate the owner password with `setup-owner.mjs`. If the Beeper token may be exposed, revoke the affected device in Beeper and sign in again. Report vulnerabilities as described in `SECURITY.md`.

## Private OpenAI stdio boundary

The optional `openai` CLI mode runs `mcp/stdio.mjs` as a private child of the official tunnel-client. It exposes no MCP HTTP listener and no anonymous/public HTTP option was added. OpenAI tunnel permissions and a runtime key provide transport access; no app-level OAuth metadata is advertised. Read-only is the default. The explicit `--allow-writes` setup option grants a single local owner subject to the enabled direct-send/actions tools. In this mode there is no per-message owner-password page; keep client action confirmations enabled. Never share tunnel access beyond the intended owner. See [OpenAI tunnel setup](OPENAI-TUNNEL.md).
