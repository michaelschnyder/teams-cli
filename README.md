# teams-cli

A safety-conscious command-line client for persistent Microsoft Teams sessions. It supports multiple tenants and users, named profiles, structured output, agent skills, and optional subject-path policies that constrain message reads, posts, and raw-token export.

> [!WARNING]
> This project relies on undocumented Microsoft Teams behavior and a Microsoft first-party client identity. It is unsupported, may be blocked by tenant policy, and may stop working without notice. Obtain organizational approval before using it, and never run live write tests against a production tenant.

## Requirements

- Node.js 22.20 or newer. Node.js 24 LTS is recommended.
- Microsoft Edge or Google Chrome.
- A Microsoft 365 account with Teams access.

### Install Node.js on Windows

Open PowerShell and install the current Node.js LTS release with Windows Package Manager:

```powershell
winget install --id OpenJS.NodeJS.LTS --exact --source winget
```

Open a new terminal, then verify both tools:

```powershell
node --version
npm --version
```

If `winget` is unavailable, install Microsoft App Installer or use the signed installer from the [Node.js download page](https://nodejs.org/en/download).

### Install Node.js on macOS

With [Homebrew](https://brew.sh/):

```bash
brew install node@24
echo 'export PATH="$(brew --prefix node@24)/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
node --version
npm --version
```

Alternatively, use the signed macOS package from the [Node.js download page](https://nodejs.org/en/download).

### Install Node.js on Linux

Distribution repositories may contain a Node.js version older than this CLI requires. A version manager keeps the runtime separate from system packages. The following follows the [Node.js download guidance](https://nodejs.org/en/download) using `nvm`; inspect downloaded installation scripts before running them:

```bash
curl -o nvm-install.sh https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.7/install.sh
less nvm-install.sh
bash nvm-install.sh
. "$HOME/.nvm/nvm.sh"
nvm install 24
node --version
npm --version
```

Node.js also publishes signed standalone Linux archives on its download page.

## Install teams-cli

Install the command globally:

```bash
npm install --global @michaelschnyder/teams-cli
teams-cli --version
teams-cli --help
```

To try it without a permanent installation:

```bash
npx @michaelschnyder/teams-cli --help
```

If a global install reports a permissions error, use a Node version manager instead of running npm with `sudo`. If installation succeeds but `teams-cli` is not found, run `npm prefix --global` and ensure that npm's global executable directory is on `PATH`.

## Quick start

Interactive login opens a dedicated Edge profile by default:

```bash
teams-cli --profile work --tenant YOUR_TENANT_ID auth login
teams-cli --profile work auth whoami
```

The successful login records the verified tenant, user, and browser in the named profile. Subsequent commands reuse identity-isolated tokens and refresh them from the saved browser state when necessary.

Discover Teams data:

```bash
teams-cli --profile work person search "Alice" --json
teams-cli --profile work chat list --json
teams-cli --profile work channel list --json
teams-cli --profile work message list --chat CHAT_ID --json
```

Send a plain-text message after checking the selected identity and target:

```bash
teams-cli --profile work auth whoami
teams-cli --profile work policy check send --chat CHAT_ID
teams-cli --profile work message send --chat CHAT_ID --body "Hello"
```

Use `--channel CHANNEL_ID` instead of `--chat CHAT_ID` for channel messages. A message body can also be piped on stdin.

## Command overview

```text
teams-cli [--profile NAME] [--tenant ID] [--user ID] [--browser edge|chrome]

version    show the installed version or upgrade it
skills     list, locate, install, and refresh packaged agent skills
auth       login, refresh, whoami, tokens, logout
profile    list, show, save, remove
policy     init, list, show, check, activate, edit
person     search, get, image
chat       list, get
channel    list, get
message    list, get, send
```

Run `teams-cli <command> --help` for complete arguments and options.

### Structured output

Person, chat, channel, and message commands that return data support `--json`. JSON payloads stay on stdout. Progress, warnings, update notices, and sanitized debug output stay on stderr, so scripts can safely pipe stdout.

## Profiles and local state

Profiles provide defaults; global flags override them for one command. When no profile is selected, the profile named `default` is used.

```bash
teams-cli profile list
teams-cli profile show work
teams-cli --tenant TENANT_ID --user USER_ID --browser chrome profile save work
teams-cli profile remove work
```

Configuration, authentication, browser state, policies, update state, and managed skill-installation records live under `~/.teams-cli/`. Secret-bearing files and directories are created with owner-only permissions on supported operating systems.

Run `teams-cli policy edit` from a workspace to start the temporary least-privilege editor. The CLI prints a one-time local URL that can be opened in a normal browser or an AI tool's browser sidebar. The editor discovers names and participants for selection, but it cannot read message contents, initiate chats, or send messages.

## Further documentation

See [profiles and precedence](docs/use/profiles.md) and [authentication and token handling](docs/use/authentication.md).

## Policies

Policies are optional. Inactive policies audit and warn without enforcing; active policies enforce the intersection of all matching subject-path rules. A malformed policy store puts authenticated operations into fail-safe mode. Active policies cannot be deactivated through this CLI.

```bash
teams-cli --profile work policy init project-agent
teams-cli policy show project-agent
teams-cli policy check send --chat CHAT_ID
teams-cli policy activate project-agent
```

Review and edit the generated allowlists before activation. See [workspace policies](docs/use/policies.md) and the [security model](https://github.com/michaelschnyder/teams-cli/blob/main/docs/build/security-model.md).

### Token export

The existing authentication commands can print raw bearer tokens or decoded JWT claims:

```bash
teams-cli --profile work auth tokens
teams-cli --profile work auth token access
teams-cli --profile work auth tokens --decode
```

Applicable active policies can deny raw token export. Treat exported tokens like passwords: another HTTP client can use them outside the CLI's cooperative policy checks. Never paste them into prompts, logs, issues, or source files.

## Agent skills

The npm package includes a `teams-cli` skill that teaches compatible coding agents how to use this CLI safely. Auto-detection supports Codex, Claude Code, Cursor, GitHub Copilot, OpenCode, Windsurf, Gemini CLI, Pi, and generic `.agents/skills` environments.

```bash
teams-cli skills list
teams-cli skills path
teams-cli skills install
```

When several environments are detected, the skill is installed into all of them. Specify a target when detection is unavailable:

```bash
teams-cli skills install codex
teams-cli skills install github-copilot --project
teams-cli skills install agents --name teams-cli
teams-cli skills install all
teams-cli skills install --dir /custom/skills
```

Initial installation does not replace an existing `SKILL.md`; use `--force` when replacement is intentional. Successful destinations are recorded. Installed copies are managed by the CLI and are refreshed by `teams-cli skills reinstall` and after a successful CLI upgrade, replacing local edits in those copies.

## Updates and upgrades

At startup, the CLI may launch a detached npm registry check. It runs at most once per hour, does not delay the command, and stores only timestamps and version numbers. If a newer version is found, a notice is printed to stderr on the next invocation.

Disable checks with either environment variable:

```bash
export NO_UPDATE_NOTIFIER=1
# or
export TEAMS_CLI_DISABLE_UPDATE_CHECK=1
```

Checks are automatically disabled in CI. Upgrade the global npm installation and refresh recorded skills with:

```bash
teams-cli version --upgrade
```

This command updates the global npm package. It does not modify a project-local or one-off `npx` installation.

## Troubleshooting

- `teams-cli: command not found`: check `npm prefix --global` and your `PATH`.
- Browser launch fails: install Edge or Chrome and select it with `--browser edge|chrome`.
- Login succeeds but Teams access fails: confirm that the account has a Teams-enabled Microsoft 365 license.
- Stored identity is rejected: run `auth login` again for the selected tenant, user, and profile.
- An agent environment is not detected: pass its name explicitly to `skills install`.
- Use `--debug` for sanitized request method, endpoint, status, duration, and retry diagnostics. Headers, tokens, cookies, query values, and bodies are not logged.

## Uninstall

Remove the global command:

```bash
npm uninstall --global @michaelschnyder/teams-cli
```

Uninstalling the npm package intentionally leaves authentication and configuration data in `~/.teams-cli/`. Run `auth logout` for each stored identity before uninstalling. Remove `~/.teams-cli/` manually only when you intend to delete every remaining profile, token, browser session, policy, update record, and managed-skill record.

Installed agent skill copies live outside `~/.teams-cli/` and are not deleted automatically.

## Development

```bash
npm install
npm run check
npm test
npm run build
npm run package:check
npm run package:smoke
```

See [CONTRIBUTING.md](https://github.com/michaelschnyder/teams-cli/blob/main/CONTRIBUTING.md), [architecture](https://github.com/michaelschnyder/teams-cli/blob/main/docs/build/architecture.md), [testing](https://github.com/michaelschnyder/teams-cli/blob/main/docs/build/testing.md), and the [release guide](docs/releasing.md).

## License

[MIT](LICENSE)
