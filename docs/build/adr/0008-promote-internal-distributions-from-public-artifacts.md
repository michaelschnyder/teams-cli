# ADR 0008: Promote internal distributions from public artifacts

- **Status:** Accepted
- **Date:** 2026-09-08
- **Decision owners:** Project maintainers
- **Amends:** [ADR 0007](0007-limit-self-upgrades-to-verified-global-npm-installations.md)

## Context

Internal users need an organization-owned scoped package (shown as `@internal/teams-cli` in documentation examples) while development and public publication continue on GitHub/npm. Code Hub package hosting is validated, but native repository mirroring is unavailable. A second application implementation or independently generated release version would introduce drift.

## Decision

Keep generic GitLab automation in the same GitHub source repository and execute it on the internal project's protected main branch. An internal schedule explicitly copies complete main history and stable release tags, using only fast-forward branch updates and immutable tags. It never deletes refs or force-pushes. GitHub changes to this pipeline control subsequent internal runs; this is the chosen trust relationship. GitLab holds the deployment credentials and configuration.

Promote stable public npm artifacts after verifying their Sigstore provenance, expected GitHub workflow identity, release tag, source commit, and archive digest. Repackage only the distribution identity, publication settings, and enumerated installation documentation. Preserve executable bytes, dependency declarations, version, license, and original build information. Require a distribution-aware upstream release as the bootstrap minimum. Internal canaries and snapshots are excluded initially.

Serialize synchronization and promotion. Never replace a published version. Retain a durable receipt connecting the two artifact digests, source commit, transformation revision, and internal pipeline. Recover incomplete publication by validating the existing artifact and finishing its receipt/tag updates. Internal latest follows verified upstream latest without automatic downgrades.

Extend ADR 0007's global-installation proof to the installed manifest's package name. Use npm's user/global configuration for registry lookup and exact-version installation, with a scoped registry argument so dependency routing remains unchanged. Internal manifests pin the installation registry and reject conflicting scope mappings. Updates never switch package identities or fall back to the public package. Cache availability with distribution, registry, channel, and configuration identity; keep registry work in a detached worker for ordinary invocations.

## Consequences

- One application implementation serves both distributions; public npm provenance and release generation remain intact.
- Renamed archives have new digests. Public provenance verifies the input artifact, while the internal receipt records the transformation and resulting artifact.
- Internal runners require outbound access to GitHub, npm, Sigstore trust metadata, and the configured container image/dependency registries.
- The company must disable internal npm forwarding to the public registry and maintain the schedule owner, project token, and runner configuration.
- Runtime distribution metadata is optional for public installations; existing command grammar and Teams policies are unchanged.
