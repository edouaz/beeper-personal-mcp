# Troubleshooting

| Symptom | Meaning and action |
|---|---|
| `start_whatsapp_chat` returns `status: "resolved"` with `reconciledAfterError: 404` | Expected for brand-new chats. Beeper's `/v1/chats/start` can answer 404 "User not found" after the WhatsApp bridge already created the room (it is not indexed locally yet). The tool looked the chat up and confirmed it. See below. |
| `status: "not_on_whatsapp"` | Beeper's bridge replied (HTTP 500 with the message "... is not on WhatsApp"). The tool trusts that exact message, never the bare 500. Check country code and number. |
| `status: "unknown_outcome"` or `upstream_error` after retries | Beeper never confirmed the chat. No message was sent. Look in Beeper, then try again later. |
| `state: "sent"`, never `delivered` | WhatsApp only reports delivery receipts when the network provides them; `sent` means Beeper handed the message to the network. Not an error. |
| `state: "pending"` with `waitTimedOut` | Still queued (offline bridge?). Use `get_message_status` later; do not resend. |
| `accepted: null` / `unknown_outcome` on send | The request may have gone through. Check the chat; identical text is blocked for 10 minutes. |
| `duplicate_blocked` | Same text to the same chat within 10 minutes (or already in flight). |
| 401 from `/mcp` | Missing/expired OAuth token: reconnect the connector. |
| Tools missing in ChatGPT | Refresh the connector; write tools also need the `messages:send` grant. |
| `Could not load Beeper Server target authentication` | Run `./bin/beeper setup -t server`, then restart the MCP. |
| `beeper_health` shows `lastIncident` | The last upstream error (category, normalized route, status), in memory only. Expected 404s while polling a pending message are not counted. |

Logs: `journalctl --user -u beeper-mcp.service -f`. Find an error by its `request_id`. Beeper Server's own logs are under `state/beeper/profiles/server/server/logs/` (desktop-api, sdk); they are private and can contain phone numbers.

## About the 404 on chat start

Observed in Beeper Desktop API 4.3.271: the SDK logs `create_dm` HTTP 201 with the room ID, the thread is "not found in database, creating an in-memory representation", and the API returns 404. A second call returns the chat normally (the endpoint is documented to reuse an existing direct chat). Starting a chat sends nothing, so repeating it is safe; message sends are never repeated.

`status` semantics: `created` only if a full chat-list scan found no chat before the call; `existing` if the scan found one (no start call); `resolved` if the chat is usable but Beeper does not say whether it was new (for example the scan was incomplete or the call needed reconciliation). A 404 followed by success is the typical signature of a new chat but is not proof.

## Why a number that is not on WhatsApp comes back as HTTP 500

Observed in the SDK logs (Beeper 4.3.271): for a number WhatsApp does not know, the Beeper-hosted WhatsApp bridge answers `create_dm` with **404**, and Beeper's local API surfaces it as **HTTP 500** `CREATE_CHAT_FAILED` with the message `createDM failed: the server said <number> is not on WhatsApp`. Two different layers, two different 404s: the bridge 404 above means "unknown number", while the local API's `404 User not found` on `/v1/chats/start` is the indexing race described earlier.

The gateway returns `not_on_whatsapp` only when that exact message names the exact number requested. A bare 500, another wording or another number is reported as `upstream_error` (retryable, nothing sent) and never as a diagnosis. It cannot rule out that Beeper changes the wording; in that case you get `upstream_error`, which is the safe side.

## Error format

Every non-success result of `start_whatsapp_chat`, sends and chat actions carries:

| Field | Meaning |
|---|---|
| `status` (start) / `state` (sends) | Stable outcome: `not_on_whatsapp`, `invalid_number`, `unauthorized`, `unsupported`, `upstream_error`, `unknown_outcome`; sends: `rejected`, `duplicate_blocked`, `rate_limited`, `unknown_outcome`, `failed` |
| `code` | Stable machine code (`RECIPIENT_NOT_ON_WHATSAPP`, `OUTCOME_UNKNOWN`, `UNAVAILABLE`, ...) |
| `retryable` | `true` only when repeating the same call is safe and may help. Never `true` for a send whose outcome is unknown (`checkBeforeRetry: true` instead) |
| `requestId` | Matches the `request_id` in the MCP logs, when Beeper was contacted |
| `error` | Short human explanation without private data |

Repeating `start_whatsapp_chat` is always safe (idempotent, sends nothing). Repeating a send never is, unless Beeper reported `failed` with `retryable: true`.

## "Resolved" is not "delivered"

`start_whatsapp_chat` only finds or opens the conversation: a usable `chatID` and nothing else. No message exists, so nothing can be delivered, and the result carries no delivery field. After a send, `state` goes `pending` → `sent` (handed to the network) → `delivered` (the network listed recipients) → `read`. `sent` is not `delivered`, and a resolved chat says nothing about whether the recipient will receive or see anything.

## Reading `beeper_health`

`status` is `ok`, `degraded` (an account is disconnected, or an infrastructure incident happened in the last 10 minutes) or `down` (Beeper unreachable). `lastIncident` holds infrastructure problems only: 5xx without a recognised business reason, timeouts, 401/403, 429. `lastRejection` holds business outcomes and client errors, such as a number not on WhatsApp; it is informational and never degrades `status`. Both live in memory and reset on restart.
