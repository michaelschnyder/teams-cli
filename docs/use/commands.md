# Command examples

The default session created by `teams-cli auth login` is used automatically. The examples on this page do not require a tenant ID or named profile.

## Verify the active identity

```bash
teams-cli auth whoami
```

Verify the identity before reading sensitive content or sending a message. Named profiles and explicit tenant/user selectors are available for deliberate multi-identity workflows; see [profiles](profiles.md).

## Discover people, chats, and channels

```bash
teams-cli person search "Alice" --json
teams-cli person get alice@example.com --json
teams-cli chat list --json
teams-cli chat get CHAT_ID --json
teams-cli channel list --json
teams-cli channel get CHANNEL_ID --json
```

Discover current identifiers rather than copying stale IDs from logs or old output. Person, chat, and channel metadata is not message content, but it can still be sensitive.

## Read messages

Pass exactly one of `--chat` or `--channel`; the CLI does not infer the target type from an ID.

```bash
teams-cli message list --chat CHAT_ID --json
teams-cli message list --channel CHANNEL_ID --page-size 50 --json
teams-cli message get MESSAGE_ID --chat CHAT_ID --json
```

Pagination cursors are opaque. Pass a returned cursor back unchanged and do not combine `--cursor` with `--page-size`. Page size accepts values from 1 to 200.

## Send a message

Sending is externally visible and the CLI has no delete or undo command. Verify the identity and target, then preview the policy decision:

```bash
teams-cli auth whoami
teams-cli policy check send --chat CHAT_ID
teams-cli message send --chat CHAT_ID --body "Hello"
```

Use `--channel CHANNEL_ID` for a channel. Pipe multiline text or text the shell may reinterpret on stdin:

```bash
printf '%s' "Hello from the project team" | teams-cli message send --channel CHANNEL_ID
```

The CLI evaluates policy again immediately before the network request. A successful `policy check` is a preview, not a promise that a later operation will still be allowed.

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
teams-cli --debug chat list --json
```

Debug output is sanitized and written to stderr. It does not include headers, tokens, cookies, query values, request bodies, or conversation and message identifiers.
