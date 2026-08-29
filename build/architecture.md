# Architecture

The CLI resolves configuration, validates the complete local policy store, matches all policies for the canonical subject path, intersects active decisions, validates the selected tenant/user identity, loads that identity's token session, refreshes tokens when necessary, and then calls the Teams client.

Profiles and sessions are deliberately separate:

- Profiles are editable YAML defaults.
- Sessions are identity-keyed JSON containing secrets.
- Browser state is identity- and browser-keyed.
- Policies constrain the effective identity and protected capabilities after configuration resolution. Inactive policies audit; active matching policies intersect.

Message authorization occurs inside the exported send service immediately before each POST. The lower-level message transport is not exported. Retries call the same authorized operation again, so policy is resolved and checked for every attempt.

The current policy resolver supports path subjects with multiple absolute glob patterns. Its result type and capability checks are kept separate from command parsing so additional machine, user, or organization subjects can later be intersected without changing command semantics.
