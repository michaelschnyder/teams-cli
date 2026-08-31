# Policies

Policies are optional named YAML files under `~/.teams-cli/policies/`. They limit the effective identity, message reads and posts, and raw-token export for matching subject paths.

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

The CLI validates every `.yaml` file in the policy directory before matching. An unreadable, malformed, misnamed, unsupported, or dangerously writable active policy puts authenticated operations into fail-safe mode across every subject. Files without a `.yaml` extension are not policies and are ignored.

## Inactive and active policies

New policies are inactive. An inactive policy runs in audit mode:

- The CLI warns on stderr that the policy is not enforcing restrictions.
- The policy is still evaluated.
- The CLI warns when it would deny the selected identity or operation.
- The operation remains allowed unless another applicable active policy denies it.

An active policy enforces its identity, allowances, and denials. An empty allow map denies every message destination. The special `"*"` destination grants an action to all chats or all channels. Exact denials override both exact and wildcard allowances. Active policies cannot be deactivated or saved directly through the browser editor. Their fields remain editable so the revised YAML or an atomic elevated shell command can be exported. This makes activation deliberate without claiming that the file itself is immutable on disk.

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
version: 1
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
  chats: {}
  channels: {}
  rawTokenExport: false
deny:
  chats: {}
  channels: {}
```

Each destination maps to one or both actions:

```yaml
allow:
  chats:
    "19:example-chat@thread.v2": [read]
    "*": [read]
  channels:
    "19:example-channel@thread.tacv2": [read, post]
  rawTokenExport: false
deny:
  chats:
    "19:sensitive-chat@thread.v2": [read, post]
  channels: {}
```

`post` does not imply `read`. Wildcards are supported only in `allow`; denials name exact destinations and always take precedence within that policy.

`read` permits `message list/get`; `post` permits `message send` and does not imply read access. Chat/channel discovery, names, participants, teams, and other metadata are deliberately not constrained in this release. A chat entry never permits a channel with the same ID. Set `rawTokenExport: true` only when complete bearer tokens are genuinely required; decoded claims do not need it.

## Browser editor

Start the editor in the current workspace:

```bash
teams-cli --profile personal policy edit
teams-cli --profile personal policy edit --port 58326 --open
```

The CLI tries ports 58326 through 58335 and then an operating-system-assigned port. It binds only to loopback outside containers. In a detected container it binds all interfaces so an explicitly published port can reach it; publish that port only onto a trusted localhost interface.

The printed URL contains a one-time bootstrap token. The page exchanges it for an HttpOnly local session, removes it from the address bar, and connects back to the CLI. Draft saves keep the editor running. Save-and-Activate, Done, Ctrl-C, or closing the last editor connection ends the temporary server. There is no daemon.

The Effective Access tab shows the intersection of active policies. Policy tabs display one-to-one names, returned group participants, and team/channel names. Active or filesystem-read-only policies can be edited in the page, but direct saving remains blocked; export the resulting YAML or copy the displayed atomic elevated apply command. Writable drafts can be saved normally.

The editor is a policy-authoring interface, not a Teams replacement. It has no endpoint or control for reading message contents, starting conversations, or sending messages.

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
teams-cli --profile personal policy check read --chat CHAT_ID
teams-cli --profile personal policy check read --channel CHANNEL_ID
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

The CLI intentionally has no deactivate or remove command. `policy edit` is the browser editor command; it does not make active policies editable. Use `policy show NAME` to obtain the exact file path. If the normal policy loader rejects the store, the editor can still show each malformed file and its validation problem.

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

Policies primarily prevent accidental message disclosure or posts to the wrong destinations. Strong, non-bypassable enforcement requires controls outside the agent process, such as a separate OS identity, read-only container mount, restricted network egress, or server-side Teams permissions.
