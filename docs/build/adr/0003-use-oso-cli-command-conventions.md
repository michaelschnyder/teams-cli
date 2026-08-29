# ADR 0003: Use OSO CLI command conventions where semantics match

> Historical note: references to `guardrails.json` describe the original implementation. Subject-path YAML policies now provide destination and token-export controls; see [policies](../../use/policies.md).
>
> Later decision (2026-08-28): [ADR 0005](0005-enforce-subject-path-policies-at-message-boundary.md) supersedes the original JSON guardrail and no-live-write testing rules. [ADR 0004](0004-use-profiles-for-identity-scoped-sessions.md) records profile and identity selection without changing the resource/verb command convention.

- **Status:** Accepted
- **Date:** 2026-08-24
- **Decision owners:** Project maintainers

## Context

This project needs a stable command architecture that remains predictable as chat, channel, message, diagnostic, and possible future discovery capabilities evolve. [OSO's `ms-teams-cli`](https://github.com/osodevops/ms-teams-cli) provides a useful agent-oriented reference: singular resources, verb subcommands, explicit identifiers, structured output, deterministic errors, and a clean stdout/stderr boundary.

The projects are not interchangeable. OSO uses Microsoft Graph and Graph-native authentication, while this CLI uses browser-backed first-party Teams authentication and private Teams services under the constraints described in [ADR 0001](0001-browser-backed-private-teams-api.md) and [ADR 0002](0002-server-backed-chat-and-message-reads.md). Graph also addresses channels through a team hierarchy, whereas the private regional message service accepts a channel's globally unique conversation ID directly.

The comparison was refreshed on 2026-08-24 against OSO's public repository and [command documentation](https://msteamscli.com/). Upstream may change, so future work must verify the current OSO release before treating the command examples in this ADR as exact.

## Decision drivers

- Keep new commands easy to discover for humans and coding agents.
- Reuse established Teams CLI terminology when semantics match.
- Avoid implying drop-in compatibility between different APIs and authentication models.
- Preserve direct channel addressing without unnecessary team identifiers.
- Keep automation output deterministic and diagnostics separate from results.
- Avoid deprecated aliases and compatibility artifacts.
- Prevent OSO feature breadth from weakening this project's write guardrails.

## Decision

Adopt **conceptual compatibility**, not drop-in compatibility, with OSO's command architecture.

### Command grammar

New commands use a singular resource followed by a conventional verb:

```text
teams-cli <singular-resource> <verb> [resource-id] [options]
```

Use resource groups such as `chat`, `channel`, and `message`, with verbs such as `list`, `get`, `send`, `create`, `update`, and `delete`. Do not add shortcut verbs at the root, plural aliases, or deprecated forms for removed commands.

Use positional IDs when a command acts on one unambiguous resource, for example `teams-cli chat get CHAT_ID`. Use explicit target flags when an operation supports several resource kinds, for example `teams-cli message list --chat CHAT_ID` or `teams-cli message list --channel CHANNEL_ID`. Exactly one target is required, and target type is never inferred from an ID suffix.

The executable remains `teams-cli`. Renaming it to OSO's `teams` would create a collision and incorrectly imply interchangeability.

### Current command mapping

| Capability | This CLI | OSO style | Decision |
| --- | --- | --- | --- |
| List chats | `teams-cli chat list` | `teams chat list` | Aligned. |
| Get a chat | `teams-cli chat get CHAT_ID` | `teams chat get CHAT_ID` | Aligned. |
| List channels | `teams-cli channel list` | `teams channel list TEAM_ID` | Keep the team-free form because CSA returns channels across teams. |
| Get a channel | `teams-cli channel get CHANNEL_ID` | `teams channel get TEAM_ID CHANNEL_ID` | Keep direct channel addressing and show team data only as context. |
| List chat messages | `teams-cli message list --chat CHAT_ID` | `teams message list --chat CHAT_ID` | Aligned. |
| List channel messages | `teams-cli message list --channel CHANNEL_ID` | `teams message list --team TEAM_ID --channel CHANNEL_ID` | Keep the team ID unnecessary for the regional conversation API. |
| Get a message | `teams-cli message get MESSAGE_ID --chat CHAT_ID` | `teams message get --chat CHAT_ID --message MESSAGE_ID` | Keep the current positional message ID. |
| Send to a chat | `teams-cli message send --chat CHAT_ID --body TEXT` | Same target pattern | Aligned. |
| Send to a channel | `teams-cli message send --channel CHANNEL_ID --body TEXT` | Adds `--team TEAM_ID` | Keep the simpler direct-channel target. |

### Input conventions

Reuse OSO option names when equivalent functionality is implemented:

- `--body TEXT` for an inline message body;
- piped stdin when `--body` is absent;
- `--page-size NUMBER` for a server-side page size;
- `--cursor CURSOR` for this private API's opaque continuation.

Do not add `--all-pages`, rich content, attachments, replies, reactions, or deletion merely for surface parity. Each capability requires separate private-API validation and safety review.

### Output, status, and errors

Preserve the existing automation boundary: result data goes to stdout, while progress, warnings, and debug information go to stderr. Human commands may show one updating TTY status line; JSON and redirected output must remain free of status UI. Debug output must exclude tokens, headers, request bodies, response bodies, message content, and dynamic conversation identifiers.

OSO's `--output json|human|plain`, TTY output detection, structured success/error envelopes, and categorized exit codes are valid candidates for a future output-contract redesign. If adopted, they must be introduced as one deliberate breaking change. Remove `--json` at the same time rather than retaining it as a compatibility alias. Copy only envelope fields and exit categories with stable, tested semantics in this implementation.

Retain global `--debug` until multiple useful verbosity levels exist. Do not add OSO-style `-v`, `-vv`, and `-vvv` forms solely for cosmetic compatibility.

### Team and channel hierarchy

Team ID and name remain useful channel-discovery context, but a team ID is not a channel-message target, is not required by `channel get`, and must not be added to send guardrails. A future read-only `team list|get` resource may support discovery, but it must not become a prerequisite for channel messaging.

### Authentication

Do not copy OSO's Graph client credentials, delegated scopes, consent URLs, or Graph profile model into the current private-API authentication layer. Reuse only lifecycle ideas that are independent of Graph: visible token status, automatic refresh, clear re-login errors, and secret-safe diagnostics.

### Write safety

OSO parity is never sufficient justification for adding a write command. Every future write must continue to:

- authorize the exact destination through `~/.teams-cli/guardrails.json`;
- fail closed when guardrails cannot be read or validated;
- recheck authorization immediately before an authentication retry;
- avoid retrying after ambiguous network, timeout, or server failures;
- use mock servers for every write test and never test writes against live Teams.

## Consequences

### Positive

- The CLI follows a familiar Teams resource/verb structure without importing Graph constraints.
- Chat and message syntax already aligns closely with OSO.
- Direct channel IDs keep private-API commands and guardrails smaller.
- Future command reviews have an explicit style and safety reference.
- Removing old syntax instead of retaining aliases prevents a growing compatibility layer.

### Negative

- Commands are not drop-in replacements for OSO commands.
- Channel commands intentionally differ because this CLI does not require a team ID.
- A future output-contract change will be breaking if `--json` is replaced.
- OSO documentation cannot be copied without revalidating API and permission assumptions.

## Future change checklist

Before adding or changing a command, verify:

- Does its resource/verb shape match OSO where the semantics are the same?
- Is every syntax difference required by the private Teams API and documented?
- Are identifiers explicit, with no inference or interactive selection?
- Are stdout, stderr, JSON, progress, and debug behavior consistent?
- Are token requirements and refresh behavior declared for the operation?
- For writes, is the exact destination checked before transport and before retry?
- Are all API tests mocked, with no test writes to live Teams?
- Is the change clean, with no deprecated aliases or compatibility artifacts?

## Revisit conditions

Revisit this decision when OSO materially changes its command architecture, this CLI moves to Microsoft Graph, direct channel IDs stop being sufficient for the private API, or a deliberate output-contract redesign is proposed.
