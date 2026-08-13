# Teams Edge authentication proof of concept

This TypeScript tool launches Microsoft Edge with a dedicated persistent profile,
runs the first-party Teams OAuth login, captures the initial Skype-resource access
token from the callback **in memory**, and performs the Teams `authsvc` exchange in
TypeScript. It prints token metadata and discovered service endpoints, never token
values.

This uses undocumented Teams behavior and Microsoft's first-party client identity.
It is unsupported, may be blocked by tenant policy, and may stop working without
notice. Obtain approval from your organization before using it.

## Run

Requirements: Node.js 22+ and Microsoft Edge.

```bash
npm install
npm run check
npm test
npm run dev -- auth
```

List chats and teams:

```bash
npm run dev -- list
npm run dev -- list --json
npm run dev -- list --limit 20
npm run dev -- list --all
```

The default view shows the 50 most recent non-hidden chats plus all Teams and their
channels. Unknown member identifiers are not printed. `--all` includes hidden chats
and removes the chat limit.

For a specific tenant:

```bash
npm run dev -- auth --tenant YOUR_TENANT_ID
```

By default, Edge login state is preserved in `.state/edge-profile` so later CLI runs
can reuse the authenticated session. The directory is excluded from Git and must be
protected like any other signed-in browser profile. Use `--profile PATH` to select a
different location or `--ephemeral` for a one-off context that is deleted on exit.
With a persistent profile, the CLI first attempts silent authentication and only
shows account selection or MFA when Microsoft reports that interaction is required.

## Current boundary

The `auth` command captures only the initial Skype-resource token. The `list` command
also requests the ChatSvcAgg resource token in the same Edge session because the
conversation-discovery endpoint enforces that distinct token audience. Both tokens
remain in memory and disappear when the process exits.

## Documentation

- [Research log](docs/research.md) records the tools, projects, and documentation
  consulted during the investigation, including which options depend on Graph.
- [ADR 0001](docs/adr/0001-browser-backed-private-teams-api.md) documents the
  constraints, options matrix, and decision to use a browser-backed private API.
