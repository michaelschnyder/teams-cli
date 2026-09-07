import { Option } from "commander";
import { ResultCommand as Command } from "../command-runner.js";
import { commandResult, rawResult, type CommandResult } from "../output.js";
import { resolveUpdateChannel, saveUpdateChannel, type UpdateChannel } from "../settings.js";
import { storagePaths } from "../storage.js";
import { currentTerminal, notice } from "../terminal.js";
import { checkForUpdate, isNpxExecution, latestForChannel, updateChecksDisabled, type UpdateCandidate } from "../update.js";
import { canUpgradeCli, upgradeCli } from "../upgrade.js";
import { BUILD_INFO, CLI_VERSION, PACKAGE_NAME, type BuildInfo } from "../version.js";

export type VersionCommandOptions = {
  output?: "text" | "json" | "yaml";
  storageRoot?: string;
  confirm?: (question: string) => Promise<boolean>;
  fetcher?: typeof fetch;
  environment?: NodeJS.ProcessEnv;
  stdout?: Pick<NodeJS.WriteStream, "write"> & { isTTY?: boolean; };
  stderr?: Pick<NodeJS.WriteStream, "write"> & { isTTY?: boolean; };
  buildInfo?: BuildInfo;
  canUpgrade?: () => Promise<boolean>;
  upgrader?: typeof upgradeCli;
};

async function versionDetails(options: VersionCommandOptions & {
  json?: boolean;
  allowPrompt?: boolean;
}): Promise<CommandResult> {
  const environment = options.environment ?? process.env;
  const buildInfo = options.buildInfo ?? BUILD_INFO;
  const paths = storagePaths(options.storageRoot);
  const channel = await resolveUpdateChannel({ paths, environment, installedChannel: buildInfo.channel });
  const npx = isNpxExecution(environment);
  let candidate: UpdateCandidate | null = null;
  let updateStatus: "available" | "current" | "pinned" | "npx" | "disabled" | "unavailable" = "current";
  if (buildInfo.channel === "snapshot") updateStatus = "pinned";
  else if (npx) updateStatus = "npx";
  else if (updateChecksDisabled(environment)) updateStatus = "disabled";
  else {
    try {
      candidate = await checkForUpdate(buildInfo.version, channel, options.fetcher);
      updateStatus = candidate ? "available" : "current";
    } catch {
      updateStatus = "unavailable";
    }
  }
  if (updateStatus === "pinned") notice("Snapshot builds are pinned. Replace this build explicitly through your package manager to leave the snapshot.\n");
  if (updateStatus === "npx") notice("This temporary npx execution manages its version through the package spec, not the CLI updater.\n");
  if (updateStatus === "unavailable") notice("The npm registry could not be checked; installed build information is still complete.\n");
  if (candidate && currentTerminal()?.interactive && options.allowPrompt && options.confirm && await (options.canUpgrade ?? canUpgradeCli)() &&
    await currentTerminal()!.suspend(() => options.confirm!(`Install teams-cli ${candidate.version}?`))) {
    notice(`Upgrading teams-cli to ${candidate.version} through npm…\n`);
    await (options.upgrader ?? upgradeCli)({ targetVersion: candidate.version });
    return commandResult("ack", { action: "Upgraded teams-cli and recorded skill installations", version: candidate.version });
  }
  return commandResult("version", { installed: buildInfo, updateChannel: channel, update: { status: updateStatus, candidate } });
}

async function changeChannel(channel: UpdateChannel, options: VersionCommandOptions): Promise<CommandResult> {
  const environment = options.environment ?? process.env;
  if (isNpxExecution(environment)) {
    throw new Error(
      `Cannot switch an installation channel from npx. Run \`npx --prefer-online ${PACKAGE_NAME}@${channel === "stable" ? "latest" : "canary"} --version\` instead.`,
    );
  }
  const paths = storagePaths(options.storageRoot);
  const candidate = await latestForChannel(channel, options.fetcher);
  notice(`Switching teams-cli to ${channel} (${candidate.version})…\n`);
  await (options.upgrader ?? upgradeCli)({
    targetVersion: candidate.version,
    onInstalled: () => saveUpdateChannel(paths, channel),
  });
  return commandResult("ack", { action: "Changed update channel", channel, version: candidate.version });
}

async function upgradeCurrent(options: VersionCommandOptions): Promise<CommandResult> {
  const environment = options.environment ?? process.env;
  if (isNpxExecution(environment)) {
    throw new Error(
      `Cannot upgrade a temporary npx execution. Run \`npx --prefer-online ${PACKAGE_NAME}@latest --version\` instead.`,
    );
  }
  const buildInfo = options.buildInfo ?? BUILD_INFO;
  if (buildInfo.channel === "snapshot") {
    throw new Error("Snapshot builds are pinned. Use `teams-cli version --channel stable` or `--channel canary` to leave this snapshot.");
  }
  const paths = storagePaths(options.storageRoot);
  const channel = await resolveUpdateChannel({ paths, environment, installedChannel: buildInfo.channel });
  const candidate = await latestForChannel(channel, options.fetcher);
  notice(`Upgrading teams-cli on ${channel} to ${candidate.version}…\n`);
  await (options.upgrader ?? upgradeCli)({ targetVersion: candidate.version });
  return commandResult("ack", { action: "Upgraded teams-cli and recorded skill installations", version: candidate.version });
}

export function registerVersionCommand(program: Command, options: VersionCommandOptions = {}): void {
  program.command("version").configureRunner({ ...(options.stdout ? { stdout: options.stdout } : {}), ...(options.stderr ? { stderr: options.stderr } : {}), ...(options.environment ? { environment: options.environment } : {}) })
    .description("Show build provenance, manage the update channel, or upgrade a global npm installation")
    .option("--upgrade", "Install the newest version from the effective channel")
    .addOption(new Option("--channel <channel>", "Switch a global npm installation channel").choices(["stable", "canary"]))
    .option("--json", "Output structured build and update information")
    .action(async (commandOptions: { upgrade?: boolean; channel?: UpdateChannel; json?: boolean; }) => {
      if (commandOptions.channel && commandOptions.upgrade) throw new Error("--channel already installs the newest version and cannot be combined with --upgrade");
      if (commandOptions.channel) return changeChannel(commandOptions.channel, options);
      if (commandOptions.upgrade) return upgradeCurrent(options);
      return versionDetails({ ...options, json: commandOptions.json === true, allowPrompt: true });
    });
}

export async function showAdaptiveVersion(options: VersionCommandOptions = {}): Promise<CommandResult> {
  const stdout = options.stdout ?? process.stdout;
  if (!stdout.isTTY && !options.output) {
    return rawResult(Buffer.from(`${options.buildInfo?.version ?? CLI_VERSION}\n`));
  }
  return versionDetails({ ...options, allowPrompt: true });
}
