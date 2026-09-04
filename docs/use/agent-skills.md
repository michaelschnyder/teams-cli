# Agent skill installation

The npm package contains one `teams-cli` skill that teaches compatible agents how to authenticate, discover current Teams resources, read and send messages, respect policies, keep structured output separate, and protect tokens.

## First use

Run one command before login:

```bash
teams-cli skills install
```

Auto-detection supports Codex, Claude Code, Cursor, GitHub Copilot, OpenCode, Windsurf, Gemini CLI, Pi, and generic `.agents/skills` environments. When several filesystem environments are detected, the skill is installed into each one. The result is deliberately brief:

- `Installed` means the CLI wrote the packaged skill.
- `Already installed` means the skill was present. If that copy differs, the CLI leaves it untouched and tells you that `--force` is available.
- `Claude Cowork requires one final step` means a ZIP was created for manual upload; it does not mean Cowork has installed it.

After a filesystem installation, switch to your agent and ask naturally, for example:

```text
Send a test message to myself via Teams.
```

The skill tells the agent to check identity and run `teams-cli login` when no valid session exists. You can also continue in the console and run `teams-cli login` yourself.

## Claude Code and Claude Cowork are different

Claude Code reads skills from its local `.claude/skills` directory, so `teams-cli skills install claude-code` can complete that filesystem installation.

Cowork custom skills are attached to the Claude account. If Claude Desktop is detected, the default install also writes `teams-cli-cowork-skill-<version>.zip` to Downloads. Detection only proves that the desktop application appears to exist; it does not prove that Cowork or Skills is enabled. To finish:

1. Open Cowork in Claude Desktop.
2. Go to **Customize > Skills**.
3. Choose **Create skill > Upload a skill** and select the generated ZIP.
4. Enable the `teams-cli` skill, then test it with an explicit Teams request.

This follows Anthropic's [custom skill upload instructions](https://support.claude.com/en/articles/12512180-use-skills-in-claude). The CLI cannot access Claude's private account state, wait for the upload, or verify account or organization permissions. If Skills is absent or disabled, follow Anthropic's troubleshooting guidance or contact the Claude organization owner.

Cowork's normal code execution runs in an isolated cloud environment and cannot reach the local machine or company network directly. To invoke a globally installed Windows CLI, Cowork needs its separate computer-use capability and permission to interact with Windows PowerShell. Anthropic documents the distinction in [Use Claude Cowork safely](https://support.claude.com/en/articles/13364135-use-claude-cowork-safely) and [Let Claude use your computer in Cowork](https://support.claude.com/en/articles/14128542-let-claude-use-your-computer-in-cowork). Availability depends on the Claude plan and organization settings.

Never attach, upload, or grant Cowork access to `.teams-cli`. It contains authentication and dedicated browser state. Computer use should operate the CLI through PowerShell without exposing that directory.

## Advanced skill management

Specify a target when detection is unavailable or when you deliberately want another scope:

```bash
teams-cli skills install codex
teams-cli skills install claude-code
teams-cli skills install claude-cowork
teams-cli skills install github-copilot --project
teams-cli skills install all
teams-cli skills install --dir /custom/skills
```

`--dir` is the skill parent directory for filesystem targets and the ZIP output directory for `claude-cowork`. `--name teams-cli` is available for automation. Use `teams-cli skills list`, `teams-cli skills path`, and `teams-cli skills install --help` when inspecting or scripting the available targets; they are not required during normal first use.

Filesystem destinations that the CLI successfully installed or found content-equivalent, allowing line-ending differences, are recorded under `~/.teams-cli/`. Cowork ZIP creation is never recorded as an installation. Refresh recorded filesystem copies after upgrading:

```bash
teams-cli skills reinstall
```

Reinstallation replaces managed copies, including local edits. Older managed Teams skills are consolidated into the current single skill while unrelated files are preserved. Installed skill copies live outside `~/.teams-cli/` and are not deleted when the npm package is uninstalled.
