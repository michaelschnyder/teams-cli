import { homedir } from "node:os";
import { join } from "node:path";
import {
  SKILL_PLATFORMS,
  createCoworkSkillPackage,
  detectClaudeDesktop,
  detectSkillPlatforms,
  findProjectRoot,
  installSkills,
  loadSkillManifest,
  lookupSkillPlatform,
  skillDestination,
  skillManifestFile,
  type SkillPlatform,
} from "./skills.js";

export type SkillsCommandOptions = {
  storageRoot?: string;
  projectRoot?: string;
  userHome?: string;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  detectCowork?: () => Promise<boolean>;
};

export type InstallOptions = {
  project?: boolean;
  name?: string;
  dir?: string;
  force?: boolean;
};

type InstallTargets = { local: SkillPlatform[]; cowork: boolean; };

export function supportedPlatforms(): string {
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

export function commandEnvironment(options: SkillsCommandOptions): { projectRoot: string; userHome: string; } {
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
): Promise<SkillInstallResult> {
  const installations: SkillInstallResult["installations"] = [];
  let cowork: SkillInstallResult["cowork"];
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
      installations.push({ label, destination, status: files.some(file => file.status === "installed") ? "installed" : files.some(file => file.status === "conflict") ? "conflict" : "unchanged" });
    }
  }

  if (targets.cowork) {
    const outputDirectory = installOptions.dir ?? join(userHome, "Downloads");
    const file = await createCoworkSkillPackage(outputDirectory);
    cowork = { file, instruction: "Upload in Claude: Cowork > Customize > Skills > Create skill > Upload a skill, and enable teams-cli. Account-level installation and permissions cannot be verified locally." };
  }
  return { installations, ...(cowork ? { cowork } : {}) };
}

export function resolvePathPlatforms(input: string | undefined, projectRoot: string, userHome: string): SkillPlatform[] {
  if (input?.toLowerCase() === "claude-cowork") {
    throw new Error("Claude Cowork has no filesystem skill path. Use `teams-cli skills install claude-cowork`");
  }
  const platforms = localPlatforms(input, projectRoot, userHome);
  if (!platforms.length) throw new Error(`No agent environment detected. Specify one of: ${supportedPlatforms()}`);
  return platforms;
}

export type SkillInstallResult = {
  installations: Array<{ label: string; destination: string; status: "installed" | "conflict" | "unchanged"; }>;
  cowork?: { file: string; instruction: string; };
};
