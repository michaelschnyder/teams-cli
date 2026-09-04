---
name: teams-cli
description: Use teams-cli safely for Microsoft Teams authentication, discovery, reading, messaging, and policies.
license: MIT
metadata:
  version: "0.2.0"
  author: teams-cli
---

# Teams CLI

Use `teams-cli` for command-line access to Microsoft Teams through an authenticated local Edge or Chrome session. It uses undocumented Microsoft APIs rather than Microsoft Graph, so confirm that the user's organization permits it before first use.

Act through the CLI instead of calling its underlying APIs directly. Know which identity is active, use targets returned by fresh discovery, and treat policy denials as a stopping condition.

## Start with the default session

The ordinary flow does not need a named profile, tenant ID, or user ID:

```bash
teams-cli login
teams-cli auth whoami
```

On first use, run the top-level `login` command, then use `auth whoami` to verify the signed-in tenant and user. `login` is an alias for `auth login`; the other authentication operations remain under `auth`. Login saves the verified identity and browser in the implicit `default` profile. Use `--profile <name>` only when the user deliberately maintains more than one identity; profiles are configuration defaults, not security boundaries.

Automated login requires `--username` and an absolute `--password-command` executable that prints the password to stdout. Never ask the user to weaken MFA or conditional access, and never store a password in configuration or a command line.

## Discover and read

Resolve display names to current IDs before reading or sending. A first message to a person can use their email address directly. Prefer `--json` when another command or tool will consume the result:

```bash
teams-cli person search "Alice" --json
teams-cli person get alice@example.com --json
teams-cli chat search "Alice" --json
teams-cli channel list --json
```

Always try `chat search <query>` before enumerating chats. The server-backed search is bounded to 25 ranked people and 25 ranked chats, which reduces latency and agent context. The collection endpoint used by `chat list` and `chat get` often returns every chat and offers no reliable page size. Use `chat list --all --json` or `chat get <chat-id> --all --json` only when the user actually needs that lookup and has accepted the possible full response. If a list result contains `page.nextCursor`, pass it back with `chat list --cursor <cursor> --json`; a cursor request does not need `--all`.

When the user already supplied a chat ID for a message operation, use it directly. Do not enumerate chats first; message operations classify direct-chat IDs for policy enforcement without loading the chat collection.

For message operations, pass exactly one of `--chat` or `--channel`; the CLI does not infer the target type from an ID:

```bash
teams-cli message list --chat <chat-id> --json
teams-cli message list --channel <channel-id> --page-size 50 --json
teams-cli message get <message-id> --chat <chat-id> --json
```

Pagination cursors are opaque. Pass a returned cursor back unchanged and do not combine `--cursor` with `--page-size`; page size is 1 to 200.

Machine-readable data stays on stdout while progress, policy notices, diagnostics, and update notices use stderr. Do not merge the streams when parsing JSON. `person image` writes binary data only to redirected stdout and refuses an interactive terminal; use `--base64` when the result must remain text.

## Configure and check policies

Policies are optional YAML files scoped to the canonical working-directory path. An authenticated command with no applicable active policy offers to open the temporary policy editor in an interactive terminal, or warns with the `policy edit` command in a non-interactive session. No active policy means the operation remains unrestricted, so configure least-privilege access before sensitive work:

```bash
teams-cli policy edit
```

The editor discovers people, chats, channels, and identities for selection, but cannot read message contents, start chats, or send messages. It is the normal way to create and refine an inactive policy before activation. Manual `policy init`, YAML editing, and `policy activate` remain available when the editor cannot be used.

Policy decisions have these non-obvious semantics:

- Every applicable active policy must allow the identity and operation; overlapping policies can only preserve or narrow access.
- Inactive policies only warn about what they would deny. Use those warnings to test a draft before activation.
- `read` permits `message list/get`; `post` permits `message send`. Neither implies the other.
- Allows distinguish people, group chats, and channels. An allow entry may use the exact case-sensitive destination ID or `"*"`; denials use exact IDs only and override matching allows.
- A person allow applies to a one-to-one chat resolved to that person. A group-chat entry never authorizes a channel with the same ID.
- Every `.yaml` policy file must parse and match its filename. A malformed or misnamed file fails the policy store closed. An active policy or policy directory writable by group or other users also fails closed.

Inspect effective access and, when useful, preview representative decisions:

```bash
teams-cli policy list
teams-cli policy show
teams-cli policy check read --chat <chat-id>
teams-cli policy check send --channel <channel-id>
teams-cli policy check raw-tokens
```

Activation has no CLI deactivate or remove command, but it is not irreversible: an explicitly authorized manual revision can set `active: false` before editing or delete the exact policy file. The browser editor cannot directly save an active or filesystem-read-only policy; use its exported YAML or generated atomic apply command. Do not widen, deactivate, or remove a policy unless the user explicitly requests that exact change.

## Send intentionally

Sending is externally visible and the CLI has no delete or undo command. If the user's requested body or target is ambiguous, clarify it. Otherwise, verify the identity and rediscover the target. A policy preflight is optional because `message send` always enforces policy immediately before posting:

```bash
teams-cli auth whoami
teams-cli message send --person alice@example.com --body "Hello"
```

`--person` resolves a current-tenant member's email address to the two-person chat. An external or unverifiable email recipient requires terminal confirmation; a previously verified Microsoft user object ID can be passed instead. Use `--chat` for an existing group chat and `--channel` for a channel. When a chat or channel ID is known, `policy check send` can optionally preview the current decision.

Use stdin for multiline bodies or text the shell may reinterpret:

```bash
printf '%s' "Hello" | teams-cli message send --channel <channel-id>
```

The CLI re-evaluates policy immediately before the network request, so a successful preflight is a preview rather than a promise. If the final check denies the operation, report the denial and stop; do not bypass it with raw tokens, direct HTTP calls, or an unrequested policy edit.

## Tokens and troubleshooting

`auth tokens` prints live bearer tokens unless `--decode` is used. Export raw tokens only when the user explicitly requests them and policy permits it. Prefer decoded claims for questions about audiences or expiry, and never paste tokens, cookies, or authenticated headers into prompts, logs, issues, commits, or source files.

For expired credentials, try concrete refresh commands before another interactive login:

```bash
teams-cli auth refresh
teams-cli auth refresh access
```

Use `--debug` for sanitized request diagnostics. It reports methods, redacted endpoints, status, duration, and retries without headers, bodies, tokens, or conversation and message IDs.
