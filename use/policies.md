# Policies

Policies are optional named YAML files under `~/.teams-cli/policies/`. They limit the effective identity, message destinations, and raw-token export for matching subject paths.

## How policy selection works

The current subject is the canonical absolute path from which the CLI is invoked. This path selector is a convention of this CLI, not an external standard or a strong security identity. Symlinks are resolved before matching.

Each policy contains one or more absolute path patterns. Patterns use Node.js glob syntax:

```yaml
subject:
  paths:
    - /Users/me/Workspaces/project
    - /Users/me/Workspaces/client-*/**
```

The paths within one policy are alternatives: matching any one makes that policy applicable. Several policies may apply to the same subject. Every active policy must allow an operation, so adding another active policy can only preserve or narrow access.

The CLI validates every `.yaml` file in the policy directory before matching. An unreadable, malformed, misnamed, unsupported, or dangerously writable active policy puts authenticated operations into fail-safe mode across every subject. Files without a `.yaml` extension are not policies and are ignored. The obsolete `policies/workspaces/` layout is rejected explicitly so an earlier restriction cannot disappear silently.

## Inactive and active policies

New policies are inactive. An inactive policy runs in audit mode:

- The CLI warns on stderr that the policy is not enforcing restrictions.
- The policy is still evaluated.
- The CLI warns when it would deny the selected identity or operation.
- The operation remains allowed unless another applicable active policy denies it.

An active policy enforces its identity and allowlists. Active policies cannot be deactivated through the CLI. This makes activation deliberate without claiming that the file itself is locked.

## Create and refine a policy

Create a named restrictive policy for the current path. Without explicit subjects, initialization adds both the current canonical path and a descendant glob so commands from its subdirectories remain covered:

```bash
teams-cli --profile personal policy init project-agent
```

Supply several subject patterns by repeating `--subject`:

```bash
teams-cli --profile personal policy init client-projects \
  --subject '/Users/me/Workspaces/client-a/**' \
  --subject '/Users/me/Workspaces/client-b/**'
```

Subject patterns must be absolute. Quote patterns so the shell does not expand them before the CLI receives them.

The generated policy is restrictive and inactive:

```yaml
version: 2
name: project-agent
active: false
subject:
  paths:
    - /Users/me/Workspaces/project
    - /Users/me/Workspaces/project/**
identity:
  tenantId: tenant-id
  userId: user-id
allow:
  messageSend:
    chats: []
    channels: []
  rawTokenExport: false
```

Edit the file outside the CLI and add only the exact, case-sensitive chat and channel IDs required by the subject. A chat entry never permits a channel with the same text. Set `rawTokenExport: true` only when complete bearer tokens are genuinely required; decoded claims do not need that permission.

Inspect configured or applicable policies:

```bash
teams-cli policy list
teams-cli policy show project-agent
teams-cli policy show
teams-cli policy show --path /absolute/path/to/check
```

Check representative decisions while the policy is still inactive. Warnings show what audit mode would deny:

```bash
teams-cli --profile personal policy check send --chat CHAT_ID
teams-cli --profile personal policy check send --channel CHANNEL_ID
teams-cli --profile personal policy check raw-tokens
```

## Activate and protect a policy

Activate enforcement by name:

```bash
teams-cli policy activate project-agent
```

On POSIX systems, the command prints an exact additional protection instruction such as:

```bash
chmod 400 -- '/Users/me/.teams-cli/policies/project-agent.yaml'
```

Activation and filesystem protection are separate:

- `active: true` makes the CLI enforce the policy.
- Owner-read-only permissions reduce accidental same-user modification.
- An active owner-writable policy is enforced but produces a warning.
- An active policy or policy directory writable by group or other users fails closed.
- On Windows, use an administrator-managed read-only ACL instead.

Read-only permissions are defense in depth, not an immutable lock. A process with sufficient owner or administrator privileges can still replace the file or use exported tokens outside this CLI.

## Deactivate, revise, or remove a policy

The CLI intentionally has no deactivate, edit, or remove command. Use `policy show NAME` to obtain the exact file path. If the store is malformed, the error identifies the offending file.

On POSIX systems, make that one file writable before changing it:

```bash
chmod u+w '/exact/policy/path.yaml'
```

To return to audit mode, set `active: false`. To revise an active policy, deactivate it first, make the changes, use `policy check`, and activate it again. To remove it completely, delete only that exact file:

```bash
rm '/exact/policy/path.yaml'
```

Removing the last applicable active policy may make the subject unrestricted. Confirm the result with `policy show` and `policy check`.

If permissions are controlled by a read-only mount, sandbox, separate OS identity, or administrator ACL, revise the policy at that external enforcement layer.

## Security boundary

Policies primarily prevent accidental messages to the wrong destinations. Strong, non-bypassable enforcement requires controls outside the agent process, such as a separate OS identity, read-only container mount, restricted network egress, or server-side Teams permissions.
