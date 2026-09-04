# ADR 0006: Package the Cowork skill for manual installation

- **Status:** Accepted
- **Date:** 2026-09-04
- **Decision owners:** Project maintainers

## Context

Filesystem-based coding agents can discover a `SKILL.md` installed into a documented local directory. Claude Cowork custom skills instead belong to the user's Claude account and are uploaded through Claude's Customize interface. Claude Desktop detection does not reveal whether Cowork or Skills is enabled, and there is no supported local interface for installing a Cowork skill or verifying its account or organization state.

The canonical `teams-cli` skill also serves several agent harnesses. Forking its operational instructions for Cowork would create behavior and security drift.

## Decision

`teams-cli skills install` treats Cowork as another installation target but stops at the local boundary. It creates a versioned ZIP and tells the user to upload and enable it in Claude. It does not launch Claude, automate its interface, wait for confirmation, inspect Claude state, or record Cowork as installed.

The ZIP contains a small Cowork-specific `SKILL.md` adapter and the packaged canonical skill copied unchanged to `instructions.md`. The adapter links to that supporting file with ordinary Markdown and contains only the execution-boundary guidance Cowork needs. The CLI continues to maintain one canonical set of Teams instructions.

Claude Desktop is detected only as a suggestion signal: `Get-AppxPackage -Name Claude` on Windows, standard application locations on macOS, and the `claude-desktop` executable on Linux. Detection must never be presented as evidence that Cowork, Skills, computer use, or organization permissions are available.

## Consequences

- Cowork users have one additional manual upload and enablement step.
- The CLI can generate the correct artifact without depending on an external archive tool.
- Local diagnostics can report Claude Desktop presence but cannot verify Cowork installation.
- Cowork needs computer use to operate a globally installed Windows CLI through PowerShell because its normal code execution is isolated from the local machine.
- Authentication storage under `.teams-cli` is never part of the ZIP and must not be exposed to Cowork.
