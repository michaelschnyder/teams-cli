# Architecture

The CLI resolves configuration, validates the complete local policy store, matches all policies for the canonical subject path, intersects active decisions, validates the selected tenant/user identity, loads that identity's token session, refreshes tokens when necessary, and then calls the Teams client.

Profiles and sessions are deliberately separate:

- Profiles are editable YAML defaults.
- Sessions are identity-keyed JSON containing secrets.
- Browser state is identity- and browser-keyed.
- Policies constrain the effective identity and protected capabilities after configuration resolution. Inactive policies audit; active matching policies intersect.

Message authorization occurs inside the exported read and send services immediately before each GET or POST. The lower-level send transport is not exported. Policies are resolved again at the transport boundary, including retries, so a policy change takes effect before network access.

The policy editor is an in-process HTTP/WebSocket server owned by one CLI invocation. Its tolerant inspection path reports individual malformed files without weakening the normal fail-closed loader. The browser receives policy data and sanitized discovery labels only; all validation, concurrency checks, and atomic file writes remain server-side.

The current policy resolver supports path subjects with multiple absolute glob patterns. Its result type and capability checks are kept separate from command parsing so additional machine, user, or organization subjects can later be intersected without changing command semantics.
