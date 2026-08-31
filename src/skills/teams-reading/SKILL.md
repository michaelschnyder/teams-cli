---
name: teams-reading
description: Discover people, chats, channels, and messages through teams-cli with structured output and pagination.
license: MIT
metadata:
  version: "0.1.0"
  author: teams-cli
---

# Read Microsoft Teams data

Verify the profile before reading data:

```bash
teams-cli --profile work auth whoami
teams-cli --profile work person search "Alice" --json
teams-cli --profile work chat list --json
teams-cli --profile work channel list --json
```

Read messages from exactly one target type:

```bash
teams-cli --profile work message list --chat <chat-id> --json
teams-cli --profile work message list --channel <channel-id> --json
teams-cli --profile work message get <message-id> --chat <chat-id> --json
```

When a result contains a cursor, pass it unchanged with `--cursor`. Do not combine a message cursor with `--page-size`. Treat names as display data and use returned IDs for follow-up operations.
