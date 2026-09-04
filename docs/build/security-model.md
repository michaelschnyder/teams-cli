# Security model

The primary protected outcome is preventing an agent or user from accidentally reading or posting Teams messages in the wrong chat or channel.

An applicable active policy can:

- Pin the effective tenant and user.
- Allowlist exact chat and channel IDs independently for message reads and posts.
- Deny raw bearer-token export unless explicitly permitted.

Denied reads and posts are rejected immediately before transport and make zero message GETs or POSTs. Discovery metadata is not a protected read in this policy version. Every `.yaml` file in the policy store is validated before subject matching; one invalid policy puts authenticated operations into fail-safe mode across all subjects. Inactive matches emit audit warnings but do not enforce. Applicable active policies intersect, so every one must permit the operation. If the store is valid, absence of an active policy intentionally means unrestricted use and triggers editor guidance.

The temporary editor binds to loopback outside containers and uses a 256-bit one-time URL token, an HttpOnly SameSite session cookie, CSRF validation, strict Host and Origin validation, request limits, and a restrictive Content Security Policy. It exposes sanitized discovery metadata but never Teams tokens or message contents. Container binding is broader by necessity and must be paired with an explicitly published localhost port.

Activation controls CLI enforcement; it does not claim to lock the file. Owner-read-only mode protects against accidental CLI mutation, while group- or other-writable active policies and policy directories fail closed. Keeping policy files outside the subject path works with workspace-limited agent sandboxes. These measures do not stop a process with the owner's filesystem permissions from replacing the file. Non-bypassable controls require a separate OS identity, a read-only container mount, restricted network egress, least-privilege test users, or server-side Teams permissions.

Passwords are accepted only from an explicit helper during login and are never persisted. Token and browser stores use owner-only permissions where supported. Debug output excludes headers, tokens, cookies, query values, request bodies, and response bodies.

Update checks are advisory and isolated from normal command execution. A detached process contacts only the npm package metadata endpoint at most hourly, uses a short timeout, and writes version-only state atomically with owner-only permissions. Checks are disabled in CI and can be opted out of entirely.

The CLI never invokes a package manager or mutates global or project dependencies. Update notices identify the exact package version and leave installation scope and package-manager behavior under user control. Packaged skills contain instructions and examples but no executable scripts or pre-authorized tools.
