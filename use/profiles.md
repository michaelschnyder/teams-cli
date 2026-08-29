# Profiles

Profiles are named configuration baselines similar to AWS CLI profiles. They do not own tokens and are not security boundaries.

Profiles are stored in `~/.teams-cli/config.yaml`. For example:

```yaml
version: 1
profiles:
  default:
    tenantId: personal-tenant-id
    userId: personal-user-id
    username: me@example.test
    browser: edge
  test-alice:
    tenantId: test-tenant-id
    userId: alice-user-id
    username: alice@example.test
    browser: chrome
```

When neither `--profile` nor `TEAMS_CLI_PROFILE` is provided, the CLI selects the profile named `default` if it exists:

```bash
teams-cli auth whoami
teams-cli message list --chat CHAT_ID
```

Select another profile explicitly without changing the default:

```bash
teams-cli --profile test-alice auth whoami
```

```bash
teams-cli profile list
teams-cli profile show personal
teams-cli --tenant TENANT_ID --user USER_ID --browser chrome profile save personal
teams-cli profile remove personal
```

Login creates or updates the selected profile with the verified tenant, user, username, and browser:

```bash
teams-cli --profile test-alice --tenant TENANT_ID auth login
```

Selection and precedence are:

1. Global command options.
2. `TEAMS_CLI_PROFILE`, `TEAMS_CLI_TENANT`, `TEAMS_CLI_USER`, and `TEAMS_CLI_BROWSER`.
3. The selected profile, or the profile named `default` when none is selected.
4. Built-in defaults such as Edge.

The `default` profile is a selection fallback, not a source of field-by-field inheritance. A named profile does not inherit missing tenant, user, username, or browser fields from `default`; this prevents fields from two identities being combined accidentally. Several profiles may refer to the same tenant/user session. Removing a profile does not remove tokens; use `auth logout` with the corresponding identity for that.

Policies are evaluated after all profile, environment, and flag overrides. Flags can override profile values but cannot weaken an applicable active policy.
