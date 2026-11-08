# Contributing

Thanks for helping make personal messaging integrations easier to run. Open an issue for a reproducible bug or discuss a larger feature before implementing it. Security reports belong in the private channel described in [SECURITY.md](SECURITY.md).

## Work locally

Use Node.js 20.19+ with npm on Linux. No real Beeper login is required for tests.

```sh
npm ci
npm --prefix mcp ci
npm run check
npm test
```

Use a branch for your change, explain the problem and resulting behavior, and include validation in your pull request. Keep changes focused; preserve existing tool names and response fields. Add meaningful regression coverage for changed behavior, especially authorization, setup and delivery state.

## Privacy and behavior

- Tests must use mocks/fake servers and never send a real message. Live checks under `mcp/e2e/` require `BEEPER_E2E=1`; sending also requires `BEEPER_E2E_SEND=1` and an agreed recipient.
- Never commit `state/`, env files, tokens, real phone numbers, chat IDs, message content or private logs. Use `example.com` and synthetic fixtures.
- Do not broaden OAuth redirect hosts, scopes or network mutations without explaining the authorization model and threat implications.
- Never automatically retry sends with unknown outcomes or claim delivery without network evidence.
- Setup must preserve existing credentials, bind to loopback and work from a clean checkout. Keep documentation in sync with CLI behavior.

## Pull requests

Describe what changed, why it matters, the checks you ran and any known limitation. CI runs the mock suite on Node 20/22/24, syntax checks, dependency audits and a tracked-private-file check. Contributions are distributed under the repository’s [MIT license](LICENSE). Be respectful and keep discussions concrete and constructive.
