# Security policy

Please report suspected vulnerabilities privately (GitHub "Report a vulnerability" on the repository, or the maintainer's contact once published), not in a public issue. Include the version, a description and a minimal reproduction **without real tokens or message content**. We aim to acknowledge reports within a week.

This project handles private conversations. In scope: authentication and OAuth, authorization of write tools, input validation, log redaction, duplicate-send protection. Out of scope: vulnerabilities in Beeper Server itself (report to Beeper) and misconfigurations that expose ports 8776 or 23374 directly.

See [docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md) for the design and its known limits.
