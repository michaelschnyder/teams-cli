# ADR 0004: Use profiles to select identity-scoped sessions

- **Status:** Accepted
- **Date:** 2026-08-28
- **Decision owners:** Project maintainers

## Context

The CLI must keep several Microsoft Teams logins available at the same time. A user
may work in multiple tenants, use multiple users in one test tenant, select Edge or
Chrome for browser-backed authentication, and run automated tests without repeatedly
logging a different identity in and out.

A named profile is useful for selecting this state, but it must not become another
credential container or a second representation of a Microsoft account. Microsoft
already provides the tenant and user identity. Adding an independent account entity
would introduce naming, lifecycle, and precedence rules without adding a security
boundary.

The single `auth/session.json` and browser-directory layout documented in
[ADR 0001](0001-browser-backed-private-teams-api.md) cannot isolate multiple users.
Login also needs to verify the identity returned by Microsoft before browser state is
allowed to replace the state for an existing identity.

## Decision drivers

- Keep several tenant/user logins usable without login/logout churn.
- Make profiles optional and familiar to users of tools such as the AWS CLI.
- Allow command-line flags to override a profile for one invocation.
- Never select credentials from a mutable username alone.
- Prevent one user's tokens or browser cookies from replacing another user's state.
- Allow Edge and Chrome state to coexist for the same identity.
- Support unattended login without storing passwords in profiles or session files.
- Avoid a speculative account abstraction and migration framework.

## Decision

### Identity and profiles

The stable local authentication identity is `(tenantId, userId)`, where `userId` is
the Microsoft object ID verified from the returned tokens. A username is only a login
hint and may change. No separate account entity is introduced.

A profile is a named configuration baseline containing any of `tenantId`, `userId`,
`username`, and `browser`. It points commands toward an identity and browser but does
not own tokens, browser state, or permissions. Several profiles may select the same
identity. Removing a profile does not log that identity out or delete its state.

The effective runtime context is resolved in this order:

1. Global command options: `--profile`, `--tenant`, `--user`, and `--browser`.
2. `TEAMS_CLI_PROFILE`, `TEAMS_CLI_TENANT`, `TEAMS_CLI_USER`, and
   `TEAMS_CLI_BROWSER`.
3. The selected profile, or the profile named `default` when none is selected.
4. Built-in defaults, currently Microsoft Edge for the browser.

Named profiles do not inherit fields from the `default` profile. Flags and
environment variables may override profile values, but the resolved identity remains
subject to any applicable subject-path policies described by
[ADR 0005](0005-enforce-subject-path-policies-at-message-boundary.md).

Profiles are stored as strictly parsed, versioned YAML in
`~/.teams-cli/config.yaml`. Unknown fields, duplicate keys, and YAML aliases are
rejected. The configuration directory and file use owner-only permissions and file
replacement is atomic.

### Identity-scoped state

Session version 3 contains the verified tenant ID and user ID. Session and browser
paths use a SHA-256 key derived from both values, so identifiers do not appear in
filenames:

```text
~/.teams-cli/
├── config.yaml
├── auth/
│   └── <identity-key>.json
└── browser-profiles/
    ├── <identity-key>/
    │   ├── edge/
    │   └── chrome/
    └── .staging/
```

Tokens belong to the tenant/user session rather than to a profile or browser. A
different browser can therefore be selected while existing tokens remain valid. Each
browser keeps separate cookie and browser state for the occasions when a complete
browser-backed token acquisition is required.

Login starts in a randomly named staging browser directory. The CLI verifies the
returned tenant and optional expected user before saving the session and atomically
promoting that browser directory to the verified identity/browser path. Failed or
mismatched logins discard the staging directory. This prevents unverified browser
state from overwriting another identity's stored state.

Legacy session versions are not migrated automatically. This project is not released,
and requiring a fresh login is safer and smaller than maintaining speculative
migration code.

### Automated login

The public CLI accepts an automated password only through
`--password-command <absolute-path>`. The executable receives no arguments, is run
without a shell, has a 30-second timeout and a 16 KiB output limit, and writes the
password plus an optional trailing newline to stdout. Empty output and helper failure
abort login. Passwords are never written to profiles or session files.

Headless login requires a username and an automated credential. It does not bypass
MFA, Conditional Access, licensing, or unexpected Microsoft login pages. The direct
in-process password option exists only for the JavaScript live-test harness and is not
part of the CLI command surface.

## Options considered

| Option | Decision |
| --- | --- |
| One active global session | Rejected because switching users requires destructive login/logout churn. |
| Profiles own copied tokens and browser state | Rejected because aliases would duplicate sensitive state and complicate lifecycle rules. |
| Add a separate named account entity below each tenant | Rejected because the verified Microsoft tenant/user identity already supplies the required key. |
| Key state only by globally unique user ID | Rejected in favor of including the tenant as an explicit validation and isolation dimension. |
| Store passwords in profiles or `.env` for general CLI use | Rejected; normal automation uses a credential helper. |
| Identity-scoped sessions with profile selectors | Accepted. |

## Consequences

### Positive

- Multiple tenants and multiple test users can remain logged in concurrently.
- Profiles provide convenient names without becoming credential or policy boundaries.
- Per-command overrides preserve a familiar and composable CLI model.
- Browser state for Alice, Bob, Edge, and Chrome cannot collide by path.
- Staged login prevents an unexpected identity from replacing trusted browser state.
- CI can retrieve passwords from its existing secret manager without persisting them.

### Negative

- The tenant and user must be selected before most authenticated commands can load a
  session.
- Multiple browser profiles consume more disk space.
- A profile name is not proof of identity and must never be used as an authorization
  decision.
- Automated username/password login is subject to Microsoft page changes and tenant
  security policy.
- Old session files require a new login.

## Operational rules

- Verify tenant and user claims before saving or promoting login state.
- Never store passwords in profile or session configuration.
- Keep session files and browser profiles outside repositories and agent-writable
  workspaces by default.
- Treat profile resolution as configuration only; apply policy after all overrides.
- Log out an explicit tenant/user identity without removing unrelated profiles or
  sessions.
- Use dedicated, least-privilege test identities for automated login.

## Revisit conditions

Revisit this decision if Microsoft provides a supported account broker, user IDs stop
being stable for the selected API, profiles need inheritance, remote credential
storage becomes necessary, or released versions require a formal session migration
protocol.
