# Releasing

Stable releases, canaries, and snapshots are all published by `.github/workflows/publish-npm.yml` so they share one npm trusted publisher and provenance chain. The workflow run and publication job names automatically identify the channel from the trigger: a published GitHub Release is a release, a successful eligible `main` CI run is a canary, and a manual dispatch is a snapshot. Stable release tags must exactly equal `v` followed by the version in `package.json`.

## Repository setup

Before the first release:

1. Make the repository public so npm provenance can reference it.
2. Protect `main` and require the CI and CodeQL checks.
3. Enable secret scanning and push protection.
4. Create a GitHub environment named `npm`. Allow only the `main` branch and tags matching `v*`. Snapshot dispatches run through the workflow on `main`, validate the requested same-repository branch, and check that the actor has write, maintain, or admin permission before entering the publication steps.
5. Enable two-factor authentication on the npm maintainer account.

## Configure trusted publishing

On npm, configure the package's trusted publisher with:

- Provider: GitHub Actions
- Organization or user: `michaelschnyder`
- Repository: `teams-cli`
- Workflow: `publish-npm.yml`
- Environment: `npm`
- Allowed action: publish

Set package publishing access to require 2FA and disallow tokens. Later workflow runs authenticate with short-lived OIDC credentials and generate provenance automatically.

## Subsequent releases

1. Update `package.json` and `package-lock.json` to the same semantic version.
2. Merge the release changes through protected `main`.
3. Create a GitHub Release with the exact matching `vX.Y.Z` tag and put the release notes in its title and body. These notes are embedded in the package when the release is published.
4. Publish the GitHub Release.
5. Verify the workflow, npm package contents, provenance, executable version, and `latest` distribution tag.

Published npm versions are immutable. If a release is defective, fix it in a new version rather than attempting to reuse or overwrite the published version.

## Canary releases

Merging a pull request into `main` publishes one prerelease to the `canary` npm tag after the resulting main-branch CI run passes on Ubuntu, macOS, and Windows. The publishing workflow consumes that successful CI result instead of repeating the operating-system matrix. A direct commit to `main` does not publish. Stable releases run package verification on Ubuntu without repeating the dependency audit that already gates `main`; manually requested snapshots include the audit because their selected branch might not have passed `main` CI. The workflow uses the package version when it is already greater than npm's latest stable release; otherwise it assumes the next patch. Versions include the workflow run, attempt, and source commit, while the package embeds the pull request notes and build provenance.

Install or follow this channel with:

```bash
npm install --global @michaelschnyder/teams-cli@canary
teams-cli version --channel canary
```

The npm command is useful when installing canary for the first time or upgrading from a release that predates channel switching. Once the channel-aware CLI is installed globally through npm, `version --channel canary` installs the newest canary and records the selection.

## Branch snapshots

Repository contributors with write, maintain, or admin permission can run the publish workflow from `main` and enter a repository branch to snapshot. Manual runs are automatically classified as snapshot publications. The workflow verifies that the requested branch and checked-out commit belong to this repository; fork refs and dispatches using a modified branch workflow are not accepted. It publishes an immutable `snapshot` prerelease, associates an npm tag with the selected branch, and prints exact global-install and npx commands in its summary. Canary summaries provide both commands as well.

Snapshots never update automatically and `version --upgrade` refuses to replace them. Testers with a global npm installation can leave a snapshot explicitly with `version --channel stable` or `version --channel canary`; other installation scopes must use their owning package manager.
