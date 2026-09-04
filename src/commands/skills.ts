import type { Command } from "commander";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  SKILL_PLATFORMS,
  createCoworkSkillPackage,
  detectClaudeDesktop,
  detectSkillPlatforms,
  findProjectRoot,
  installSkills,
  loadBundledSkills,
  loadSkillManifest,
  lookupSkillPlatform,
  reinstallSkills,
  skillDestination,
  skillManifestFile,
  type SkillPlatform,
} from "../skills.js";

export type SkillsCommandOptions = {
  storageRoot?: string;
  projectRoot?: string;
  userHome?: string;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  detectCowork?: () => Promise<boolean>;
  stdout?: Pick<NodeJS.WriteStream, "write">;
};

type InstallOptions = {
  project?: boolean;
  name?: string;
  dir?: string;
  force?: boolean;
};

type InstallTargets = { local: SkillPlatform[]; cowork: boolean };

function supportedPlatforms(): string {
  return `${SKILL_PLATFORMS.map(({ name }) => name).join(", ")}, claude-cowork, all`;
}

function localPlatforms(input: string | undefined, projectRoot: string, userHome: string): SkillPlatform[] {
  if (input?.toLowerCase() === "all") return [...SKILL_PLATFORMS];
  if (input?.toLowerCase() === "claude-cowork") return [];
  if (input) {
    const platform = lookupSkillPlatform(input);
    if (!platform) throw new Error(`Unknown skill platform ${input}. Supported: ${supportedPlatforms()}`);
    return [platform];
  }
  return detectSkillPlatforms(projectRoot, userHome);
}

async function coworkDetected(options: SkillsCommandOptions): Promise<boolean> {
  try {
    if (options.detectCowork) return await options.detectCowork();
    return await detectClaudeDesktop({
      ...(options.platform ? { platform: options.platform } : {}),
      ...(options.userHome ? { userHome: options.userHome } : {}),
      ...(options.environment ? { environment: options.environment } : {}),
    });
  } catch {
    return false;
  }
}

async function installTargets(
  input: string | undefined,
  projectRoot: string,
  userHome: string,
  options: SkillsCommandOptions,
): Promise<InstallTargets> {
  const local = localPlatforms(input, projectRoot, userHome);
  const cowork = input?.toLowerCase() === "all" || input?.toLowerCase() === "claude-cowork" ||
    (!input && await coworkDetected(options));
  if (!local.length && !cowork) throw new Error(`No agent environment detected. Specify one of: ${supportedPlatforms()}`);
  return { local, cowork };
}

function commandEnvironment(options: SkillsCommandOptions): { projectRoot: string; userHome: string } {
  return {
    projectRoot: options.projectRoot ?? findProjectRoot(),
    userHome: options.userHome ?? homedir(),
  };
}

export async function hasManagedSkillInstallations(storageRoot?: string): Promise<boolean> {
  try {
    return (await loadSkillManifest(skillManifestFile(storageRoot))).installations.length > 0;
  } catch {
    return true;
  }
}

export async function hasDetectedAgentEnvironment(options: SkillsCommandOptions = {}): Promise<boolean> {
  const { projectRoot, userHome } = commandEnvironment(options);
  return detectSkillPlatforms(projectRoot, userHome).length > 0 || await coworkDetected(options);
}

