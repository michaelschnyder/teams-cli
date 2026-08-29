# Security model

The primary protected outcome is preventing an agent or user from accidentally sending a Teams message to the wrong chat or channel.

An applicable active policy can:

- Pin the effective tenant and user.
- Allowlist exact chat and channel IDs for sending.
- Deny raw bearer-token export unless explicitly permitted.

Denied sends are rejected immediately before transport and make zero message POSTs. Every `.yaml` file in the policy store is validated before subject matching; one invalid policy puts authenticated operations into fail-safe mode across all subjects. Inactive matches emit audit warnings but do not enforce. Applicable active policies intersect, so every one must permit the operation. If the store is valid, absence of an active policy for the current path intentionally means unrestricted use.

Activation controls CLI enforcement; it does not claim to lock the file. Owner-read-only mode protects against accidental CLI mutation, while group- or other-writable active policies and policy directories fail closed. Keeping policy files outside the subject path works with workspace-limited agent sandboxes. These measures do not stop a process with the owner's filesystem permissions from replacing the file. Non-bypassable controls require a separate OS identity, a read-only container mount, restricted network egress, least-privilege test users, or server-side Teams permissions.

Passwords are accepted only from an explicit helper during login and are never persisted. Token and browser stores use owner-only permissions where supported. Debug output excludes headers, tokens, cookies, query values, request bodies, and response bodies.

Update checks are advisory and isolated from normal command execution. A detached process contacts only the npm package metadata endpoint at most hourly, uses a short timeout, and writes version-only state atomically with owner-only permissions. Checks are disabled in CI and can be opted out of entirely.

The self-upgrade command invokes npm directly without a shell. It refreshes only skill destinations recorded by earlier successful CLI-managed installations. Packaged skills contain instructions and examples but no executable scripts or pre-authorized tools.
