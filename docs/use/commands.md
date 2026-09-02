# Command examples

The default session created by `teams-cli login` or `teams-cli auth login` is used automatically. The examples on this page do not require a tenant ID or named profile.

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

Person, chat, channel, and message data commands support `--json`. JSON payloads stay on stdout. Progress, policy notices, diagnostics, and update notices stay on stderr, so scripts should not merge the streams when parsing output.

`person image` writes binary data only to redirected stdout and refuses an interactive terminal. Use `--base64` when the result must remain text:

```bash
teams-cli person image alice@example.com > alice.jpg
teams-cli person image alice@example.com --base64
```

## Help and diagnostics

```bash
teams-cli --help
teams-cli message --help
teams-cli --debug chat search "Project Phoenix" --json
```

Debug output is sanitized and written to stderr. It does not include headers, tokens, cookies, query values, request bodies, or conversation and message identifiers.