export async function runSkillsInstall(
  platformName: string | undefined,
  installOptions: InstallOptions,
  commandOptions: SkillsCommandOptions = {},
): Promise<void> {
  const stdout = commandOptions.stdout ?? process.stdout;
  const { projectRoot, userHome } = commandEnvironment(commandOptions);
  const targets = await installTargets(platformName, projectRoot, userHome, commandOptions);
  if (targets.cowork && !targets.local.length && installOptions.project) {
    throw new Error("Claude Cowork does not support project-local installation through this command");
  }
  if (targets.cowork && installOptions.name && installOptions.name !== "teams-cli") {
    throw new Error(`Unknown skill: ${installOptions.name}`);
  }
  const destinations = installOptions.dir
    ? targets.local.length ? [installOptions.dir] : []
    : targets.local.map((platform) => skillDestination(platform, Boolean(installOptions.project), projectRoot, userHome));

  if (destinations.length) {
    const result = await installSkills({
      destinations,
      ...(installOptions.name ? { names: [installOptions.name] } : {}),
      force: Boolean(installOptions.force),
      manifestFile: skillManifestFile(commandOptions.storageRoot),
    });
    for (const destination of result.destinations) {
      const files = result.files.filter((file) => file.destination === destination);
      const label = installOptions.dir
        ? "custom agent directory"
        : targets.local[result.destinations.indexOf(destination)]?.name ?? "agent";
      if (files.some(({ status }) => status === "installed")) {
        stdout.write(`Installed ${label}: ${destination}\n`);
      } else if (files.some(({ status }) => status === "conflict")) {
        stdout.write(`Already installed ${label}: ${destination} (existing files differ and were left unchanged; use --force to replace them)\n`);
      } else {
        stdout.write(`Already installed ${label}: ${destination}\n`);
      }
    }
  }

  if (targets.cowork) {
    const outputDirectory = installOptions.dir ?? join(userHome, "Downloads");
    const file = await createCoworkSkillPackage(outputDirectory);
    stdout.write(
      `Claude Cowork requires one final step.\n` +
      `Upload ${file} in Claude: open Cowork, then Customize > Skills > Create skill > Upload a skill, and enable teams-cli.\n` +
      `teams-cli cannot verify Cowork's account-level installation or permissions.\n`,
    );
  }
}

function resolvePathPlatforms(input: string | undefined, projectRoot: string, userHome: string): SkillPlatform[] {
  if (input?.toLowerCase() === "claude-cowork") {
    throw new Error("Claude Cowork has no filesystem skill path. Use `teams-cli skills install claude-cowork`");
  }
  const platforms = localPlatforms(input, projectRoot, userHome);
  if (!platforms.length) throw new Error(`No agent environment detected. Specify one of: ${supportedPlatforms()}`);
  return platforms;
}

export function registerSkillsCommand(program: Command, options: SkillsCommandOptions = {}): void {
  const stdout = options.stdout ?? process.stdout;
  const skills = program.command("skills").description("List and install built-in agent skills");
  skills.command("list").description("List packaged teams-cli skills").action(async () => {
    for (const skill of await loadBundledSkills()) stdout.write(`${skill.name}\t${skill.description}\n`);
  });

  skills.command("path")
    .description("Show skill installation paths for a platform or detected environments")
    .argument("[platform]", "Platform name or all")
    .option("--project", "Use project-local scope instead of personal scope")
    .action((platformName: string | undefined, command: { project?: boolean }) => {
      const { projectRoot, userHome } = commandEnvironment(options);
      for (const platform of resolvePathPlatforms(platformName, projectRoot, userHome)) {
        stdout.write(`${platform.name}\t${skillDestination(platform, Boolean(command.project), projectRoot, userHome)}\n`);
      }
    });

  skills.command("install")
    .description("Install packaged skills for a platform or detected environments")
    .argument("[platform]", `Platform name (${supportedPlatforms()})`)
    .option("--project", "Install into project-local scope")
    .option("--name <name>", "Install only one named skill")
    .option("--dir <path>", "Use a custom installation or output directory")
    .option("--force", "Overwrite existing managed skill files")
    .action((platformName: string | undefined, command: InstallOptions) => runSkillsInstall(platformName, command, options));

  skills.command("reinstall")
    .description("Refresh all recorded CLI-managed skill installations")
    .action(async () => {
      const result = await reinstallSkills(skillManifestFile(options.storageRoot));
      if (!result.installations) {
        stdout.write("No recorded skill installations.\n");
        return;
      }
      stdout.write(`Reinstalled ${result.filesWritten} skill file${result.filesWritten === 1 ? "" : "s"} across ${result.installations} destination${result.installations === 1 ? "" : "s"}.\n`);
    });
}
