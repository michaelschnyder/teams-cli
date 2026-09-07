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

The published package has a CLI-only interface. Domain services for authentication, storage, policy evaluation, and Teams requests are internal modules rather than supported library exports. Release-support modules independently own package version discovery, advisory update state, scope-verified global npm upgrades, and managed agent-skill installations.

Builds clean `dist` before compiling and then copy declarative skill resources. Tests are compiled only at runtime by the test runner and never enter the npm tarball. Package validation rejects source, tests, E2E configuration, internal build notes, and workflow files.

## Command execution and presentation

The entrypoint registers resource modules and startup behavior. Each action returns a result descriptor through `ResultCommand`. The invocation runner validates output options and optional log-file availability before calling the handler, then renders exactly one result and clears progress on every completion path. Configuration and authenticated session recovery live in `runtime.ts`; Commander stays in the command layer.

Safe result models in `results.ts` and lazy presenters keep JSON/YAML independent of display layout. The terminal adapter handles prompts and Ora status updates; the renderer uses Unicode display width and switches wide tables to stacked records. Auth projectors deliberately exclude stored token values. Explicit raw exports bypass ordinary serialization only after their existing policy checks.

Diagnostics are scoped with AsyncLocalStorage to the invocation and immutable child attempt contexts. The optional file sink receives only projected diagnostic events, independently of terminal log level. Editor discovery inherits the diagnostic scope while keeping concurrent retry state separate; editor access links are terminal-only notices. See [ADR 0008](adr/0008-separate-command-results-presentation-and-diagnostics.md).
