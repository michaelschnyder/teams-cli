# Command examples

The default session created by `teams-cli login` or `teams-cli auth login` is used automatically. The examples on this page do not require a tenant ID or named profile.

## Inspect the installed build

```bash
teams-cli --version
teams-cli version
teams-cli version --json
teams-cli version --upgrade
teams-cli version --channel canary
```

When piped, `--version` prints only semantic version text. In a terminal, version output includes the installed channel, local build provenance, associated release notes, and any available update. A verified global npm installation can accept the interactive update offer or use `version --upgrade`; npx, snapshots, project dependencies, and installations owned by another package manager are not changed automatically. Use an explicit `--channel stable|canary` to replace a global npm installation and persist that channel after installation succeeds. The policy editor shows the same exact version in its footer.

## Diagnose the local setup

```bash
teams-cli doctor
teams-cli doctor --json
```

`doctor` checks local prerequisites, selected identity and session health, managed filesystem skills, and detected agent environments without authenticating, contacting Teams, writing files, or changing permissions. An explicitly requested diagnostic log is the only optional file output. JSON output has a top-level `ok` value and a `checks` array. Claude Cowork installation is account-level and therefore cannot be verified by this command.

## Verify the active identity

```bash
teams-cli auth whoami
```

Verify the identity before reading sensitive content or sending a message. Named profiles and explicit tenant/user selectors are available for deliberate multi-identity workflows; see [profiles](profiles.md).

## Discover people, chats, and channels

```bash
teams-cli person search "Alice" --json
teams-cli person get alice@example.com --json
teams-cli chat search "Alice" --json
teams-cli chat get CHAT_ID --all --json
teams-cli channel list --json
teams-cli channel get CHANNEL_ID --json
```

Discover current identifiers rather than copying stale IDs from logs or old output. Person, chat, and channel metadata is not message content, but it can still be sensitive.

Use `chat search` before `chat list`. Search asks the server for up to 25 ranked people and 25 ranked chats and does not download the complete chat collection. Direct chats that already exist are resolved from matching people, so a participant name or email is usually the best query.

The Teams chat-list endpoint does not provide a reliable page-size limit. In observed large tenants it returned thousands of chats in the first response with no continuation cursor. Both `chat list` and `chat get` use that collection endpoint, so the interactive CLI asks before the initial request. Scripts and agents must acknowledge that cost explicitly with `--all`; the flag acknowledges the possible full response rather than changing what the server returns:

```bash
teams-cli chat list --all --json
teams-cli chat get CHAT_ID --all --json
```

When Teams does provide a continuation cursor, the result includes `page.nextCursor`. Fetch that server-provided next page without repeating `--all`:

```bash
teams-cli chat list --cursor OPAQUE_CURSOR --json
```

The CLI does not simulate local pages or truncate the server response, because doing so would still download the entire collection and could make the result misleading.

Message operations that already have a chat ID do not need you to run `chat list` first. Message reads and sends classify one-to-one chat IDs directly for policy checks and do not silently enumerate the chat collection.

## Read messages

Pass exactly one of `--chat` or `--channel`; the CLI does not infer the target type from an ID.

```bash
teams-cli message list --chat CHAT_ID --json
teams-cli message list --channel CHANNEL_ID --page-size 50 --json
teams-cli message get MESSAGE_ID --chat CHAT_ID --json
```

Pagination cursors are opaque. Pass a returned cursor back unchanged and do not combine `--cursor` with `--page-size`. Page size accepts values from 1 to 200.

## Send a message

Sending is externally visible and the CLI has no delete or undo command. The easiest first message to a person uses their email address:

```bash
teams-cli auth whoami
teams-cli message send --person alice@example.com --body "Hello"
```

Teams represents a one-to-one conversation as a two-person chat: effectively a group chat containing only you and the recipient. `--person` looks up the email address in the current tenant, reuses either valid ID ordering when the direct chat already exists, and starts the conversation when it does not. If the resolved email belongs to another tenant or cannot be verified as a current-tenant member, the interactive CLI asks you to confirm the recipient before sending. For automation where you have already verified the identity, pass the Microsoft user object ID to `--person`.

For an existing group chat or a channel, pass its discovered ID:

```bash
teams-cli message send --chat CHAT_ID --body "Hello everyone"
teams-cli message send --channel CHANNEL_ID --body "Hello channel"
```

Exactly one of `--person`, `--chat`, or `--channel` is accepted by `message send`. A person must be allowed under `allow.people`; group chats and channels use their corresponding policy sections.

