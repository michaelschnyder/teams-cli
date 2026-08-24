# Teams CLI

A minimal TypeScript CLI that signs in through Microsoft Edge or Google Chrome, persists a Microsoft Teams session, reads chats, channels, and messages, and can send plain-text messages to explicitly allowlisted conversations.

This uses undocumented Teams behavior and Microsoft's first-party client identity. It is unsupported, may be blocked by tenant policy, and may stop working without notice. Obtain approval from your organization before using it.

## Install and build

Requirements: Node.js 22+ and either Microsoft Edge or Google Chrome.

```bash
npm install
npm run check
npm test
npm run build
npm link
```

## Authentication

```bash
teams-cli auth login
teams-cli auth login --browser chrome
teams-cli auth login --tenant YOUR_TENANT_ID
teams-cli auth whoami
teams-cli auth refresh
teams-cli auth refresh access
teams-cli auth refresh skype
teams-cli auth refresh chat
teams-cli auth refresh search
teams-cli auth logout
```

Inspect all stored tokens, one raw token, or decoded JWT claims:

```bash
teams-cli auth tokens
teams-cli auth token access
teams-cli auth tokens --decode
```

Treat raw bearer tokens like passwords. They may be captured by terminal scrollback, logs, or automation output. Logout removes local tokens and dedicated browser profiles; it does not revoke tokens remotely.

## Chats and channels

```bash
teams-cli chat list
teams-cli chat list --cursor OPAQUE_CURSOR --json
teams-cli chat get CHAT_ID

teams-cli channel list
teams-cli channel list --json
teams-cli channel get CHANNEL_ID
```

Channel output includes its team for context, but a channel ID is the complete target. Team IDs are not command targets and are not needed for message operations.

## Messages

```bash
teams-cli message list --chat CHAT_ID
teams-cli message list --channel CHANNEL_ID --page-size 50 --json
teams-cli message list --chat CHAT_ID --cursor OPAQUE_CURSOR

teams-cli message get MESSAGE_ID --chat CHAT_ID
teams-cli message get MESSAGE_ID --channel CHANNEL_ID --json

teams-cli message send --chat CHAT_ID --body "Hello"
printf 'Hello\n' | teams-cli message send --channel CHANNEL_ID
```

Exactly one of `--chat` and `--channel` is required. `--cursor` cannot be combined with `--page-size`. Message paging is server-provided, and its opaque cursor is bound to the tenant and conversation. Sending supports plain text only.

## Send guardrails

Sending is denied unless the destination ID appears under the matching type in `~/.teams-cli/guardrails.json`. The complete configuration is:

```json
{
  "chats": [
    "19:0d652623-9316-4f99-a760-2a130b04f886_34aee546-c8f9-45e4-a5b0-933ef9b9d31e@unq.gbl.spaces"
  ],
  "channels": [
    "19:XZ0ukan5N_29nFzpIfyA7NCP3nFRsQQF-rZBdxe7sfw1@thread.tacv2"
  ]
}
```

The check is exact and case-sensitive. A missing, unreadable, malformed, or non-matching file denies the send before any POST. There is no bypass flag.

## Status and debugging

Interactive human-readable commands show an updating status line on stderr while requests and token refreshes run. Status is suppressed for `--json` and when stderr is not a TTY.

Use the global `--debug` option for sanitized request lifecycle information:

```bash
teams-cli --debug channel list
teams-cli --debug message list --chat CHAT_ID --json
```

Debug output goes to stderr and includes the method, sanitized URL, attempt, status, and duration. It excludes headers, tokens, cookies, query values, conversation and message IDs, request and response bodies, and browser background traffic.

## Automatic refresh and retries

Data operations refresh every required token when it expires within 60 seconds. Read requests rejected with `401` or `403` refresh authentication and retry once. A send rejected with a definite `401` or `403` rechecks guardrails and retries once. Sends are never retried after a timeout, connection loss, invalid response, or `5xx`. If silent refresh requires account selection, MFA, or another interaction, run `teams-cli auth login` again.

## Storage

```text
~/.teams-cli/
├── guardrails.json
├── auth/
│   └── session.json
└── browser-profiles/
    ├── chrome/
    └── edge/
```

Session writes are atomic. Storage files and directories use owner-only permissions where supported.

## Testing safety

Automated API tests use mock responses. The initial send implementation is not invoked by automated tests. Any manual write verification must target a loopback mock server; never test sending against live Teams. Explicit live smoke checks are read-only.

## Documentation

- [Research log](docs/research.md)
- [ADR 0001](docs/adr/0001-browser-backed-private-teams-api.md)
- [ADR 0002](docs/adr/0002-server-backed-chat-and-message-reads.md)
- [ADR 0003](docs/adr/0003-use-oso-cli-command-conventions.md)
