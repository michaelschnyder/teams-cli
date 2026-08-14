# Teams CLI

A minimal TypeScript CLI that signs in through Microsoft Edge or Google Chrome,
persists a Microsoft Teams session, and reads the user's chats and messages.

This uses undocumented Teams behavior and Microsoft's first-party client identity.
It is unsupported, may be blocked by tenant policy, and may stop working without
notice. Obtain approval from your organization before using it.

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

Sign in with Edge, the default browser:

```bash
teams-cli auth login
```

Use Chrome or target a specific tenant:

```bash
teams-cli auth login --browser chrome
teams-cli auth login --tenant YOUR_TENANT_ID
```

Validate the saved session and inspect its identity, token audiences, expiry dates,
and remaining lifetimes:

```bash
teams-cli auth whoami
```

Show all saved token values, or select one token for shell piping:

```bash
teams-cli auth tokens
teams-cli auth token access
teams-cli auth token skype
teams-cli auth token chat
teams-cli auth token search
```

Treat raw bearer tokens like passwords. They may be captured by terminal scrollback,
logs, or automation output.

Decode only the JWT claims, omitting the encoded header and signature:

```bash
teams-cli auth tokens --decode
teams-cli auth token access --decode
teams-cli auth token skype --decode
```

Decoded output is JSON. Selecting one token produces its claims object directly;
selecting all produces an object keyed by `access`, `skype`, `chat`, and `search`.

Refresh all tokens, or refresh one token independently:

```bash
teams-cli auth refresh
teams-cli auth refresh all
teams-cli auth refresh access
teams-cli auth refresh skype
teams-cli auth refresh chat
teams-cli auth refresh search
```

`access`, `chat`, and `search` perform a non-interactive OAuth refresh with the saved
browser profile. `skype` exchanges the current access token without opening a browser
and fails if the access token has expired. `all` reacquires every OAuth resource and
then derives a new Skype token. The command reports each refreshed token's audience
and absolute and remaining expiry both before and after the refresh. Version-1
sessions are outdated; run `teams-cli auth refresh all` once to replace them with the
current session format.

## Chats and messages

List the server-provided chat collection. Each result contains its participants:

```bash
teams-cli chats list
teams-cli chats list --json
teams-cli chats list --cursor OPAQUE_CURSOR
```

The cookie-free chat-list endpoint may return the tenant's complete collection and
ignore size or ordering parameters. The CLI preserves that server response instead
of locally limiting, paging, or sorting it. A cursor is emitted only when the service
provides a real continuation.

Find chats by chat name or participant through Teams GoTo search:

```bash
teams-cli chats find "Ada Lovelace"
teams-cli chats find "Incident response" --json
```

GoTo search requests up to 25 People and Chat suggestions from the server. Existing
one-to-one conversations are shown first as direct chats, followed by group-chat
matches. The matching participant is included even when Teams returns only a sampled
group roster. The service may return fewer results and provides no continuation. The
CLI does not reproduce Teams' client-side sidebar filter.

Human-readable chat listing and search output use a table. `--json` retains the full
stable envelope for automation.

List messages in a chat and follow the returned cursor for older messages:

```bash
teams-cli chats messages CHAT_ID
teams-cli chats messages CHAT_ID --page-size 50 --json
teams-cli chats messages CHAT_ID --cursor OPAQUE_CURSOR
```

Retrieve one message directly:

```bash
teams-cli chats message CHAT_ID MESSAGE_ID
teams-cli chats message CHAT_ID MESSAGE_ID --json
```

Paging and search are never implemented locally. The production service does not
honor its old advertised message sort and range parameters, so the CLI does not expose
them. A cursor cannot be combined with `--page-size`. Message content is returned as
supplied by Teams and can contain HTML.

Log out locally:

```bash
teams-cli auth logout
```

Logout removes the saved CLI session and all dedicated Teams CLI browser profiles.
It does not revoke tokens remotely at Microsoft.

## Storage layout

The CLI keeps authentication artifacts separate from future configuration and
guardrail profiles:

```text
~/.teams-cli/
├── auth/
│   └── session.json  # version 2: access, Skype, chat, and search tokens
└── browser-profiles/
    ├── chrome/
    └── edge/
```

Only the selected browser directory is created during login. The root and browser
profiles use owner-only permissions, and the session file is written with mode
`0600`. The storage code accepts an explicit root internally so a later profile
system can place locked state in a workspace-controlled directory without changing
the authentication model.

## Session refresh

`auth whoami` validates the stored access token through the Teams authentication
service. If it has expired or is rejected, the CLI attempts one non-interactive
refresh using the same dedicated browser profile. If Microsoft requires account
selection, MFA, or another interaction, run `teams-cli auth login` again.

## Documentation

- [Research log](docs/research.md)
- [ADR 0001](docs/adr/0001-browser-backed-private-teams-api.md)
- [ADR 0002](docs/adr/0002-server-backed-chat-and-message-reads.md)
