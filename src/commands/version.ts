import type { Command } from "commander";
import { Option } from "commander";
import { stripVTControlCharacters } from "node:util";
import { storagePaths } from "../storage.js";
import { resolveUpdateChannel, saveUpdateChannel, type UpdateChannel } from "../settings.js";
import { checkForUpdate, isNpxExecution, latestForChannel, updateChecksDisabled, type UpdateCandidate } from "../update.js";
import { canUpgradeCli, upgradeCli } from "../upgrade.js";
import { BUILD_INFO, CLI_VERSION, PACKAGE_NAME, type BuildInfo } from "../version.js";

export type VersionCommandOptions = {
  storageRoot?: string;
  confirm?: (question: string) => Promise<boolean>;
  fetcher?: typeof fetch;
  environment?: NodeJS.ProcessEnv;
  stdout?: Pick<NodeJS.WriteStream, "write"> & { isTTY?: boolean };
  stderr?: Pick<NodeJS.WriteStream, "write"> & { isTTY?: boolean };
  buildInfo?: BuildInfo;
  canUpgrade?: () => Promise<boolean>;
  upgrader?: typeof upgradeCli;
};

function safe(value: string): string {
  return stripVTControlCharacters(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

export function renderVersion(
  info: BuildInfo,
  channel: UpdateChannel,
  candidate: UpdateCandidate | null,
  updateStatus: "available" | "current" | "pinned" | "npx" | "disabled" | "unavailable" = candidate ? "available" : "current",
): string {
  const lines = [
    `Version: ${info.version}`,
    `Build channel: ${info.channel}`,
    `Update channel: ${channel}`,
  ];
  if (info.builtAt) lines.push(`Built: ${safe(info.builtAt)}`);
  if (info.source?.author) lines.push(`Source author: ${safe(info.source.author)}`);
  if (info.trigger?.actor) lines.push(`Workflow actor: ${safe(info.trigger.actor)}`);
  if (info.source?.branch) lines.push(`Branch: ${safe(info.source.branch)}`);
  if (info.source?.commit) lines.push(`Commit: ${safe(info.source.commit)}${info.source.commitUrl ? ` (${safe(info.source.commitUrl)})` : ""}`);
  if (info.source?.pullRequest) lines.push(`Pull request: #${info.source.pullRequest}${info.source.pullRequestUrl ? ` (${safe(info.source.pullRequestUrl)})` : ""}`);
  if (info.runner) {
    const runner = [info.runner.name, info.runner.os, info.runner.architecture].filter(Boolean).map((part) => safe(String(part))).join(" / ");
    if (runner) lines.push(`Runner: ${runner}`);
  }
  if (info.workflow?.url) lines.push(`Workflow: ${safe(info.workflow.url)}`);
  if (info.releaseNotes) {
    lines.push("", `Release notes: ${safe(info.releaseNotes.title)}`);
    if (info.releaseNotes.body.trim()) lines.push(safe(info.releaseNotes.body.trim()));
    if (info.releaseNotes.url) lines.push(safe(info.releaseNotes.url));
  }
  if (candidate) {
    lines.push("", `Update available: ${info.version} → ${candidate.version}`);
    if (candidate.summary?.title) lines.push(safe(candidate.summary.title));
    if (candidate.summary?.summary) lines.push(safe(candidate.summary.summary));
    if (candidate.summary?.url) lines.push(safe(candidate.summary.url));
    lines.push(
      `For a global npm installation, run \`teams-cli version --upgrade\`. Otherwise update through the package manager and installation scope that installed the CLI, targeting ${PACKAGE_NAME}@${candidate.version}.`,
    );
  } else if (updateStatus === "current") {
    lines.push("", "No update is currently available.");
  }
  return `${lines.join("\n")}\n`;
}

async function versionDetails(options: VersionCommandOptions & {
  json?: boolean;
  allowPrompt?: boolean;
}): Promise<void> {
  const environment = options.environment ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
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
  if (options.json) {
    stdout.write(`${JSON.stringify({ installed: buildInfo, updateChannel: channel, update: { status: updateStatus, candidate } }, null, 2)}\n`);
    return;
  }
  stdout.write(renderVersion(buildInfo, channel, candidate, updateStatus));
  if (updateStatus === "pinned") stderr.write("Snapshot builds are pinned. Replace this build explicitly through your package manager to leave the snapshot.\n");
  if (updateStatus === "npx") stderr.write("This temporary npx execution manages its version through the package spec, not the CLI updater.\n");
  if (updateStatus === "unavailable") stderr.write("The npm registry could not be checked; installed build information is still complete.\n");
  if (candidate && options.allowPrompt && options.confirm && await (options.canUpgrade ?? canUpgradeCli)() &&
    await options.confirm(`Install teams-cli ${candidate.version}?`)) {
    stderr.write(`Upgrading teams-cli to ${candidate.version} through npm…\n`);
    await (options.upgrader ?? upgradeCli)({ targetVersion: candidate.version });
    stdout.write("teams-cli and recorded skill installations are up to date.\n");
  }
}

async function changeChannel(channel: UpdateChannel, options: VersionCommandOptions): Promise<void> {
  const environment = options.environment ?? process.env;
  if (isNpxExecution(environment)) {
    throw new Error(
      `Cannot switch an installation channel from npx. Run \`npx --prefer-online ${PACKAGE_NAME}@${channel === "stable" ? "latest" : "canary"} --version\` instead.`,
    );
  }
  const paths = storagePaths(options.storageRoot);
  const candidate = await latestForChannel(channel, options.fetcher);
  (options.stderr ?? process.stderr).write(`Switching teams-cli to ${channel} (${candidate.version})…\n`);
  await (options.upgrader ?? upgradeCli)({
    targetVersion: candidate.version,
    onInstalled: () => saveUpdateChannel(paths, channel),
  });
  (options.stdout ?? process.stdout).write(`teams-cli now follows the ${channel} channel at ${candidate.version}.\n`);
}

async function upgradeCurrent(options: VersionCommandOptions): Promise<void> {
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
  (options.stderr ?? process.stderr).write(`Upgrading teams-cli on ${channel} to ${candidate.version}…\n`);
  await (options.upgrader ?? upgradeCli)({ targetVersion: candidate.version });
  (options.stdout ?? process.stdout).write("teams-cli and recorded skill installations are up to date.\n");
}

export function registerVersionCommand(program: Command, options: VersionCommandOptions = {}): void {
  program.command("version")
    .description("Show build provenance, manage the update channel, or upgrade a global npm installation")
    .option("--upgrade", "Install the newest version from the effective channel")
    .addOption(new Option("--channel <channel>", "Switch a global npm installation channel").choices(["stable", "canary"]))
    .option("--json", "Output structured build and update information")
    .action(async (commandOptions: { upgrade?: boolean; channel?: UpdateChannel; json?: boolean }) => {
      if (commandOptions.channel && commandOptions.upgrade) throw new Error("--channel already installs the newest version and cannot be combined with --upgrade");
      if (commandOptions.json && (commandOptions.channel || commandOptions.upgrade)) throw new Error("--json cannot be combined with --channel or --upgrade");
      if (commandOptions.channel) return changeChannel(commandOptions.channel, options);
      if (commandOptions.upgrade) return upgradeCurrent(options);
      return versionDetails({ ...options, json: commandOptions.json === true, allowPrompt: true });
    });
}

export async function showAdaptiveVersion(options: VersionCommandOptions = {}): Promise<void> {
  const stdout = options.stdout ?? process.stdout;
  if (!stdout.isTTY) {
    stdout.write(`${options.buildInfo?.version ?? CLI_VERSION}\n`);
    return;
  }
  await versionDetails({ ...options, allowPrompt: true });
}
