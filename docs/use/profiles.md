# Optional profiles

Most users do not need to create or select a named profile. Running `teams-cli auth login` without `--profile` saves the verified tenant, user, username, and browser in the implicit profile named `default`. Later commands use it automatically.

Profiles are useful when you deliberately maintain several Teams identities or browser choices. They are configuration selectors, not token stores or permission boundaries.

## The default profile

```bash
teams-cli auth login
teams-cli auth whoami
teams-cli chat list --json
```

The first command creates or updates `default`. No separate `profile save` command is needed.

Profiles live in `~/.teams-cli/config.yaml`:

```yaml
version: 1
profiles:
  default:
    tenantId: personal-tenant-id
    userId: personal-user-id
    username: me@example.test
    browser: edge
```

## Several identities

Use a named profile when you want another stable selection:

```bash
teams-cli --profile test-alice auth login
teams-cli --profile test-alice auth whoami
teams-cli --profile test-alice chat list --json
```

Login creates or updates the selected profile after Microsoft returns and the CLI verifies the identity. You may supply `--tenant` or `--user` during login when the expected identity must be constrained:

```bash
teams-cli --profile test-alice --tenant TENANT_ID --user USER_ID auth login
```

Manage configured profiles with:

```bash
teams-cli profile list
teams-cli profile show
teams-cli profile show test-alice
teams-cli profile remove test-alice
```

`profile save NAME` is available for saving an already selected and authenticated identity under another name:

```bash
teams-cli --tenant TENANT_ID --user USER_ID profile save work
```

Removing a profile does not remove its tokens or dedicated browser state. Select the corresponding identity and use `auth logout` when those should also be deleted.

## Precedence

Each field resolves independently in this order:

1. Global command options: `--profile`, `--tenant`, `--user`, and `--browser`.
2. Environment variables: `TEAMS_CLI_PROFILE`, `TEAMS_CLI_TENANT`, `TEAMS_CLI_USER`, and `TEAMS_CLI_BROWSER`.
3. The selected profile, or `default` when none is selected.
4. Edge as the browser fallback.

A named profile does not inherit missing tenant, user, username, or browser fields from `default`. This prevents fields from separate identities being combined accidentally. Several profiles may select the same tenant/user session.

Policy evaluation happens after profile and flag resolution. Changing a profile cannot widen an applicable active policy.
