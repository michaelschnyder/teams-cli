# Agent skill installation

The npm package contains one `teams-cli` skill that teaches compatible coding agents how to use the CLI safely and effectively. Installing the CLI and this skill is normally enough to begin agent-assisted Teams work.

## Install automatically

```bash
teams-cli skills list
teams-cli skills path
teams-cli skills install
```

Auto-detection supports Codex, Claude Code, Cursor, GitHub Copilot, OpenCode, Windsurf, Gemini CLI, Pi, and generic `.agents/skills` environments. When several environments are detected, the skill is installed into all of them.

The skill covers the default login flow, identity verification, fresh resource discovery, structured output, message reads and sends, cooperative policy checks, and token handling.

## Select a destination

Specify a target when detection is unavailable or when you want to control the destination:

```bash
teams-cli skills install codex
teams-cli skills install github-copilot --project
teams-cli skills install agents --name teams-cli
teams-cli skills install all
teams-cli skills install --dir /custom/skills
```

Use `teams-cli skills install --help` for the current target names and destination options.

## Existing and managed copies

Initial installation does not replace an existing `SKILL.md`; use `--force` only when replacement is intentional. Successful destinations are recorded under `~/.teams-cli/` so managed copies can be refreshed later.

```bash
teams-cli skills reinstall
```

Reinstallation replaces the managed `teams-cli` copy, including local edits made inside it. Older managed Teams skills are consolidated into the current single skill during refresh while unrelated files in their directories are preserved.

Installed skill copies live in agent-specific user or project directories rather than in `~/.teams-cli/`. Uninstalling the npm package does not remove them automatically.