Checking a policy decision ahead of time is optional. It can be useful when you already have a chat or channel ID and want to see whether the current policy is likely to allow the send:

```bash
teams-cli policy check send --chat CHAT_ID
teams-cli policy check send --channel CHANNEL_ID
```

The send command enforces the applicable policy whether or not you run this preview. It evaluates policy again immediately before the network request, so a successful `policy check` is a preview, not a promise that a later operation will still be allowed.

Pipe multiline text or text the shell may reinterpret on stdin:

```bash
printf '%s' "Hello from the project team" | teams-cli message send --channel CHANNEL_ID
```

## Structured and binary output

All ordinary result-producing commands support `-o, --output text|json|yaml`. The default is human text when stdout is a terminal and JSON when it is redirected. `--json` is equivalent to `--output json`; combining it with `--output text` or `--output yaml` fails before the operation runs. JSON and YAML contain the same full data, including pagination and target information. Human tables switch to stacked records when the terminal is too narrow to preserve identifiers.

Results stay on stdout. Progress, warnings, diagnostics, and update notices stay on stderr; do not merge the streams when parsing output. JSON and YAML modes suppress routine progress and all interactive prompts. Run `login` explicitly when authentication is needed, acknowledge full chat enumeration with `--all`, and use a previously verified Microsoft object ID for an external recipient in automation.

```bash
teams-cli person search Alice                       # readable output in a terminal
teams-cli person search Alice > people.json          # automatic JSON
teams-cli person search Alice --output text > people.txt
teams-cli profile show --output yaml
teams-cli policy list --json
teams-cli auth whoami --json
```

Auth login, whoami, and refresh results expose token audiences and expiry metadata, never token values. Profiles, policies, skills, and mutation acknowledgements now support structured output too. Existing data-resource JSON retains its resource fields; local lists use `title` and `items`, and acknowledgements include an `action` and operation details.

Explicit exports have these exceptions:

- `person image` defaults to raw bytes on redirected stdout and refuses raw bytes in a terminal. `--base64` emits one base64 line. Explicit `--output json|yaml` (or `--json`) emits `{ contentType, data }`, where `data` is base64; it cannot be combined with `--base64`.
- `auth tokens` keeps its default raw-token output behind the existing policy check. Explicit JSON/YAML produces an object keyed by token target. `--decode` returns decoded claims through the common output formats.
- Redirected `--version` without an explicit output format retains its single semantic-version line. Use `version --json` for structured build information.

```bash
teams-cli person image alice@example.com > alice.jpg
teams-cli person image alice@example.com --base64
teams-cli person image alice@example.com --output json
```

Migration: add `--output text` to any script that previously parsed human text. `profile show` and `policy show` now follow the common output default, so request `--output yaml` explicitly and extract the `policy` field when exporting a named policy for editing. Do not save the entire result object as a policy file. Automatic JSON selection depends on stdout, not stdin; piping a message body into a command with terminal stdout still uses human presentation.

## Help and diagnostics

```bash
teams-cli --help
teams-cli message --help
teams-cli doctor
teams-cli --debug chat search "Project Phoenix" --json
```

Debug output is sanitized and written to stderr. It does not include headers, tokens, cookies, query values, request bodies, or conversation and message identifiers.

### Log controls

`--log error|warn|info|debug|trace` sets terminal verbosity. `-v` selects info, `-vv` debug, and `-vvv` or more trace. Explicit `--log` takes precedence over `--debug`, which takes precedence over `-v`. The default is info for interactive human output and warn for structured or redirected output. `NO_COLOR` disables color; CI and `TERM=dumb` disable animated progress. Prompts and warnings suspend progress so they cannot overwrite each other.

```bash
teams-cli --log debug channel list --json
teams-cli --log-file ./teams-debug.jsonl chat search "Project Phoenix" --json
teams-cli --log error --log-file ./teams-debug.jsonl auth whoami --json
```

`--log-file <path>` appends timestamped JSON Lines diagnostics independently of terminal verbosity. The parent directory must exist. The file records command names without arguments, outcome, elapsed time, sanitized HTTP method/endpoint/status/attempt, and token-refresh targets. It never records tokens, headers, cookies, query values, personal identifiers, message content, raw response bodies, editor access URLs, or arbitrary error messages. No log is created unless requested.

Files are restricted to the owner on POSIX systems; Windows uses the containing directory's ACL. Logging stops at 10 MiB and warns once; archive or remove the file before collecting more diagnostics. A log destination that cannot be opened fails before command execution. A later file error disables file logging and warns once without retrying or changing the operation's result. This is a troubleshooting log, not a record of sent or read messages.
