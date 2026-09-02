# Authentication

## Default login

Most users need only:

```bash
teams-cli auth login
teams-cli auth whoami
```

Login opens a dedicated Edge profile by default, lets Microsoft handle account selection and any required MFA, and discovers the verified tenant and user from the returned tokens. The CLI stores that identity and browser in the implicit `default` profile, so later commands need no tenant or profile arguments.

`auth whoami` validates the saved session and displays the user, tenant, token audiences, and expiry times. Like other authenticated commands, it may offer to open the policy editor when no active policy applies to the current workspace.

## Session storage and refresh

Teams tokens are stored under the verified `(tenantId, userId)` identity. Tokens for different users never share a session file. Dedicated browser state is also isolated by tenant, user, and browser and does not use the normal browsing profile.

The CLI silently refreshes expiring tokens from the saved browser state when possible. Refresh explicitly with:

```bash
teams-cli auth refresh
teams-cli auth refresh access
```

If Microsoft requires interaction, the CLI stops and asks you to run `teams-cli auth login` again. It does not bypass MFA or conditional access.

Logout removes the selected identity's local Teams tokens and dedicated browser profiles:

```bash
teams-cli auth logout
```

## Advanced identity selection

Explicit tenant, user, and named-profile options are constraints for people who deliberately use more than one identity. They are not required for ordinary login.

```bash
teams-cli --tenant TENANT_ID auth login
teams-cli --tenant TENANT_ID --user USER_ID auth login
teams-cli --profile test-alice auth login
teams-cli --profile test-alice auth whoami
```

`--tenant` constrains login to the expected Microsoft tenant. `--user` additionally constrains it to the expected Microsoft object ID. The CLI rejects tokens that do not match. Usernames are mutable login hints; the tenant/user pair is the stable local session identity.

Selecting another browser with `--browser edge|chrome` does not invalidate existing tokens, but that browser needs its own authenticated state when browser-backed acquisition is required. See [optional profiles](profiles.md) for persistent multi-identity selection.

## Automated login

Automated login requires a username and an absolute executable path that prints the password to stdout:

```bash
teams-cli auth login \
  --username alice@example.com \
  --password-command /absolute/path/to/password-helper \
  --headless
```

The password is bounded in size and is not stored in profile or session configuration. Use this only with dedicated test identities. The flow fails rather than attempting to bypass MFA, conditional access, or an unexpected Microsoft login page.

## Token inspection and export

Decoded JWT claims are safer when only audience, identity, or expiry information is needed:

```bash
teams-cli auth tokens --decode
teams-cli auth token access --decode
```

Without `--decode`, these commands print complete live bearer tokens:

```bash
teams-cli auth tokens
teams-cli auth token access
```

Applicable active policies can deny raw-token export. Treat exported tokens like passwords: another client can use them outside the CLI's cooperative policy checks. Never paste tokens into prompts, logs, issues, or source files.
