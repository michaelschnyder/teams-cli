---
name: teams-cli
description: Safe command-line access to Microsoft Teams through teams-cli — sign in and manage profiles and tokens, search people, list chats, channels and messages, and send policy-authorized messages. Use this skill whenever a task touches Microsoft Teams from a terminal, script, or agent loop: reading a conversation, finding a colleague's chat or channel ID, posting an update or reply, checking which identity is signed in, or setting up teams-cli profiles and policies. Use it even when the user never says "teams-cli", and always before sending anything, because a send needs an identity, target, and policy preflight first.
license: MIT
metadata:
  version: "0.1.0"
  author: teams-cli
---

# Teams CLI

`teams-cli` drives Microsoft Teams through a signed-in local Edge or Chrome profile and undocumented Microsoft APIs rather than Microsoft Graph. That makes it powerful and unsupported at the same time, so confirm the user's organization permits it before the first run, and prefer the CLI's own checks over reaching for the underlying HTTP APIs yourself.

Two habits make everything else safe: know which identity you are acting as, and use IDs the CLI just returned rather than IDs you assembled or remembered.

## Orientation

The grammar is always `teams-cli <singular-resource> <verb> [id] [options]`. There are no plural aliases and no root shortcuts, so when a command shape is uncertain, ask the CLI instead of guessing:

```bash
teams-cli --help
teams-cli auth --help      # also: profile, policy, person, chat, channel, message, skills
```

Global flags come before the resource: `--profile <name>`, `--tenant <id>`, `--user <id>`, `--browser <edge|chrome>`, `--debug`.

Pass `--json` on person, chat, channel, and message commands when you will parse the result: stdout carries only data, while progress, warnings, policy notices, and update banners go to stderr. That split is what makes `teams-cli ... --json | jq` safe, so don't merge the two streams.

## Confirm the identity first

Read and write operations act as a real person in a real tenant. Establish which one before doing anything visible:

```bash
teams-cli --profile work auth whoami
```

Sign-in opens a browser and stores identity-scoped tokens plus an isolated browser profile under `~/.teams-cli/`:

```bash
teams-cli --profile work --tenant <tenant-id> auth login
teams-cli --profile work auth refresh            # or: refresh access|skype|chat|search
teams-cli --profile work auth logout
```

Automated login needs `--username` plus `--password-command <absolute-path>`, an executable that prints the password to stdout; the CLI never stores passwords. `--headless` runs it without a visible window. If the tenant requires MFA or conditional access, that is the answer; work within it rather than looking for a way around it.

Profiles are named configuration defaults (tenant, user, browser), not a security boundary. Anything a profile can do, an explicit `--tenant`/`--user` can do too:

```bash
teams-cli profile list
teams-cli profile show work
teams-cli profile save work
teams-cli profile remove work
```

## Find targets before using them

Names are display data. Resolve them to IDs with a fresh lookup, then carry those IDs forward:

```bash
teams-cli --profile work person search "Alice" --json
teams-cli --profile work person get alice@example.com --json
teams-cli --profile work chat list --json
teams-cli --profile work channel list --json
teams-cli --profile work chat get <chat-id> --json
```

`person image <email-or-id>` streams raw image bytes to stdout, so redirect it to a file, or use `--base64` if it has to stay in text. Never let raw bytes land in a terminal or a transcript.

## Read messages

Exactly one of `--chat` or `--channel` is required. The CLI never infers the target kind from an ID's shape, and a chat ID passed as `--channel` is simply wrong rather than auto-corrected:

```bash
teams-cli --profile work message list --chat <chat-id> --json
teams-cli --profile work message list --channel <channel-id> --page-size 50 --json
teams-cli --profile work message get <message-id> --chat <chat-id> --json
```

Pagination is server-driven. When a result carries a cursor, pass it back unchanged with `--cursor`; it is opaque, so don't parse, trim, or rebuild it. `--cursor` and `--page-size` cannot be combined, because the page size was fixed when the cursor was issued. Page size is 1 to 200.

