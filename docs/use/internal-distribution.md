# Internal distribution

The examples below use `@internal/teams-cli` as a placeholder for the organization’s configured package name. It provides the same `teams-cli` command and application code as the corresponding public release. Its availability is controlled by an automatic Code Hub verification and promotion pipeline. Internal publication indicates this automated verification and internal ownership, not an additional human review of every release.

## Install

Use the company-supported npm credential bootstrap and user-level scope configuration. Replace `@internal` with the configured package scope and the registry URL with the team's installation endpoint, which can be a group endpoint:

```console
npm config set @internal:registry https://CODE_HUB/api/v4/groups/GROUP_ID/-/packages/npm/ --location=user
npm install --global @internal/teams-cli
teams-cli --version
teams-cli version
```

Set credentials through the established company process, scoped to the registry host/path. Never commit them. A project's `.npmrc` is ignored by global npm installations. Keep the company's default dependency registry/proxy: only the `@internal` package scope needs the internal mapping.

The internal package embeds its installation registry. A conflicting user/global scope mapping prevents CLI update requests. Without a scope mapping, the updater uses the embedded internal endpoint; npm still needs valid credentials. The registry's public forwarding must be disabled. An unavailable internal registry does not cause an update from the personal public package.

## Updates

```console
teams-cli version --upgrade
teams-cli version --json
```

Updates select an exact version from the same internal package and registry. `version` shows the package identity, original build information, and distribution metadata. Background notices remain detached and hourly. Registry/authentication failures leave the installed CLI usable.

Only stable versions are promoted initially. Internal canaries and snapshots are not available; selecting canary currently follows the existing CLI behavior of choosing stable when no canary tag exists. Public canary/snapshot behavior is unchanged.

## Migrate from the public package

Both packages export the same executable, so keep only one globally installed distribution:

```console
npm uninstall --global @michaelschnyder/teams-cli
npm install --global @internal/teams-cli
teams-cli version
```

Do not delete `~/.teams-cli`: existing authentication, profiles, policies, and settings continue to work. Refresh previously managed agent skills using `teams-cli skills reinstall` if needed. The updater never changes the distribution automatically.

To remove the internal installation:

```console
npm uninstall --global @internal/teams-cli
```

## Maintainer setup

See [internal release operations](../releasing-internal.md) in the source repository. Internal endpoint values and credentials are deployment settings, not public source defaults.
