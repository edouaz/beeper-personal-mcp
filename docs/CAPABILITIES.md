# Capabilities

Legend: **IMPLEMENTED** the code exists; **TESTED** covered by automated tests with mocks (`npm --prefix mcp test`; see CI for current count); **LIVE** additionally observed on a real Beeper Server (Beeper 4.3.271, 2026-11-05/06); **UNTESTED** no automated or live test; **BROKEN** known defect; **UNSUPPORTED** not offered or not possible. "Reported" means observed by the owner, not re-run by the maintainers of this document.

| Tool | Status | Notes |
|---|---|---|
| `list_accounts`, `list_chats`, `search_chats`, `get_chat`, `list_messages`, `search_messages`, `export_messages`, `get_unread_conversations`, `get_recent_conversations` | IMPLEMENTED, TESTED; LIVE (reported; `get_chat`, `list_messages`, `search_chats` re-observed 2026-11-06) | Pages of at most 20 messages on this server. `search_chats` does not match phone numbers; an empty result does not prove a chat is absent. |
| `search_contacts` | IMPLEMENTED, TESTED; LIVE | Per account; results can be ambiguous. |
| `start_whatsapp_chat` | IMPLEMENTED, TESTED (incl. 404 race, 500, timeout, concurrency, disconnected account); LIVE | Idempotent; sends nothing. See TROUBLESHOOTING for status semantics. |
| `send_message_direct` | IMPLEMENTED, TESTED; LIVE (one real message, state `sent`) | Delivery receipts are reported only if the network supplies them. |
| `reply_to_message` | IMPLEMENTED, TESTED | LIVE: UNTESTED. |
| `get_message_status` | IMPLEMENTED, TESTED; LIVE (`sent`) | Accepts final ID, pending ID or Matrix event ID. |
| `prepare_message` / `send_message` (confirm mode) | IMPLEMENTED, TESTED | LIVE: UNTESTED since the 2.0 changes. |
| `send_file` | IMPLEMENTED, TESTED (validation, upload, one POST, duplicates) | LIVE: UNTESTED. Base64 is limited to about 43 KB by the 64 KiB request cap; larger files only by re-sending an attachment of an existing message (10 MB). |
| `download_attachment`, `get_attachment_info` | IMPLEMENTED, TESTED | LIVE: UNTESTED in 2.0. JPEG/PNG/GIF/WebP/PDF up to 3 MB. |
| `react_to_message`, `remove_reaction` | IMPLEMENTED, TESTED (routes) | LIVE: UNTESTED; network support varies. |
| `edit_message`, `delete_message` | IMPLEMENTED, TESTED (own-message guard) | LIVE: UNTESTED; support depends on the network. |
| `mark_chat_read`, `mark_chat_unread`, `save_chat_draft`, `clear_chat_draft`, `set_chat_state` | IMPLEMENTED, TESTED (routes) | LIVE: UNTESTED. Drafts need clear-then-set; implemented that way. |
| `beeper_health` | IMPLEMENTED, TESTED; LIVE (reported) | Sends nothing. |
| `prepare_reply_draft` | IMPLEMENTED, TESTED | Returns text only; use `save_chat_draft` to persist. |
| Event forwarding (`mcp/events.mjs`) | IMPLEMENTED, TESTED | Opt-in service; no replay guarantee. |
| Voice notes, stickers, disappearing messages, typing indicators, group administration | UNSUPPORTED (not exposed) | The Beeper API/CLI offers some of them. |
| Claude or other OAuth clients | UNSUPPORTED | Redirect allow-list is ChatGPT only. |

## Gap analysis against the official `beeper` CLI

Value / feasibility / complexity / risk / compatibility, each low-medium-high.

| Candidate | Value | Feas. | Cplx | Risk | Compat. | Verdict |
|---|---|---|---|---|---|---|
| Voice notes (`send voice`, upload then `voice-note` attachment) | M | H | M | M | WhatsApp, Telegram | Later: needs binary input path |
| Larger uploads (multipart/streaming from a trusted source) | M | M | M | M | all | Later: needs a safe source, not the VPS filesystem |
| Typing indicator (`presence`) | L | H | L | L | varies | Optional |
| Reminders / snooze | M | H | L | L | Beeper | Good next candidate |
| Labels (`/v1/labels`) | L | H | L | L | Beeper | Optional |
| Group chat creation (`POST /v1/chats`) | M | H | M | H (spam) | varies | Only with confirmation |
| Per-action scopes (`messages:delete`, `messages:react`) | M | H | M | L | ours | Recommended hardening |
| Per-client rate limits and persistent duplicate store | M | H | M | L | ours | Recommended |
| Real-time push to the model | H | L | H | M | client-dependent | Needs client support |
| Disappearing-message timers | L | M | L | L | WhatsApp | Optional |
