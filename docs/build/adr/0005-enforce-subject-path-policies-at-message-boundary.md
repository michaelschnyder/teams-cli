# ADR 0005: Enforce subject-path policies at the message transport boundary

- **Status:** Accepted
- **Date:** 2026-08-28
- **Decision owners:** Project maintainers

## Context

The CLI can send Microsoft Teams messages. Its primary safety objective is preventing
a user or coding agent from accidentally sending to the wrong person, chat, channel,
or tenant. Profiles improve identity-selection ergonomics but are not permissions:
command options can intentionally override them, and an agent running as the same OS
user can access the same local authentication state.

The original JSON guardrail and command-layer check referenced by
[ADR 0003](0003-use-oso-cli-command-conventions.md) were insufficient. An internal
caller could invoke the transport function without the command-layer check, raw
bearer-token export could bypass the CLI entirely, and parser tests did not prove
that a denied invocation made zero network writes.

The invocation path is currently the only consistently available local signal for
distinguishing agent workspaces in Codex and Claude Code workflows. It is useful for
selecting restrictions but is not a strong security identity. Non-bypassable control
must remain outside the agent process through OS identity, read-only mounts, network
egress control, or server-side Teams permissions.

## Decision drivers

- Prevent accidental messages to destinations outside an explicit allowlist.
- Bind matching subject paths to the intended tenant and user after profile overrides.
- Let users audit and refine restrictions before enforcing them.
- Compose several independent restrictions without allowing one to weaken another.
- Keep unrestricted personal use possible when no active policy applies.
- Fail closed when any configured policy cannot be trusted.
- Authorize at the last practical point before every message POST.
- Preserve raw-token diagnostics while making their bypass capability explicit.
- Keep policy management deliberately small.
- Use filesystem permissions as defense in depth without calling a file immutable.

## Decision

### Named version 1 policies

Store named YAML policies directly under `~/.teams-cli/policies/<name>.yaml`. The name
uses a restricted filename-safe character set and must match the filename. Version 1
is the only schema:

```yaml
version: 1
name: project-agent
active: false
subject:
  paths:
    - /absolute/project/path
    - /absolute/client-*/**
identity:
  tenantId: tenant-id
  userId: user-id
allow:
  chats:
    "chat-id": [read]
  channels:
    "channel-id": [read, post]
  rawTokenExport: false
```

The subject is the canonical absolute invocation path. Symlinks are resolved before
matching. Subject patterns must be absolute and use the glob semantics provided by
Node.js. Patterns inside one policy are alternatives: matching any one makes that
policy applicable. By default, `policy init` records both the current canonical path
and its descendants.

The complete set of `.yaml` files is parsed and validated before subject matching.
Unreadable, malformed, misnamed, unsupported, or non-regular policy files therefore
put authenticated operations into fail-safe mode across all subjects. Non-`.yaml`
files are ignored. Unknown fields, duplicate YAML keys, aliases, and invalid values
are rejected.

Policies remain separate from profiles. Profiles select the baseline tenant, user,
browser, and token store. Policies decide whether the fully resolved identity and
protected operation are allowed for the current subject.

### Audit, enforcement, and composition

`active: false` is audit mode. Whenever an inactive policy matches, the CLI warns
that it is not enforcing. It also warns when the policy would deny the current
identity or operation, but does not deny the operation.

`active: true` enforces the policy. Every applicable active policy must allow the
effective identity and operation. This intersection has no priority or last-wins
override, so adding a policy can only preserve or narrow access. When an active policy
applies, omitted permissions are denied.

The absence of an applicable active policy is deliberately unrestricted, provided
the policy store itself is valid. This preserves ordinary CLI use and supports
iterative adoption.

### Message and token authorization boundary

`message send` checks the effective identity and exact destination before preparing
the operation. The transport function additionally requires an authorization
callback and awaits it immediately before issuing the POST. The callback reloads the
entire policy store and repeats the decision.

Only authentication failures reported as HTTP `401` or `403` may trigger one token
refresh and retry. The authorization callback runs again immediately before the
second POST. Ambiguous network failures, timeouts, throttling, and other server
failures do not retry a write.

Destination identifiers are exact and case-sensitive. Chat and channel targets use
separate allowlists; target type is never inferred from an identifier.

When any policy applies, raw bearer-token output requires every applicable active
policy to set `allow.rawTokenExport: true`. Applicable inactive policies only audit
the decision. Raw token output remains available when no policy applies. Exported
tokens can bypass cooperative CLI enforcement and must be treated like passwords.

### Activation and filesystem protection

The minimal management surface is:

