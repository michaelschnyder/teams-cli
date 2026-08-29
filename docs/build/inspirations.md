# Inspirations and research

The configuration precedence and named-profile model follow the familiar AWS CLI approach: command options override environment variables, which override the selected profile.

The policy model separates editable configuration from authorization constraints. It is intentionally small: exact resource allowlists, restrictive defaults under an applicable policy, and authorization at the last responsible point before a write.

Project-specific research and decisions remain available in:

- [Research log](../docs/research.md)
- [Browser-backed private Teams API](adr/0001-browser-backed-private-teams-api.md)
- [Server-backed reads](adr/0002-server-backed-chat-and-message-reads.md)
- [CLI command conventions](adr/0003-use-oso-cli-command-conventions.md)
- [Profiles and identity-scoped sessions](adr/0004-use-profiles-for-identity-scoped-sessions.md)
- [Subject-path policy enforcement](adr/0005-enforce-subject-path-policies-at-message-boundary.md)
