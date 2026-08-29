# Teams CLI

A TypeScript CLI for browser-backed Microsoft Teams sessions. It supports multiple tenants and users, AWS-style profiles, and optional subject-path policies that can constrain message reads, posts, and raw-token export.

This relies on undocumented Teams behavior and Microsoft first-party client identity. It is unsupported, may be blocked by tenant policy, and may stop working without notice. Obtain organizational approval before using it.

## Quick start

Requirements: Node.js 22+ and Microsoft Edge or Google Chrome.

```bash
npm install
npm run build
npm link

teams-cli --profile personal --tenant YOUR_TENANT_ID auth login
teams-cli --profile personal message send --chat CHAT_ID --body "Hello"
```

The successful login records the verified tenant, user, and browser in the named profile. Subsequent commands reuse its tokens and refresh them from its isolated browser state when necessary.

## Command surface

```text
teams-cli [--profile NAME] [--tenant ID] [--user ID] [--browser edge|chrome]

auth       login, refresh, whoami, tokens, logout
profile    list, show, save, remove
policy     init, list, show, check, activate, edit
person     search, get, image
chat       list, get
channel    list, get
message    list, get, send
```

Profiles provide defaults; global flags override them for one command. When no profile is selected, the profile named `default` is used.

Policies are optional. Inactive policies audit and warn without enforcing; active policies enforce the intersection of all matching subject-path rules. With a valid policy store and no active policy for the current path, the CLI remains fully usable. Any malformed policy puts authenticated operations into fail-safe mode across all subjects. Active policies cannot be deactivated through this CLI.

Run `teams-cli policy edit` from a workspace to start the temporary least-privilege editor. The CLI prints a one-time local URL that can be opened in a normal browser or an AI tool's browser sidebar. The editor discovers names and participants for selection, but it cannot read message contents, initiate chats, or send messages.

## Further documentation

- [Authentication and token handling](docs/use/authentication.md)
- [Profiles and configuration precedence](docs/use/profiles.md)
- [Workspace policies](docs/use/policies.md)
- [Security model](docs/build/security-model.md)
- [Architecture](docs/build/architecture.md)
- [Testing](docs/build/testing.md)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development commands, architecture references, and project conventions.

Live Microsoft Teams validation is isolated from the normal suite. Configure the ignored `.env.e2e.local` as described in [the testing guide](docs/build/testing.md), then run `npm run test:e2e`.