```text
policy init <name> [--subject <absolute-path-glob> ...]
policy list
policy show [name] [--path <path>]
policy check send [--path <path>] (--chat <id> | --channel <id>)
policy check raw-tokens [--path <path>]
policy activate <name>
```

`policy activate` and the browser editor's Save-and-Activate action are the only activation transitions. The CLI has no deactivate
or remove command; those actions require deliberate file changes outside the CLI.
Activation does not change permissions automatically or claim to lock the file. On
POSIX systems it prints an exact `chmod 400` instruction.

At runtime, an active file writable by its owner is enforced with a warning. An
active policy file or the policy directory writable by group or other users fails
closed. Externally managed read-only permissions, ACLs, or mounts are the preferred
stronger boundary. A process running as the file owner may still restore write
permission or use exported tokens, so non-bypassable enforcement requires controls
outside the agent runtime.

### Verification strategy

Every message-content read and write path requires a deterministic test that invokes the real CLI
path against a local mock server and proves a denied operation produces zero GETs or POSTs.
Parser and matcher unit tests alone are insufficient.

An explicit live suite additionally uses a dedicated test tenant with isolated
sender and observer users. It creates its own local policy, sends one uniquely marked
allowed message that the observer must see, and verifies that a denied marker is
rejected and absent. The live suite is excluded from the default test command and
must never target a personal or production tenant. Credential, license, and fixture
details are documented in [the testing guide](../testing.md).

This dedicated-tenant test is a narrow exception to ADR 0003's original rule against
live writes because end-to-end identity, service, and policy integration cannot be
proved by mocks alone.

## Options considered

| Option | Decision |
| --- | --- |
| Treat profiles as permissions | Rejected because profiles are user-overridable selectors. |
| Store policy inside each subject workspace | Rejected because the agent commonly has write access there. |
| Select policy from OS user alone | Rejected because several agent workspaces run as the same user. |
| Match only a Git root | Rejected because it cannot represent subpaths, non-Git subjects, or multiple path families. |
| Require an active policy globally | Rejected because optional, iterative adoption is required. |
| Validate only matching policies | Rejected because unnoticed corruption elsewhere would leave part of the policy system operational. |
| Merge policies by priority or permissive union | Rejected because one policy could weaken another. |
| Check only in the command handler | Rejected because internal transport callers could bypass it. |
| Automatically make an active file read-only | Rejected because permission models vary and activation is not an OS security boundary. |
| Named subject-path policies intersected at the transport boundary | Accepted. |

## Consequences

### Positive

- Subject paths can be matched exactly or as reusable path families.
- Inactive policies support iterative exploration without silently claiming enforcement.
- Flags and profile changes cannot widen an applicable active policy.
- Independent policies compose safely through intersection.
- Denied CLI sends are tested to produce zero network POSTs.
- Policy is reloaded and checked immediately before every message POST and retry.
- Raw token export remains available but explicitly controllable when policies apply.
- Files outside the repository work well with workspace-limited agent sandboxes.

### Negative

- Path matching is a local heuristic rather than authenticated runtime identity.
- Inactive policies allow operations and must not be mistaken for protection.
- Glob patterns require careful quoting and review.
- Moving a subject or changing symlink topology may alter matching.
- One malformed policy denies authenticated operations in unrelated subjects until
  repaired.
- Exact destination IDs are less convenient than names and must be discovered first.
- Owner-read-only mode does not stop a malicious or fully privileged same-user process.
- Live tests perform one real allowed write and require maintained tenant fixtures,
  licenses, and credentials.
- Private Teams endpoints and authentication remain unsupported by Microsoft.

## Operational rules

- Keep policies outside agent-writable workspaces and mount them read-only where practical.
- Warn on every applicable inactive policy and every audit-mode denial.
- Resolve the concrete subject path canonically before matching.
- Require absolute subject patterns and quote globs in shell commands.
- Intersect active decisions; never add a permissive override order.
- Validate the entire policy store before subject matching.
- Reauthorize the exact destination immediately before every message POST and retry.
- Do not add wildcard destinations or infer target type from IDs.
- Do not retry writes after ambiguous failures.
- Keep deactivation, editing, and removal outside the CLI.
- Require a zero-POST denial test for every new write capability.
- Run live writes only through the explicit E2E suite in the dedicated test tenant.
- Treat raw token export as a policy bypass capability.

## Revisit conditions

Revisit this decision if agent runtimes expose a stronger signed subject identity,
subjects expand beyond filesystem paths, organization-managed policy sources become
necessary, Node.js glob semantics prove insufficient, a server-side enforcement
point becomes available, or the CLI moves to a supported Microsoft Graph application
model.
