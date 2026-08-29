# ADR 0005: Enforce workspace policies at the message transport boundary

> Later decision (2026-08-28): [ADR 0006](0006-use-active-subject-path-policies.md) replaces workspace-hash selection and `locked` with named subject-path policies, audit-mode inactivity, active-policy intersection, and separate filesystem protection guidance. The transport-boundary and global fail-safe decisions in this ADR remain in force.

- **Status:** Accepted
- **Date:** 2026-08-28
- **Decision owners:** Project maintainers

## Context

The CLI can send Microsoft Teams messages. Its primary safety objective is preventing
a user or coding agent from accidentally sending to the wrong person, chat, channel,
or tenant. Profiles improve selection ergonomics but are not permissions: a global
flag can intentionally override them, and an agent running as the same OS user can
access the same local authentication state.

The original JSON guardrail and command-layer check referenced by
[ADR 0003](0003-use-oso-cli-command-conventions.md) were insufficient. A future caller
could invoke the transport function without the CLI check, raw bearer-token export
could bypass the CLI entirely, and parser tests did not prove that a denied invocation
made zero network writes.

Workspace location is the only consistently available signal for distinguishing one
local agent task from another in current Codex and Claude Code workflows. It is useful
for selecting a policy but is not a strong security boundary. Non-bypassable control
must remain outside the agent process through OS identity, read-only mounts, network
egress control, or server-side Teams permissions.

## Decision drivers

- Prevent accidental messages to destinations outside an explicit allowlist.
- Bind an agent workspace to the intended tenant and user after profile overrides.
- Keep unrestricted personal use possible when no policy has been configured.
- Fail closed when an expected policy exists but cannot be trusted.
- Put authorization at the last practical point before a message POST.
- Recheck changed policy state after authentication refresh and before retry.
- Preserve raw-token diagnostics while making bypass explicit when a policy applies.
- Keep policy management small and avoid building a local permissions platform.
- Use filesystem permissions as defense in depth without overstating their strength.

## Decision

### Policy selection and schema

Use optional, versioned YAML workspace policies stored outside the workspace at
`~/.teams-cli/policies/workspaces/<workspace-key>.yaml`. The workspace key is a SHA-256
hash of the canonical Git root, or the canonical current directory when no Git root
exists. The policy also contains the absolute canonical workspace path, which must
resolve to the current workspace before the policy is trusted.

The version 1 schema may bind `tenantId` and `userId`, allow exact chat and channel IDs
for message sends, and allow or deny raw bearer-token export. YAML is parsed strictly:
unknown fields, duplicate keys, aliases, malformed values, unreadable files, and
workspace mismatches deny authenticated operations.

Before selecting the current workspace policy, the CLI validates every `.yaml` file
in the workspace-policy directory, including its canonical workspace binding and
hash-derived filename. One invalid policy puts the entire store into fail-safe mode
and denies authenticated operations in every workspace. This deliberately favors
global safety and visible repair over availability when local policy state is corrupt.
Non-`.yaml` files are not policies and are ignored.

The absence of a workspace policy is deliberately unrestricted. This preserves the
normal CLI experience and allows users to introduce policy iteratively. Once a policy
exists, omitted permissions are denied. Identity constraints are evaluated after
profile, environment, and flag resolution, so those inputs cannot weaken the policy.

Policies remain separate from profiles. Profiles answer which identity and browser to
use; policies answer whether that effective identity and operation are allowed in the
current workspace.

### Message authorization boundary

`message send` checks the effective identity and exact destination before preparing
the operation. The transport function also requires an authorization callback and
awaits it immediately before issuing the POST. The callback reloads the current
workspace policy and repeats the decision.

Only authentication failures reported as HTTP `401` or `403` may trigger one token
refresh and retry. The operation callback is then invoked again, which reloads and
rechecks policy immediately before the second POST. Ambiguous network failures,
timeouts, throttling, and other server failures do not retry a write.

Destination identifiers are exact and case-sensitive. Chat and channel targets are
separate allowlists and target type is never inferred from an identifier. This avoids
wildcard, name-resolution, and hierarchy ambiguity at the write boundary.

