# ADR 0008: Separate command results, presentation, and diagnostics

- Status: Accepted
- Date: 2026-09-06

## Context

The main CLI combined registration, interactive authentication recovery, policy orchestration, formatting, and startup. The Teams client combined several resource APIs and normalization rules. Adding output modes or changing progress behavior required edits across command handlers. Diagnostic options and retry attempts were mutable process-wide state.

## Decision

Resource modules under `src/commands/` register commands and return typed result descriptors. `ResultCommand` wraps Commander actions with one invocation runner. It constructs the terminal and diagnostics, validates output and log options before executing the handler, serializes the result once, and closes progress and log resources on completion or failure.

`runtime.ts` resolves authorized sessions and handles interactive recovery using an injected configuration resolver. Domain operations receive sessions and dependencies rather than Commander instances. The transport code is divided into people, chats, channels, and messages, with shared types, transport helpers, and cursors. The internal `teams-client.ts` entrypoint re-exports these implementations; the npm package remains CLI-only.

A result contains safe data and a lazy presenter. JSON and YAML serialize the same data. Presenters choose labels, fields, tables, details, and message layouts; shared renderers own terminal width, Unicode measurement, spacing, and styling. Human presentation is selected for a terminal, and JSON for redirected stdout. `--output text|json|yaml` overrides the default, with `--json` retained as a convenience. Raw token export, image byte/base64 export, and terse redirected `--version` remain explicit exceptions.

Auth session and refresh models are projected into identity and token metadata before reaching the result layer. Stored sessions and token values must never be serialized through ordinary authentication results. Explicit token export remains policy-gated.

The terminal adapter uses Ora for progress, Chalk for styling, and string-width for display measurements. Prompts suspend progress and are unavailable in structured modes. Interactive notices use stderr, while completed result data uses stdout. Long identifiers are preserved; tables switch to stacked records when necessary.

Diagnostics use Consola and an optional JSON Lines file reporter. One allowlist projection runs before either diagnostic sink. Invocation context is injected through `AsyncLocalStorage.run`; retry attempts use immutable child scopes so asynchronous operations cannot overwrite another request's attempt. File output never receives result objects, arbitrary errors, arguments, identities, message bodies, or editor access URLs. It is opt-in, uses restrictive permissions where supported, and stops at 10 MiB with one warning. A file failure after execution begins never retries or changes the result of a Teams operation.

## Security boundaries retained

Both send authorization checks remain in the message command, and the send transport awaits the authorization callback immediately before POST. Retries re-resolve the policy store. Person targets resolve to stable Microsoft identifiers before authorization. Message read callbacks remain at the GET boundary. The policy engine, full-store fail-closed validation, browser authentication, identity/session keys, and editor write protections retain their existing behavior.

## Consequences and migration

Redirected human output is a deliberate compatibility change: scripts that parse text should use `--output text`, and structured consumers should use the documented result objects. Profiles and policies now support the common output formats; use explicit YAML when needed. Structured modes do not offer interactive sign-in, chat enumeration, external-recipient, skill-installation, or upgrade prompts. Explicit operations such as `login`, `--all`, and verified object-ID recipients remain available.

The extra presentation dependencies replace custom spinner and character-width code. There is no full-screen UI, generic plugin framework, or new Teams write capability. Diagnostics are troubleshooting metadata rather than an audit record of message contents.

## Verification

Offline tests cover output selection, JSON/YAML equivalence, safe auth projection, Unicode layouts, log caps and redaction, concurrent invocation/attempt isolation, and zero protected requests on policy denials. Package checks continue to enforce the CLI entrypoint, runtime resources, and tarball allowlist. The existing Ubuntu, macOS, and Windows verification matrix remains required before release.
