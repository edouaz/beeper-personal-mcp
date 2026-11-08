# Changelog

## Unreleased

- Add a private OpenAI Secure MCP Tunnel mode with stdio, no app OAuth, read-only defaults and explicit direct-write opt-in.
- Add `bin/setup` to install, configure and launch from one command after cloning.
- Publish a responsive GitHub Pages website with connection-mode guides and a validated SVG/PNG brand kit.

## 2.1.0

- Add a guided CLI with isolated private state, local bearer mode, temporary HTTPS tunnels and stable remote setup.
- Lock the official Beeper CLI dependency so a fresh checkout is installable.
- Add setup diagnostics, credential protection and process cleanup.
- Accept the public MCP path without requiring proxy rewrites.
- Add MIT licensing, original visual identity, styled approval pages and public installation/contribution guides.


## 2.0.0 (unreleased)

- Standard error format (`status`/`state`, `code`, `retryable`, `requestId`) for chat start, sends and actions.
- `beeper_health` now reports an overall `status` and separates infrastructure incidents (`lastIncident`) from business rejections (`lastRejection`), so "not on WhatsApp" no longer looks like a server failure.
- Documented why unregistered numbers appear as HTTP 500 and that a resolved chat is not a delivered message.

- `start_whatsapp_chat`: idempotent find-or-open. Reconciles the Beeper 4.3.271 race where `/v1/chats/start` answers 404 after the bridge created the chat; explicit statuses (`created`, `existing`, `resolved`, `not_on_whatsapp`, `invalid_number`, `unauthorized`, `unsupported`, `upstream_error`, `unknown_outcome`); E.164 normalization; single-flight for concurrent calls; 10 starts/minute.
- Sends report `pending | sent | delivered | read | failed` with a bounded wait (`waitSeconds`); new `get_message_status`. Never retried automatically.
- New tools: `send_file`, `react_to_message`, `remove_reaction`, `edit_message`, `delete_message`, `mark_chat_read`, `mark_chat_unread`, `save_chat_draft`, `clear_chat_draft`, `set_chat_state`, `get_attachment_info`, `beeper_health`.
- Inline attachment download limit raised from 1 MB to 3 MB.
- Structured logs (`beeper_upstream`, `tool_call`) without private data.
- Repository prepared for publication: generic deploy templates, `.env.example`, docs, CI, opt-in E2E tests.