## Send a message

A send is externally visible to real colleagues and cannot be recalled, so it is worth four cheap checks first:

1. `teams-cli --profile work auth whoami` — confirm the sending identity.
2. Resolve the chat or channel from a fresh `chat list` / `channel list`, not from memory.
3. `teams-cli policy show` and `teams-cli policy check send --chat <id>` (or `--channel <id>`).
4. Confirm the exact body and target with the user whenever either is ambiguous, and any time the message goes to a channel or to people who did not ask for it.

Then send plain text to exactly one target:

```bash
teams-cli --profile work message send --chat <chat-id> --body "Hello"
printf '%s' "Hello" | teams-cli --profile work message send --channel <channel-id>
```

Use stdin for multi-line bodies or anything with characters the shell would mangle. The CLI re-checks policy immediately before the request goes out, so a `policy check send` that passed earlier is a preview, not a promise.

## Policies

Policies are optional YAML files under `~/.teams-cli/policies/`. The subject is the canonical absolute path the CLI was invoked from, which means the same identity can be restricted differently per working directory.

Semantics worth knowing before you touch one:

- Every applicable **active** policy must allow an operation. Adding a policy can only narrow access, never widen it.
- **Inactive** policies warn on stderr and explain what they would deny, but don't block. Treat those warnings as a preview of what activation will do.
- Allowlists are exact, case-sensitive IDs. There are no wildcards, and a chat entry never authorizes a channel with the same text.
- A malformed, misnamed, or group/other-writable active policy puts *all* authenticated operations into fail-safe mode, across every subject path. Fail-closed is intentional; fix the file rather than working around it.
- No applicable policy means unrestricted, deliberately. Silence is not a denial.

```bash
teams-cli policy list
teams-cli policy show                       # policies applying to the current path
teams-cli policy show <name>
teams-cli policy show --path /absolute/path
teams-cli policy check send --chat <chat-id>
teams-cli policy check raw-tokens
```

Creating one is a three-step flow, because the CLI deliberately won't grant permissions on its own behalf:

```bash
teams-cli --profile work policy init project-agent \
  --subject '/Users/me/Workspaces/project/**'     # quoted, absolute; created inactive and empty
# then edit ~/.teams-cli/policies/project-agent.yaml and add the exact chat/channel IDs
teams-cli policy activate project-agent
```

Activation is one-way, since the CLI has no deactivate verb, so activate only when the allowlist is what the user actually wants.

## Tokens and secrets

`auth tokens` prints live bearer tokens, and `--decode` prints only JWT claims. Anything that reads a raw token can act as the user outside every check described above:

- Ask for raw tokens only when the user explicitly needs them and policy permits; prefer `--decode` when the question is about claims, scopes, or expiry, since decoding needs no permission.
- Never paste tokens, cookies, or headers into prompts, logs, commit messages, issues, or source files.
- When a policy denies a send or a token export, that denial is the answer. Report it and stop. Calling the Microsoft APIs directly, exporting a token to work around the check, or editing a policy on the user's behalf all defeat the only safety net this CLI has.

`--debug` is safe to suggest for troubleshooting: it prints method, endpoint, status, duration, and retry, and deliberately omits headers, bodies, tokens, and conversation IDs.

## When something fails

- "not logged in" or expired tokens → `auth whoami`, then `auth refresh`, then `auth login` as the last resort.
- A denial naming a policy → `policy show` to see which file and rule matched, and tell the user what would need to change.
- Every authenticated command failing at once → a broken policy store; `policy list` surfaces the parse error.
- Unexpected empty results → confirm the profile and identity with `auth whoami` before assuming the data isn't there.

Deeper background lives with the project: `docs/use/authentication.md`, `docs/use/profiles.md`, and `docs/use/policies.md`.
