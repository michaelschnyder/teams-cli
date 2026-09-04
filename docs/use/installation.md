# Installation and upgrades

## Requirements

- Node.js 22.20 or newer. Node.js 24 LTS is recommended.
- Microsoft Edge or Google Chrome.
- A Microsoft 365 account with Teams access.

## Install Node.js on Windows

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

## Install Node.js on macOS

With [Homebrew](https://brew.sh/):

```bash
brew install node@24
echo 'export PATH="$(brew --prefix node@24)/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
node --version
npm --version
```

Alternatively, use the signed macOS package from the [Node.js download page](https://nodejs.org/en/download).

## Install Node.js on Linux

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
npx --prefer-online @michaelschnyder/teams-cli@latest --help
```

If a global install reports a permissions error, use a Node version manager instead of running npm with `sudo`. If installation succeeds but `teams-cli` is not found, run `npm prefix --global` and ensure that npm's global executable directory is on `PATH`.

Continue with the [quick start](../../README.md#quick-start).

## Updates and upgrades

At startup, the CLI may launch a detached npm registry check. It runs at most once per hour, does not delay the command, and stores only timestamps, the selected channel, version numbers, and a short public release summary. If a newer version is found, a notice appears on the next invocation.

Stable installations follow npm's `latest` tag. Switch to builds produced from newly merged pull requests with:

```bash
npm install --global @michaelschnyder/teams-cli@canary
teams-cli version --channel canary
```

The npm command replaces the globally installed package, while the CLI command records which channel should be checked for update notifications in `~/.teams-cli/settings.yaml`. Switch back in the same way:

```bash
npm install --global @michaelschnyder/teams-cli@latest
teams-cli version --channel stable
```

`TEAMS_CLI_UPDATE_CHANNEL=stable|canary` overrides the recorded channel for the current process. Channel settings are user-wide and deliberately separate from Teams profiles and workspace policies.

Contributor snapshots are installed using the exact version shown by their GitHub Actions run. Snapshots are pinned and do not perform background update checks. Replace a snapshot explicitly through the same package manager and installation scope that installed it, then select `stable` or `canary` for future notifications.

Disable checks with either environment variable:

```bash
export NO_UPDATE_NOTIFIER=1
# or
export TEAMS_CLI_DISABLE_UPDATE_CHECK=1
```

Checks are automatically disabled in CI and temporary npx executions. Inspect local build provenance and any associated release notes with `teams-cli version`, or use `teams-cli version --json` for structured output.

The CLI does not run npm or change global or project dependencies itself, because it cannot reliably determine the package manager and installation scope that installed it. Update notices provide an exact package target. Use `npm install --global` only for an existing global npm installation; for a project dependency, update it through that project's package manager instead. Refresh recorded agent-skill copies separately with `teams-cli skills reinstall` after replacing the package.

An npx execution cannot change the persistent notification channel. Request the desired package explicitly instead:

```bash
npx --prefer-online @michaelschnyder/teams-cli@latest --help
npx --prefer-online @michaelschnyder/teams-cli@canary --help
```

## Troubleshooting

- `teams-cli: command not found`: check `npm prefix --global` and your `PATH`.
- Browser launch fails: install Edge or Chrome and select one with `--browser edge|chrome`.
- Login succeeds but Teams access fails: confirm that the account has a Teams-enabled Microsoft 365 license.
- Stored identity is rejected: run `teams-cli login` again.
- An agent environment is not detected: pass its name explicitly to `teams-cli skills install`.
- Use `--debug` for sanitized request method, endpoint, status, duration, and retry diagnostics. Headers, tokens, cookies, query values, and bodies are not logged.

## Uninstall

Remove the global command:

```bash
npm uninstall --global @michaelschnyder/teams-cli
```

Uninstalling the package intentionally leaves authentication and configuration data under `~/.teams-cli/`. Run `teams-cli auth logout` first if you want to remove the selected identity's saved tokens and dedicated browser profile. Remove `~/.teams-cli/` manually only when you intend to delete every remaining profile, token, browser session, policy, update record, and managed-skill record.

Installed agent-skill copies live outside `~/.teams-cli/` and are not deleted automatically.
