# Private Beeper conversations plugin

> **Experimental draft.** The generator checks an older fixed tool list and has not been re-validated for 2.0; treat it as a starting point only.

The draft supports read/search, local drafts, and owner-confirmed text sends. The planned endpoint is https://mcp.example.com/beeper/mcp. The existing service is active locally; public HTTPS and live ChatGPT OAuth must still be verified before claiming end-to-end success.

The generator requires a live OAuth token entered privately in its hidden terminal prompt. It checks TLS, initializes MCP, and verifies the exact eleven-tool set and permissions without fetching chats. It never includes credentials in the package. Run from the project root after HTTPS and OAuth connection are working:

```bash
python3 plugin-integration/generate.py --endpoint https://mcp.example.com/beeper/mcp --output /tmp/private-beeper-conversations.zip
```

Do not extract tokens from ChatGPT or paste them in chat. If no supported token flow is available, authenticated discovery stays pending. Source-based packaging can use the same validated draft and OAuth MCP declaration, but must clearly report live discovery as unverified until the actual ChatGPT connection succeeds.

OAuth uses dynamic client registration with PKCE and messages:read plus messages:send. The owner approves the initial OAuth grant in their browser, then approves each exact outgoing message separately at the returned protected confirmation link. The server requires the owner password and enforces expiration and one-use tokens. See the root README for details. Do not send a real message as a connectivity test without explicit consent.

The checked-in Agent Plugins 1.0 JSON schemas are used to validate manifests and are excluded from plugin archives. No secret, state, dependency, or unrelated file belongs in a plugin archive.

## App icons

Reusable MIT-licensed app/composer icons and a current portable manifest fragment are available from the [public brand kit](https://edouaz.github.io/beeper-personal-mcp/#brand). See [brand documentation](../docs/BRAND.md) for dimensions, packaging paths and format validation. The experimental generator above does not automatically merge these assets.
