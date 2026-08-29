# Security policy

## Reporting a vulnerability

Do not open a public issue containing credentials, bearer tokens, tenant data, private Teams content, or an exploitable vulnerability. Report security concerns privately through GitHub's security-advisory feature for `michaelschnyder/teams-cli`. Include the affected version, impact, reproduction steps with synthetic data, and any suggested mitigation.

## Security model

This CLI stores bearer tokens and a dedicated browser profile locally so a Teams session can persist. Those assets are sensitive and are protected with owner-only filesystem permissions where the operating system supports them. Debug logging excludes authentication material and request or response bodies.

Workspace policies are cooperative client-side controls intended to prevent accidental messages and token export. They do not constrain another process running as the same operating-system user, an exported token used by another HTTP client, or a user who can replace the policy files. Stronger enforcement requires operating-system isolation, read-only mounts, restricted network egress, least-privilege Microsoft accounts, or server-side Teams controls.

The CLI uses undocumented Microsoft Teams behavior and a Microsoft first-party client identity. It must not be used to bypass MFA, conditional access, tenant policy, organizational approval, or Microsoft authorization.

The hourly update check contacts only the npm registry, is disabled in CI, and can be disabled with `NO_UPDATE_NOTIFIER=1` or `TEAMS_CLI_DISABLE_UPDATE_CHECK=1`. No telemetry is collected.

Packaged agent skills are instruction files, not executable plugins. Review skills before installing them. The supplied skills do not pre-authorize shell commands and explicitly preserve Teams identity, target, and policy checks.

## Supported versions

Security fixes are provided for the latest published npm version. Upgrade with `teams-cli version --upgrade` or `npm install --global @michaelschnyder/teams-cli@latest`.
