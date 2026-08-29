# ADR 0006: Use active subject-path policies

- **Status:** Accepted
- **Date:** 2026-08-28
- **Decision owners:** Project maintainers

## Context

[ADR 0005](0005-enforce-workspace-policies-at-message-boundary.md) introduced one
policy selected by a hash of the canonical Git root and described `policy lock` as a
cooperative safeguard. That model has three limitations:

- A Git root is an implementation-specific approximation of an agent's subject and
  cannot express several paths or path families.
- Only one policy can apply, so independent restrictions cannot be composed.
- `locked` overstates what the CLI can guarantee when the process runs as the file
  owner. The useful distinction is whether a policy audits or enforces.

Users also need to refine a policy iteratively before enforcement, while still seeing
which operations the proposed policy would deny.

## Decision drivers

- Describe enforcement state accurately without claiming filesystem immutability.
- Let users audit a restrictive policy before enabling it.
- Match exact paths, multiple paths, and path families.
- Compose independent policies without an override order.
- Preserve global fail-safe validation of the complete policy store.
- Keep activation one-way through the CLI so an agent cannot disable enforcement with
  an ordinary command.
- Use filesystem permissions as visible defense in depth.

## Decision

### Named version 2 policies

Store named policies directly under `~/.teams-cli/policies/<name>.yaml`. Policy names
use a restricted filename-safe character set and must match the filename. The schema
is version 2 and replaces `workspace` and `locked` with:

```yaml
version: 2
name: project-agent
active: false
subject:
  paths:
    - /absolute/project/path
    - /absolute/client-*/**
```

Version 1 workspace policies are not migrated automatically. A legacy policy store
fails closed with an actionable error until it is deliberately migrated or removed.

### Subject matching and composition

The subject is the canonical absolute invocation path. Symlinks are resolved before
matching. Each policy must contain one or more absolute path patterns using Node.js
glob semantics. Matching any pattern makes that policy applicable.

All applicable active policies are intersected. Every active policy must allow the
effective identity and protected operation. There is no priority, last-wins override,
or permissive union. An inactive policy never weakens an active policy.

The complete `.yaml` policy store is validated before matching. Malformed or misnamed
policies and dangerously writable active policies therefore fail closed globally, as
established by ADR 0005.

### Audit and enforcement

`active: false` is audit mode. The CLI emits a prominent stderr warning whenever an
inactive policy matches and another warning when it would deny the identity or
operation. The operation remains allowed unless an active policy denies it.

`active: true` enforces the policy. `policy activate <name>` is the only CLI state
transition and is one-way. Deactivation, editing, and removal remain deliberate
filesystem actions outside the CLI.

Activation does not change permissions automatically or claim to lock the file. On
POSIX systems the command prints an exact `chmod 400` instruction. At runtime:

- an applicable active file writable by its current owner is enforced with a warning;
- an active file or policy directory writable by group or other users fails closed; and
- externally managed read-only ACLs or mounts remain the preferred stronger boundary.

### Command surface

The minimal management surface is:

```text
policy init <name> [--subject <absolute-path-glob> ...]
policy list
policy show [name] [--path <path>]
policy check send [--path <path>] (--chat <id> | --channel <id>)
policy check raw-tokens [--path <path>]
policy activate <name>
```

`policy lock` and `--workspace` are removed rather than retained as compatibility
aliases because the project is not released and their semantics are obsolete.

## Options considered

| Option | Decision |
| --- | --- |
| Retain `locked: true/false` | Rejected because it conflates enforcement with filesystem immutability. |
| Use `mode: audit/enforce` | Clear, but rejected in favor of the requested simpler `active` state. |
| Match only the Git root | Rejected because it cannot represent subpaths, non-Git subjects, or multiple path families. |
| Merge policies by priority or last-wins override | Rejected because a permissive policy could weaken a restrictive one. |
| Intersect every applicable active policy | Accepted because additional policies can only preserve or narrow access. |
| Automatically change permissions during activation | Rejected because ACL semantics vary and activation should not claim an OS boundary. |

## Consequences

### Positive

- Terminology reflects real enforcement behavior.
- Audit warnings support iterative policy development.
- Multiple reusable path patterns replace repository-location heuristics.
- Independent active policies compose safely through intersection.
- Named files make inspection and activation understandable.
- Permission warnings expose when cooperative protection is weak.

### Negative

- Inactive policies allow operations and must not be mistaken for protection.
- Glob patterns require careful quoting and review.
- Moving a subject or changing symlink topology may alter matching.
- One restrictive active policy can deny an operation allowed by every other policy.
- The Node.js minimum increases to 22.20 for stable built-in glob matching.
- Existing version 1 policy files require deliberate replacement.

## Operational rules

- Warn on every applicable inactive policy and every audit-mode denial.
- Resolve the concrete subject path canonically before matching.
- Require absolute path patterns and quote globs in shell commands.
- Intersect active decisions; never introduce a permissive override order.
- Re-evaluate all applicable policies immediately before every message POST and retry.
- Validate the entire policy store before matching.
- Print OS protection guidance after activation without claiming it is mandatory or
  immutable.
- Keep deactivation and removal outside the CLI.

## Revisit conditions

Revisit this decision if subjects expand beyond paths, signed runtime identity becomes
available, policy composition needs organization-managed sources, Node glob semantics
prove insufficient, or the CLI gains an external policy enforcement service.
