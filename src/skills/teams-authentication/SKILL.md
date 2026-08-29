---
name: teams-authentication
description: Authenticate teams-cli, select profiles, validate identity, and handle stored credentials safely.
license: MIT
metadata:
  version: "0.1.0"
  author: teams-cli
---

# Teams CLI authentication

Interactive login is the normal path:

```bash
teams-cli --profile work --tenant <tenant-id> auth login
teams-cli --profile work auth whoami
```

The successful login stores identity-scoped tokens and an isolated browser profile under `~/.teams-cli/`. Profiles are configuration defaults, not security boundaries.

Useful commands:

```bash
teams-cli profile list
teams-cli profile show work
teams-cli --profile work auth refresh
teams-cli --profile work auth logout
```

Do not request, display, or export raw tokens unless the user explicitly asks and the applicable policy permits it. Never weaken MFA, conditional access, or tenant security controls. Automated login must use an explicit absolute `--password-command`; passwords are not stored by the CLI.
