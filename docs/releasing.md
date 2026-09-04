# Releasing

Stable releases, canaries, and snapshots are all published by `.github/workflows/publish-npm.yml` so they share one npm trusted publisher and provenance chain. Stable release tags must exactly equal `v` followed by the version in `package.json`.

## Repository setup

Before the first release:

1. Make the repository public so npm provenance can reference it.
2. Protect `main` and require the CI and CodeQL checks.
3. Enable secret scanning and push protection.
4. Create a GitHub environment named `npm`. Allow tags, `main`, and repository feature branches because the workflow itself restricts each publication mode and snapshot actors.
5. Enable two-factor authentication on the npm maintainer account.

## First publication

npm cannot configure a trusted publisher until the package exists. Bootstrap `0.1.0` once:

1. Create a short-lived granular npm token that can create the public package in the `@michaelschnyder` scope and can bypass publish 2FA for this one automated run.
2. Add it to the protected `npm` environment as `NPM_BOOTSTRAP_TOKEN`.
3. Confirm `npm run check`, `npm test`, `npm run build`, `npm run package:check`, and `npm run package:smoke` pass on a clean checkout.
4. Create and publish the GitHub Release `v0.1.0`.
5. Confirm the workflow and npm provenance succeed.

Immediately afterward, delete the GitHub secret and revoke the npm token.

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

Merging a pull request into `main` publishes one prerelease to the `canary` npm tag after the resulting main-branch CI run passes on Ubuntu, macOS, and Windows. The publishing workflow consumes that successful CI result instead of repeating the operating-system matrix. A direct commit to `main` does not publish. Stable releases and manually requested snapshots run package verification on Ubuntu before publishing. The workflow uses the package version when it is already greater than npm's latest stable release; otherwise it assumes the next patch. Versions include the workflow run, attempt, and source commit, while the package embeds the pull request notes and build provenance.

Install or follow this channel with:

```bash
npm install --global @michaelschnyder/teams-cli@canary
teams-cli version --channel canary
```

## Branch snapshots

Repository contributors with write, maintain, or admin permission can run the publish workflow manually against a repository branch. Fork refs are not accepted. The workflow publishes an immutable `snapshot` prerelease, associates an npm tag with the selected branch, and prints the exact install command in its summary.

Snapshots never update automatically. Testers leave a snapshot by explicitly switching to `stable` or `canary`.
