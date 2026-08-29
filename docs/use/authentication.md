# Authentication

Login uses a dedicated Edge or Chrome profile and stores the resulting Teams tokens under the verified tenant and user identity.

```bash
teams-cli --tenant TENANT_ID auth login
teams-cli --profile test-alice auth login
teams-cli --profile personal auth whoami
teams-cli --profile personal auth refresh
teams-cli --profile personal auth logout
```

`--user USER_ID` constrains login to the expected Microsoft object ID. The CLI rejects tokens for another tenant or user. The stable session identity is the pair `(tenantId, userId)`; usernames are mutable login hints.

Tokens for different users never share a session file. Browser state is also isolated by tenant, user, and browser. Selecting another browser does not invalidate existing tokens, but that browser needs its own authenticated state when browser-backed token acquisition is required.

Raw bearer tokens remain available:

```bash
teams-cli --profile personal auth tokens
teams-cli --profile personal auth token access
teams-cli --profile personal auth tokens --decode
```

If an active subject policy applies, raw bearer output requires `rawTokenExport: true` in every applicable active policy. Decoded JWT claims remain available. Treat exported tokens like passwords; another HTTP client can use them to bypass cooperative CLI policy checks.
