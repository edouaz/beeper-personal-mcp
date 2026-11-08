# Opt-in event forwarding

The optional worker connects to Beeper Server's authenticated `/v1/ws` and subscribes with `subscriptions.set`. It POSTs raw `message.upserted` events to one configured consumer. An upsert can represent an update or an outgoing message, not necessarily a new incoming message. It never sends a reply. Beeper's event format is passed through unmodified.

To configure, create `state/events.env` with mode 0600 (do not commit it):

```text
BEEPER_WEBHOOK_URL=https://consumer.example/events
BEEPER_WEBHOOK_SECRET=<at least 32 random bytes>
BEEPER_EVENT_CHAT_IDS=<optional comma-separated exact chat IDs>
BEEPER_EVENT_ACCOUNT_IDS=<optional comma-separated exact account IDs>
```

Copy `ops/beeper-events.service` to the user's systemd unit directory, run `systemctl --user daemon-reload`, then `systemctl --user enable --now beeper-events.service`. The existing MCP and OAuth configuration are separate. No listener is exposed. The URL must use HTTPS, except loopback HTTP for a local consumer. No redirects are followed. Account filtering looks up each event's chat through the Beeper API and drops events whose chat has no matching account ID. Chat subscriptions default to all chats.

The consumer must verify `X-Beeper-Signature: sha256=<hex>` as HMAC-SHA256 over the exact request bytes using the shared secret, comparing in constant time, before processing. Respond with 2xx only after accepting an event. `X-Beeper-Event-Id` is the SHA-256 of those bytes; use it to make processing idempotent. Keep the URL and secret private; payloads may contain private data.

The worker retries failures up to five attempts, reconnects with bounded backoff, deduplicates identical payloads for ten minutes in memory, and caps its queue at 128 events. Queue overflow and exhausted retries are logged without payloads. Its queue and deduplication cache are not durable, and the API does not document replay. Beeper also documents that an upsert can be skipped when its message cannot be hydrated: events can be lost while disconnected, on restart, or under sustained failures. Reconcile from message history if complete coverage matters. Deliveries can be duplicated, including after restart. A permanently failing delivery delays later queued events. Inspect the user service journal for generic failure and connection messages.
