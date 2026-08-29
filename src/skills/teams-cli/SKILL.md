---
name: teams-cli
description: Use teams-cli safely for Microsoft Teams authentication, discovery, reading, messaging, profiles, and policies.
license: MIT
metadata:
  version: "0.1.0"
  author: teams-cli
---

# Teams CLI

Use `teams-cli` when a task requires command-line access to Microsoft Teams. The CLI uses an authenticated local Edge or Chrome profile and undocumented Microsoft APIs, so confirm organizational approval before use.

## Discover commands

```bash
teams-cli --help
teams-cli auth --help
teams-cli person --help
teams-cli chat --help
teams-cli channel --help
teams-cli message --help
teams-cli policy --help
```

Use `--profile <name>` to select a configured tenant and user. Prefer `--json` for machine-readable person, chat, channel, and message results. Keep stdout available for payloads; warnings and diagnostics use stderr.

## Safe workflow

1. Verify the selected identity with `teams-cli --profile <name> auth whoami`.
2. Discover people, chats, or channels before using identifiers.
3. Read the applicable policy with `teams-cli policy show`.
4. Check a write target with `teams-cli policy check send` before sending.
5. Never copy bearer tokens into prompts, logs, or source files.
