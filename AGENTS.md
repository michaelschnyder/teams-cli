# AGENTS.md

This file provides guidance to coding agents working with code in this repository. The linked project documentation remains authoritative.

## Commands

```bash
npm run dev -- --help          # run the CLI from source (tsx src/cli.ts)
npm run check                  # tsc --noEmit
npm test                       # node --test over test/**/*.test.ts
npm run build                  # clean, tsc, copy skills, sync skill versions, chmod +x
npm run package:check          # validate the npm tarball allowlist, required files, and CLI entrypoint
npm run package:smoke          # install the packed tarball and run it
```

Single test file / single test:

```bash
node --import tsx --test test/policy.test.ts
node --import tsx --test --test-name-pattern "denied" test/policy.test.ts
```

CI runs check, test, build, `npm audit --omit=dev --audit-level=high`, `package:check`, and `package:smoke`. Ubuntu, macOS, and Windows use the latest Node.js LTS through the reusable package-verification workflow. Windows is in the matrix, so path handling must not assume POSIX separators.

"E2E" means two different things here. `test/policy-e2e.test.ts` is a normal offline test (temp storage + loopback server) and runs under `npm test`. Live E2E (`npm run test:e2e`, files `test/e2e/*.e2e.ts`) hits a real Teams tenant: it needs `.env.e2e.local` (copy `.env.e2e.example`), a dedicated test tenant with users Alice and Bob, and a team `teams-cli-e2e` with channels `allowed` and `denied`. Never point it at a personal or production tenant. `npm test` never runs live tests.

## Architecture

The CLI drives Microsoft Teams through **undocumented private APIs** using a Microsoft first-party Teams client identity and a Playwright-driven Edge/Chrome profile for authentication, not Microsoft Graph. See [ADR 0001](docs/build/adr/0001-browser-backed-private-teams-api.md) and [ADR 0002](docs/build/adr/0002-server-backed-chat-and-message-reads.md) for why.

Request pipeline, in order:

1. `config.ts` — resolve profile defaults + global flag overrides into a `RuntimeContext`.
2. `policy.ts` — validate the **whole** policy store, match all policies for the canonical subject path (cwd), intersect active decisions.
3. `storage.ts` — load the identity-keyed session (`sha256(tenantId\0userId)` filename under `~/.teams-cli/auth/`).
4. `data.ts` — `withDataSession` refreshes only the token targets an operation declares (`access` | `skype` | `chat` | `search`), and re-refreshes + retries once on 401/403.
5. `teams-client.ts` — make the actual HTTP call.

Auth stores four credentials: an OAuth access token for the Skype resource, an exchanged Skype token, a chat-service OAuth token, and a search OAuth token (`constants.ts`). `auth.ts`/`oauth.ts`/`teams-auth.ts` acquire them through browser-backed flows and token exchange. Sessions are identity-keyed, while browser state is identity- and browser-keyed. Profiles are configuration selectors: profiles that resolve to the same tenant/user intentionally share the same token session, and profiles that also select the same browser share browser state.

`cli.ts` contains Commander wiring, interactive flows, and render functions exported for testing. `src/commands/` holds handlers that do not touch the data path (`skills`, `version`). `diagnostics.ts` centralizes progress display and sanitized HTTP diagnostics; command-specific prompts, warnings, and notices also use stderr. Command grammar is generally `teams-cli <singular-resource> <verb> [id] [options]`; `teams-cli login` is the documented convenience alias for `teams-cli auth login`. Do not add plural aliases or deprecated forms (ADR 0003). Target kind is never inferred from a chat or channel ID: message reads require exactly one of `--chat` / `--channel`, while message sends require exactly one of `--person` / `--chat` / `--channel`.

`policy-editor.ts` (`teams-cli policy edit`) is a short-lived loopback HTTP + WebSocket server that authors policy files; it authenticates with a per-run token and serves `policy-editor-client.js`. Its authenticated discovery operations go through `withDataSession`. The browser gets policy data and sanitized discovery labels only—never message content—and all validation and atomic writes stay server-side. Active and filesystem-read-only policies cannot be saved directly through the browser editor.

Release-support modules are independent of the data path: `update.ts` (detached hourly npm registry check), `settings.ts` (persistent notification-channel selection), and `skills.ts` + `src/skills/teams-cli/SKILL.md` (the agent skill shipped in the tarball and installed into detected agent environments).

## Invariants

These are the reasons the project exists—do not relax them:

- **Authorize immediately before transport.** `sendMessage` requires and awaits an `authorize()` callback right before the POST, and the retry path re-runs that callback, which re-resolves policy and calls `requireMessageSend` again. Keep the raw POST encapsulated in `sendMessage` and both policy checks in the `message send` action in `cli.ts`. For `--person`, resolve the recipient to stable Microsoft user identifiers before the policy check; do not authorize a mutable email address directly.
- **Any new write capability needs a denied-operation test proving zero network requests occur.** `test/policy-e2e.test.ts` is the pattern: counting loopback server, assert the count stays 0.
- **Fail closed.** One malformed policy file puts all authenticated operations into fail-safe mode. Group/other-writable active policies and policy directories are rejected. No active policy for the path deliberately means unrestricted. There is no CLI deactivate command; active policies must be deactivated through an explicitly authorized manual file edit.
- **Debug output is sanitized.** Never log headers, tokens, cookies, query values, request/response bodies, message content, or conversation IDs. HTTP diagnostics are limited to method, redacted endpoint, status, duration, and attempt; authentication decisions may name token targets but never token values.
- **stdout is data only.** Data and JSON payloads go to stdout; progress, warnings, update notices, and debug output go to stderr.
- Public CLI passwords come only from an explicit `--password-command` helper and are never persisted.

## Conventions

- ESM + `NodeNext`: import local modules with a `.js` extension from `.ts` sources.
- `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` are all on.
- Tests use `node:test` + `node:assert/strict` with temp storage roots (`mkdtemp`), mocked fetch, and loopback servers. No test framework, no fixtures directory.
- Keep command handlers small; put logic in the domain module.
- Package is CLI-only—the internal modules are not supported library exports. `files` in `package.json` ships `dist` plus user docs; `package:check` enforces the package allowlist and required runtime files.
- Non-trivial decisions go in `docs/build/adr/` as a numbered ADR; superseding is recorded in the old ADR's header, not by deleting it.
- One skill, `teams-cli`, covers auth, discovery, reading, sending, and policies. It was merged from four topic skills that each re-stated the same identity and token rules; keep it that way unless it outgrows ~500 lines. `test/skills.test.ts` pins the packaged skill list, so adding a directory under `src/skills/` means updating that assertion.

## Where to look

- `README.md` — current onboarding flow and top-level command reference.
- `docs/build/architecture.md` — the pipeline and separation rules in prose.
- `docs/build/security-model.md`, `docs/build/testing.md` — threat model and test strategy.
- `docs/build/adr/` — why private APIs, server-backed reads, CLI grammar, profiles, and message-boundary policy enforcement.
- `docs/use/{commands,profiles,authentication,policies,agent-skills}.md` — user-facing behavior; these ship in the npm tarball, so changes to commands, flags, precedence, or agent usage belong here too.
- `docs/use/installation.md`, `docs/releasing.md` — installation, upgrades, and the release process.