When a policy applies, raw bearer-token output requires
`allow.rawTokenExport: true`. Decoded JWT claims remain available because they omit the
bearer value. Raw token output remains available when no policy applies. Exported
tokens can be used by another HTTP client to bypass cooperative CLI enforcement and
must be treated like passwords.

### Locking and stronger boundaries

`policy init` creates a restrictive editable policy. `policy lock` sets `locked: true`
and owner-read-only mode (`0400`). The CLI provides inspect and decision-check commands
but no edit, unlock, or delete command. Revision requires deliberate filesystem action
outside the CLI.

This lock prevents routine CLI mutation and many accidental agent changes. It is not
tamper-proof against a process running as the file owner, which can change permissions
or use tokens outside the CLI. Strong enforcement requires controls outside the agent
runtime, such as:

- a separate, least-privilege OS identity;
- a policy file mounted read-only from outside the writable workspace;
- a container or sandbox that cannot modify the policy or token store;
- restricted network egress; or
- Teams tenant, user, and channel permissions that make disallowed writes impossible.

### Verification strategy

Every message-write path requires a deterministic test that invokes the real CLI path
against a local mock server and proves a denied operation produces zero POSTs. Parser
and matcher unit tests alone are insufficient.

An explicit live suite additionally uses a dedicated test tenant with isolated sender
and observer users. It creates and locks the local policy itself, sends one uniquely
marked allowed message that the observer must see, and verifies that a denied marker
is rejected and absent. The live suite is never part of the default test command and
must never target a personal or production tenant. Credential, license, and fixture
details remain operational documentation in [the testing guide](../testing.md).

This dedicated-tenant test is a narrow replacement for ADR 0003's original rule that
writes must never be tested against live Teams. It exists because end-to-end identity,
service, and policy integration cannot be proven by mocks alone.

## Options considered

| Option | Decision |
| --- | --- |
| Treat profiles as permissions | Rejected because profiles are user-overridable selectors. |
| Store a policy inside each workspace | Rejected because the agent commonly has write access to its workspace. |
| Select policy from OS user alone | Rejected because several agent workspaces run as the same user. |
| Require a policy globally | Rejected because policy is optional and must not break unrestricted personal use. |
| Validate only the selected workspace policy | Rejected because unnoticed corruption elsewhere would leave part of the policy system operational. |
| Check only in the CLI command handler | Rejected because internal transport callers could bypass it. |
| Make locked files cryptographically or absolutely immutable | Rejected as an unsupported claim under the same OS identity. |
| Workspace-selected policy plus transport-boundary enforcement | Accepted. |

## Consequences

### Positive

- A workspace can pin the intended identity and exact message destinations.
- Flags and profile changes cannot widen an applicable policy.
- Denied CLI sends are tested to produce zero network POSTs.
- Policy is checked close to transport and again on an authentication retry.
- Raw token export remains useful while its bypass risk is explicit and controllable.
- Policy files outside the repository work well with workspace-limited agent sandboxes.

### Negative

- A renamed or moved workspace resolves to a different policy key and requires a new
  binding.
- No-policy operation is unrestricted by design and may surprise users expecting a
  global deny default.
- One malformed policy denies authenticated operations in otherwise unrelated
  workspaces until the store is repaired.
- Exact destination IDs are less convenient than names and must be discovered first.
- Read-only mode does not stop a malicious or fully privileged same-user process.
- Live tests perform one real allowed write and require maintained tenant fixtures,
  licenses, and credentials.
- Private Teams endpoints and authentication remain unsupported by Microsoft.

## Operational rules

- Keep policy files outside agent-writable workspaces and mount them read-only where
  practical.
- Resolve and verify the canonical workspace before applying a policy.
- Fail closed for an existing policy that is unreadable, malformed, or misbound.
- Reauthorize the exact destination immediately before every message POST.
- Do not add wildcard destinations or infer target type from IDs.
- Do not retry writes after ambiguous failures.
- Require a zero-POST denial test for every new write capability.
- Run live writes only through the explicit E2E suite in the dedicated test tenant.
- Treat raw token export as a policy bypass capability.

## Revisit conditions

Revisit this decision if coding-agent runtimes expose a stronger signed workspace
identity, policy must compose across machine/user/workspace scopes, additional write
types are added, a server-side policy enforcement point becomes available, or the CLI
moves to a supported Microsoft Graph application model.
