---
name: teams-messaging-policies
description: Send Teams messages with teams-cli only after verifying identity, target, and applicable workspace policies.
license: MIT
metadata:
  version: "0.1.0"
  author: teams-cli
---

# Teams messaging and policies

Sending is externally visible and must be intentional. Before a send:

1. Run `teams-cli auth whoami` for the selected profile.
2. Resolve the chat or channel from a fresh list operation.
3. Run `teams-cli policy show` and `teams-cli policy check send --chat <id>` or `--channel <id>`.
4. Confirm the body and target with the user when either is ambiguous.

Send plain text with exactly one target:

```bash
teams-cli --profile work message send --chat <chat-id> --body "Hello"
printf '%s' "Hello" | teams-cli --profile work message send --channel <channel-id>
```

Never bypass a policy denial by calling Microsoft APIs directly or exporting a token. Inactive policies warn but do not enforce; active matching policies intersect. A malformed policy store fails closed for authenticated operations.
