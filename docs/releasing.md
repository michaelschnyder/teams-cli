# Releasing

Releases are published from GitHub Releases by `.github/workflows/publish-npm.yml`. The release tag must exactly equal `v` followed by the version in `package.json`.

## Repository setup

Before the first release:

1. Make the repository public so npm provenance can reference it.
2. Protect `main` and require the CI and CodeQL checks.
3. Enable secret scanning and push protection.
4. Create a GitHub environment named `npm`, restrict it to release tags, and add a required reviewer.
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
2. Update this changelog and packaged skill metadata.
3. Merge the release changes through protected `main`.
4. Create and publish a GitHub Release with the exact matching `vX.Y.Z` tag.
5. Verify the workflow, npm package contents, provenance, executable version, and `latest` distribution tag.

Published npm versions are immutable. If a release is defective, fix it in a new version rather than attempting to reuse or overwrite the published version.
