# Teams CLI

A minimal TypeScript CLI that signs in through Microsoft Edge or Google Chrome,
persists a Microsoft Teams session, and validates it from later command-line runs.

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
selecting all produces an object keyed by `access` and `skype`.

Refresh both tokens, or refresh either token independently:

```bash
teams-cli auth refresh
teams-cli auth refresh all
teams-cli auth refresh access
teams-cli auth refresh skype
```

`access` performs a non-interactive OAuth refresh with the saved browser profile.
`skype` exchanges the current access token without opening a browser and fails if the
access token has expired. `all` refreshes the access token first and then derives a
new Skype token. The command reports each refreshed token's audience and absolute and
remaining expiry both before and after the refresh.

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
│   └── session.json
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
