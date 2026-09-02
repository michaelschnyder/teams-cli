# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev -- --help          # run the CLI from source (tsx src/cli.ts)
npm run check                  # tsc --noEmit
npm test                       # node --test over test/**/*.test.ts
npm run build                  # clean, tsc, copy skills, sync skill versions, chmod +x
npm run package:check          # assert the npm tarball excludes src/tests/e2e/workflows
npm run package:smoke          # install the packed tarball and run it
```

Single test file / single test:

```bash
node --import tsx --test test/policy.test.ts
node --import tsx --test --test-name-pattern "denied" test/policy.test.ts
```

CI runs check, test, build, `npm audit --omit=dev --audit-level=high`, `package:check`, and `package:smoke` on Ubuntu/macOS/Windows across Node 22.20 and 24. Windows is in the matrix, so path handling must not assume POSIX separators.

"E2E" means two different things here. `test/policy-e2e.test.ts` is a normal offline test (temp storage + loopback server) and runs under `npm test`. Live E2E (`npm run test:e2e`, files `test/e2e/*.e2e.ts`) hits a real Teams tenant: it needs `.env.e2e.local` (copy `.env.e2e.example`), a dedicated test tenant with users Alice and Bob, and a team `teams-cli-e2e` with channels `allowed` and `denied`. Never point it at a personal or production tenant. `npm test` never runs live tests.

## Architecture

The CLI drives Microsoft Teams through **undocumented private APIs** using a first-party Teams client id and a Playwright-driven Edge/Chrome profile — not Microsoft Graph. See `docs/build/adr/0001` and `0002` for why.

Request pipeline, in order:

1. `config.ts` — resolve profile defaults + global flag overrides into a `RuntimeContext`.
2. `policy.ts` — validate the **whole** policy store, match all policies for the canonical subject path (cwd), intersect active decisions.
3. `storage.ts` — load the identity-keyed session (`sha256(tenantId\0userId)` filename under `~/.teams-cli/auth/`).
4. `data.ts` — `withDataSession` refreshes only the token targets an operation declares (`access` | `skype` | `chat` | `search`), and re-refreshes + retries once on 401/403.
5. `teams-client.ts` — the actual HTTP call.

Auth uses four distinct tokens with different resources (`constants.ts`); `auth.ts`/`oauth.ts`/`teams-auth.ts` acquire them via a browser redirect flow. Everything is identity- and browser-keyed, so two profiles never share tokens or browser state.

`cli.ts` is thin command wiring on Commander; render functions are exported from it for testing. `src/commands/` holds the handlers that don't touch the data path (`skills`, `version`). `diagnostics.ts` owns all stderr output (status, debug, progress) and is where the sanitization rules below are enforced. Command grammar is `teams-cli <singular-resource> <verb> [id] [options]` — no root shortcuts, no plural aliases, no deprecated forms (ADR 0003). Target kind is never inferred from an ID; `--chat` / `--channel` are explicit and exactly one is required.

`policy-editor.ts` (`teams-cli policy edit`) is a short-lived loopback HTTP + WebSocket server that writes policy files; it authenticates with a per-run token and serves `policy-editor-client.js`. It goes through `withDataSession` like any other operation. The browser gets policy data and sanitized discovery labels only — never message content — and all validation and atomic writes stay server-side.

Release-support modules are independent of the data path: `update.ts` (detached hourly npm registry check), `upgrade.ts` (`npm i -g`, no shell), `skills.ts` + `src/skills/teams-cli/SKILL.md` (the agent skill shipped in the tarball and installed into detected agent environments).

## Invariants

These are the reasons the project exists — don't relax them:

- **Authorize immediately before transport.** `sendMessage` calls its `authorize()` callback right before the POST, and the retry path re-resolves policy and calls `requireMessageSend` again (both call sites are in the `message send` action in `cli.ts`). The low-level message transport is not exported so no caller can skip it.
- **Any new write capability needs a denied-operation test proving zero network requests occur.** `test/policy-e2e.test.ts` is the pattern: counting loopback server, assert the count stays 0.
- **Fail closed.** One malformed policy file puts all authenticated operations into fail-safe mode. Group/other-writable active policies are rejected. No active policy for the path deliberately means unrestricted. Active policies cannot be deactivated through this CLI.
- **Debug output is sanitized.** Never log headers, tokens, cookies, query values, request/response bodies, message content, or conversation IDs — only method, endpoint, status, duration, retry.
- **stdout is data only.** JSON payloads on stdout; progress, warnings, update notices, debug on stderr.
- Passwords come only from an explicit `--password-command` helper and are never persisted.

## Conventions

- ESM + `NodeNext`: import local modules with a `.js` extension from `.ts` sources.
- `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` are all on.
- Tests use `node:test` + `node:assert/strict` with temp storage roots (`mkdtemp`), mocked fetch, and a loopback server. No test framework, no fixtures directory.
- Keep command handlers small; put logic in the domain module.
- Package is CLI-only — the internal modules are not supported library exports. `files` in `package.json` ships `dist` plus user docs; `package:check` enforces that.
- Non-trivial decisions go in `docs/build/adr/` as a numbered ADR; superseding is recorded in the old ADR's header, not by deleting it.
- One skill, `teams-cli`, covers auth, discovery, reading, sending, and policies. It was merged from four topic skills that each re-stated the same identity and token rules; keep it that way unless it outgrows ~500 lines. `test/skills.test.ts` pins the packaged skill list, so adding a directory under `src/skills/` means updating that assertion.

## Where to look

- `docs/build/architecture.md` — the pipeline and separation rules in prose.
- `docs/build/security-model.md`, `docs/build/testing.md` — threat model and test strategy.
- `docs/build/adr/000{1..5}` — why private APIs, server-backed reads, CLI grammar, profiles, message-boundary policy enforcement.
- `docs/use/{profiles,authentication,policies}.md` — user-facing behavior; these ship in the npm tarball, so changes to flags or precedence belong here too.
- `docs/releasing.md` — release process.
