# ADR 0007: Limit self-upgrades to verified global npm installations

- **Status:** Accepted
- **Date:** 2026-09-04
- **Decision owners:** Project maintainers

## Context

Version 0.1 offered `teams-cli version --upgrade` by always running `npm install --global`. That behavior was removed during the release-channel work because the running CLI might instead come from a project dependency, npx, a source checkout, or another package manager. Unconditionally creating or replacing a global npm package would change a different installation scope than the one selected by the user.

Stable and canary users who deliberately installed the CLI globally through npm still benefit from a channel-aware upgrade command. npm can report its active global package root, and the installed package has a known local package root, so the CLI can prove this case before making changes.

## Decision

Restore self-upgrade and channel-switch installation only when the running package resolves to `@michaelschnyder/teams-cli` directly below the active npm executable's global package root. Resolve symlinks and require an exact package-root match before invoking any installation command. If npm's root cannot be determined or the paths do not match, fail without running an installer and provide the exact package target for the owning package manager.

Invoke npm without a command shell and install the exact version returned by channel discovery. After installation succeeds, persist an explicit channel change and run managed-skill refresh through the newly installed CLI. Treat a failed skill refresh as a partial failure because the package upgrade has already completed.

`version --upgrade` follows the effective stable or canary channel. Stable selects npm's `latest`; canary selects the newer of `latest` and `canary`. An interactive version check may offer the same operation only after the global npm scope has been verified.

npx executions cannot upgrade themselves or mutate the persistent channel. Snapshot builds remain pinned and reject `version --upgrade`, but a globally installed snapshot may leave the snapshot through an explicit `version --channel stable|canary`. Project dependencies, source checkouts, and installations owned by another package manager must be updated through that package manager and scope.

## Consequences

- Global npm users retain a convenient explicit and interactive upgrade path.
- Project-owned dependency files and non-npm installation scopes are never modified by the CLI.
- Switching channels installs the selected channel before recording it, avoiding settings that claim a channel the installed package did not reach.
- The active npm executable must be the npm installation that owns the global package. Users with mismatched npm executables receive manual guidance instead of an attempted repair.
- Snapshot and npx behavior remains deliberate and predictable.
