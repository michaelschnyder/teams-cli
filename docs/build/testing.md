# Testing

## Deterministic tests

Run deterministic checks with:

```bash
npm run check
npm test
npm run build
npm run package:check
npm run package:smoke
```

The default suite uses synthetic tokens, mocked APIs, temporary storage roots, and a loopback HTTP server. Its critical security assertion proves that inactive policies audit without blocking and that an active denying policy makes the real CLI send path produce zero POSTs. It also checks policy intersection, subject globs, permission diagnostics, no-active-policy behavior, raw-token gating, profile precedence, and tenant/user storage isolation.

## End-to-end tests

Live tests are separate from the default suite and must use an independent test tenant. CI can give each test user a separate profile and provide a password through a credential-helper executable:

```bash
teams-cli \
  --profile test-alice \
  --tenant "$TEST_TENANT_ID" \
  auth login \
  --username "$ALICE_USERNAME" \
  --password-command /absolute/path/to/alice-password-helper \
  --headless
```

The helper receives no arguments and writes only the password plus an optional trailing newline to stdout. It is executed directly without a shell, has bounded output and a timeout, and its output is never logged or stored. Use a small wrapper executable when a secret manager requires arguments.

Automated login fails rather than attempting to bypass MFA, conditional access, or unexpected Microsoft login pages. Run it only against dedicated test users and a test tenant. Alice and Bob use different profiles and their token and browser stores are isolated automatically.

### Live configuration

The E2E harness loads secrets directly from the ignored `.env.e2e.local` file. Create it from the checked-in example:

```bash
cp .env.e2e.example .env.e2e.local
chmod 600 .env.e2e.local
```

Fill in only the tenant and login credentials:

```dotenv
TEAMS_CLI_E2E_TENANT_ID=00000000-0000-0000-0000-000000000000
TEAMS_CLI_E2E_ALICE_USERNAME=alice@example.test
TEAMS_CLI_E2E_ALICE_PASSWORD=...
TEAMS_CLI_E2E_BOB_USERNAME=bob@example.test
TEAMS_CLI_E2E_BOB_PASSWORD=...
TEAMS_CLI_E2E_BROWSER=edge
TEAMS_CLI_E2E_HEADLESS=true
```

Each test account needs a Teams-enabled Microsoft 365 license. In the current test tenant, Alice and Bob each have a separate free **Office 365 E3 Developer** license assigned in the Microsoft 365 admin center. Without it, Microsoft login can succeed but the Teams session exchange fails with `UserLicenseNotPresentTrialEligible`. Allow time for a newly assigned license to finish provisioning before running the suite.

The test tenant must contain one team named `teams-cli-e2e`. Both Alice and Bob must be members and able to see two channels named `allowed` and `denied`. Names are fixed test fixtures; no team, channel, or user IDs are configured.

Run:

```bash
npm run test:e2e
```

The harness validates that both passwords were loaded, creates or reuses isolated `e2e-alice` and `e2e-bob` profiles, discovers both channels by team/channel name, creates and activates the test policy, sends an allowed marker that Bob must observe, and proves a denied marker does not appear. Authentication state is cached under the ignored `.e2e/` directory, so valid sessions are reused on later runs. The normal `npm test` suite never executes live Teams tests.

Never run live write tests against a personal or production tenant.
