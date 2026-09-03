# ADR 0001: Use browser-backed authentication with private Teams APIs

> Historical note (2026-08-28): The single-session storage protocol in this ADR was replaced by identity-scoped session version 3 and optional profile selectors. See [ADR 0004](0004-use-profiles-for-identity-scoped-sessions.md). Policy enforcement is recorded separately in [ADR 0005](0005-enforce-subject-path-policies-at-message-boundary.md).

- **Status:** Accepted
- **Date:** 2026-08-11
- **Updated:** 2026-08-14
- **Decision owners:** Project maintainers

## Context

The project needs a minimal CLI that can authenticate a user to Microsoft Teams,
reuse that authentication across command invocations, validate the current session,
inspect its token lifetimes, and log out locally.

The environment does not allow registering an Entra application, Teams application,
or bot. Microsoft Graph cannot therefore be used with an approved client identity and
delegated permissions. The official and supported integration remains Microsoft
Graph; this ADR documents an experimental local workaround for that constraint.

## Decision drivers

- No new Entra application, Teams app, or bot registration.
- Preserve Microsoft login, MFA, and Conditional Access in a Microsoft-controlled UI.
- Reuse authentication without requiring an interactive login for every invocation.
- Keep authentication storage separate from future CLI configuration and guardrails.
- Support installed branded Chromium browsers without binding the storage model to
  one browser or operating system.
- Expose bearer tokens only through an explicitly named token-display command.
- Keep the private API coupling small and replaceable.

## Options considered

| Option | Feasible now | Supportability | Credential risk | Reliability | Decision |
|---|---:|---:|---:|---:|---|
| Registered application with Microsoft Graph | No | High | Low | High | Preferred if constraints change |
| Existing Graph CLI or managed Graph integration | No | Medium–High | Medium | High | Rejected under current constraints |
| Decrypt credentials from the installed Teams client | Plausible | Very low | Very high | Low | Rejected |
| UI-only browser automation | Yes | Low | Low | Medium–Low | Fallback only |
| Dedicated Chrome/Edge profile plus private auth API | Yes; Edge live-verified | Low | Medium | Medium | Accepted |

## Decision

Use a dedicated, persistent browser profile as the authentication boundary. Microsoft
Edge is the default; Google Chrome is also supported through Playwright's branded
browser channels. The CLI does not read or modify the user's normal browser profile.

Interactive `auth login` requests an OAuth token for
`https://api.spaces.skype.com` with Microsoft's first-party Teams client identity,
then exchanges it through Teams `authsvc` for a regional Skype token. Both tokens are
persisted so later command invocations can validate and inspect the session.

`auth whoami` validates the saved access token through `authsvc`. When the token is
expired or rejected with `401` or `403`, the CLI attempts OAuth once with
`prompt=none`, the saved tenant, and the same dedicated browser profile. It never
turns that validation command into an interactive login. If Microsoft requires
account selection, MFA, or another interaction, the interactive CLI offers to reopen the dedicated browser profile and continue. Non-interactive use tells the user to run `auth login`.

`auth whoami` shows identity, audience, absolute expiry, and duration remaining, but
does not print token values. `auth tokens [all|access|skype|chat|search]` is the only supported
way to print complete bearer tokens. Its singular alias, `auth token`, provides
the same behavior. With `--decode`, it prints only the decoded JWT claims as JSON,
omitting the encoded header and signature.

Explicit refresh also covers the ChatSvcAgg and Outlook Search resource tokens
introduced by [ADR 0002](0002-server-backed-chat-and-message-reads.md). `auth refresh
all` reacquires every OAuth resource non-interactively and derives a new Skype token.
`auth refresh access|skype|chat|search` changes only the selected credential, subject
to its prerequisite token being valid. Omitting the target is equivalent to `all`.
Every refresh reports the selected token's audience, absolute expiry, and remaining
lifetime before and after the operation.

## Storage protocol

Authentication state is partitioned beneath a replaceable storage root:

```text
<storage-root>/
├── auth/
│   └── session.json
└── browser-profiles/
    ├── chrome/
    └── edge/
```

The current root is `~/.teams-cli`. The root and browser directories use owner-only
permissions, and `auth/session.json` uses mode `0600` and atomic replacement.

Paths are derived from an explicit storage-root value internally rather than being
scattered through authentication code. A future profile and guardrail design may
resolve the root to a workspace-controlled directory so an agent does not need write
access to home-directory configuration or locked policy files. Root selection,
profile locking, and guardrail enforcement are intentionally outside the current
implementation.

`auth logout` removes only `auth/session.json` and the `browser-profiles` subtree. It
does not remove future configuration or guardrail files under the storage root, and it
does not claim to revoke tokens remotely at Microsoft.

## Consequences

### Positive

- Authentication works without custom application registration or Graph permissions.
- Microsoft remains responsible for password entry, MFA, and Conditional Access UI.
- Saved tokens and browser state avoid repeated interaction while the session can be
  refreshed.
- Browser-specific subdirectories avoid mixing Chrome and Edge profile data.
- A replaceable root leaves room for workspace-scoped, access-controlled profiles.

### Negative

- The approach is undocumented and unsupported by Microsoft.
- It relies on Microsoft's first-party client identity and legacy OAuth behavior.
- Tenant policy or private endpoint changes can break the flow.
- Persisted tokens and browser profiles are sensitive local state.
- Explicit raw-token output can leak through terminal scrollback or captured output.
- Chrome support is implemented through Playwright but still requires live validation
  in each target operating environment and enterprise policy configuration.

## Operational rules

- Keep authentication state outside the repository by default.
- Never log Authorization headers, callback fragments, cookies, or raw tokens.
- Print raw tokens only through `auth tokens` or its `auth token` alias.
- Use interactive authentication for explicit `auth login` and only after confirmation when a command must start or restore a session.
- Verify refreshed tokens remain in the stored tenant before replacing the session.
- Treat HTTP `401` and `403` as authentication or tenant-policy failures; do not bypass
  MFA, Conditional Access, consent, or security interstitials.
- Teams data reads are authorized only as described by ADR 0002. No Teams writes are
  authorized.

## Revisit conditions

Revisit this decision when any of the following occurs:

- An approved Entra application registration and Graph permissions become available.
- Microsoft changes or disables the resource-token or `authsvc` flow.
- Another browser or operating system needs different profile handling.
- Workspace-scoped profiles, immutable guardrails, or agent access boundaries are
  implemented.
- Microsoft offers a supported user CLI or broker flow that meets the constraints.
