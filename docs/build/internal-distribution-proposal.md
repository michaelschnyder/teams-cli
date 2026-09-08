# Internal distribution decision

The implementation follows [ADR 0008](adr/0008-promote-internal-distributions-from-public-artifacts.md). Internal npm hosting and the registry convention have been team-validated. Endpoints, project IDs, and the configured package scope are deployment inputs; documentation uses `@internal/teams-cli` as a placeholder.

GitHub and public npm remain authoritative. A scheduled GitLab pipeline in the internal project explicitly synchronizes main and stable release tags, then promotes verified public npm artifacts under the internal package name. Native GitLab synchronization is unavailable and is not used. Both distributions keep the same version, executable, dependencies, and compiled application.

Promotion verifies provenance, release identity, source references, and package contents. Durable receipts bind internal packages to their public origin and allow interrupted runs to resume without overwriting releases. The updater uses the installed package's registry, preserves global-installation checks, and never switches distributions automatically.

## Alternatives considered

| Alternative | Reason for choosing artifact promotion instead |
| --- | --- |
| Proxy the public package | Retains the personal package identity. |
| Internal wrapper | Adds installation and update indirection. |
| Independent internal build | Produces another compiled artifact to maintain and verify. |
| Publish internally from GitHub | Requires public CI to hold internal publication credentials and reach the internal registry. |

## Implementation and rollout

Use [internal release operations](../releasing-internal.md) for bootstrap, credentials, runner requirements, scheduling, and recovery. Use the [internal installation guide](../use/internal-distribution.md) for registry setup and migration while preserving `~/.teams-cli`.

Release the distribution-aware public implementation first and use that version as the internal bootstrap minimum. Validate synchronization and promotion in a disposable internal project, then verify installation and an upgrade before enabling the five-minute production schedule. Promotion is stable-only; internal canaries, snapshots, automatic rollback, and dependency mirroring are outside this implementation.
