# ADR 0001: Use Edge authentication with private Teams APIs

- **Status:** Accepted
- **Date:** 2026-08-11
- **Decision owners:** Project maintainers

## Context

The project needs a small, mostly read-only CLI for Microsoft Teams. The MVP must list
the signed-in user's chats/conversations and Teams/channels. The environment does not
allow registering an Entra application, Teams application, or bot, and Microsoft Graph
cannot therefore be used with an approved client identity and delegated permissions.

The user already has legitimate interactive access to Teams. The problem is to reuse
that user session without collecting a password, bypassing MFA, or extracting the
desktop Teams client's long-lived credential store.

The official and supported integration is Microsoft Graph. This ADR does not dispute
that. It documents an experimental local workaround for a constrained environment.

## Decision drivers

- No new Entra application, Teams app, or bot registration.
- No Microsoft Graph access under the current tenant constraints.
- Read-only MVP: list chats/conversations and Teams/channels.
- Preserve Microsoft login, MFA, and Conditional Access in a Microsoft browser.
- Do not print or persist bearer-token values.
- Avoid decrypting or copying credentials from the installed Teams client.
- Reuse authentication state to minimize repeated user interaction.
- Keep private endpoint coupling isolated and replaceable.

## Options considered

| Option | Feasible now | Supportability | Credential risk | Reliability | Decision |
|---|---:|---:|---:|---:|---|
| Registered application with Microsoft Graph | No | High | Low | High | Preferred if constraints change |
| Existing Graph CLI or managed Graph integration | No | Medium–High | Medium | High | Rejected under current constraints |
| Recreate the legacy `fossteams` Electron login and save tokens | Yes, tenant-dependent | Low | High | Low | Rejected |
| Decrypt tokens/cookies from the local Teams installation | Technically plausible | Very low | Very high | Low | Rejected |
| Attach instrumentation to the running Teams desktop WebView | Plausible | Low | Medium | Medium–Low | Deferred |
| UI-only browser automation/scraping | Yes | Low | Low | Medium–Low | Fallback only |
| Dedicated Edge profile plus private API calls | Yes; live-verified | Low | Medium | Medium | Accepted |

## Decision

Use a dedicated, persistent Microsoft Edge profile as the authentication boundary.
The CLI launches Edge through Playwright/CDP and attempts OAuth with `prompt=none` so
the saved browser session can satisfy authentication silently. If Microsoft returns
`interaction_required`, it falls back to interactive account selection or MFA in Edge.

The CLI requests two Microsoft first-party resource tokens:

1. `https://api.spaces.skype.com`, exchanged through Teams `authsvc` for the regional
   Skype token and service endpoint map.
2. `https://chatsvcagg.teams.microsoft.com`, used for conversation discovery.

Tokens remain in process memory. The project does not print them or write them to its
own token files. Edge retains its normal encrypted cookies in `.state/edge-profile`,
which is excluded from version control and must be treated as sensitive browser state.

Conversation discovery calls the private CSA endpoint and maps the response into a
small internal model. Default output excludes hidden conversations, caps the list,
and does not print unresolved member identifiers.

## Why one initial token was insufficient

The initial design attempted to minimize capture to the Skype resource token. Live
testing showed that the ChatSvcAgg conversation endpoint enforces its own resource
audience. The Skype token can be exchanged for a regional message token but cannot be
used as the ChatSvcAgg bearer token. The MVP consequently obtains both resource tokens
within the same authenticated Edge session.

## Consequences

### Positive

- The MVP works without a custom application registration or Graph permission grant.
- Microsoft remains responsible for password entry, MFA, and Conditional Access UI.
- Preserved Edge state eliminates repeated interaction while the session remains valid.
- Private API code is small and can be replaced if Graph becomes available.
- Live testing has verified chat, Team, and channel discovery against the target tenant.

### Negative

- The approach is undocumented and unsupported by Microsoft.
- It relies on Microsoft's first-party Teams client identity and legacy OAuth behavior.
- Private endpoints and payloads may change without notice.
- Tenant policy can block the flow at any time.
- A persistent Edge profile is sensitive local state and requires filesystem protection.
- The integration may require organizational/legal review before wider deployment.

## Operational rules

- Keep `.state/` out of version control.
- Never log Authorization headers, callback fragments, cookie values, or raw tokens.
- Prefer `prompt=none`; use interactive Edge only after an explicit Microsoft
  interaction-required response.
- Make only read operations unless a later ADR explicitly authorizes writes.
- Bound and normalize private API output before displaying or logging it.
- Treat HTTP 401/403 responses as authentication or tenant-policy failures; do not
  bypass MFA, Conditional Access, consent, or security interstitials.
- Keep the [research log](../research.md) current as alternatives are evaluated.

## Revisit conditions

Revisit this decision when any of the following occurs:

- An approved Entra application registration and Graph permissions become available.
- Microsoft changes or disables either resource-token flow.
- The private CSA or `authsvc` endpoints become incompatible.
- Microsoft offers a supported user CLI or broker flow that meets the constraints.
- The project expands beyond local, read-only use.

If Graph becomes available, migrate to it and deprecate the private API adapter rather
than extending the workaround.
