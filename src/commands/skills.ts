import type { Command } from "commander";
import {
  SKILL_PLATFORMS,
  detectSkillPlatforms,
  findProjectRoot,
  installSkills,
  loadBundledSkills,
  lookupSkillPlatform,
  reinstallSkills,
  skillDestination,
  skillManifestFile,
} from "../skills.js";

function resolveSkillPlatforms(input?: string) {
  if (input?.toLowerCase() === "all") return [...SKILL_PLATFORMS];
  if (input) {
    const platform = lookupSkillPlatform(input);
    if (!platform) {
      throw new Error(`Unknown skill platform ${input}. Supported: ${SKILL_PLATFORMS.map(({ name }) => name).join(", ")}, all`);
    }
    return [platform];
  }
  const detected = detectSkillPlatforms(findProjectRoot());
  if (!detected.length) {
    throw new Error(`No agent environment detected. Specify one of: ${SKILL_PLATFORMS.map(({ name }) => name).join(", ")}, all`);
  }
  return detected;
}

export function registerSkillsCommand(program: Command, storageRoot?: string): void {
  const skills = program.command("skills").description("List and install built-in agent skills");
  skills.command("list").description("List packaged teams-cli skills").action(async () => {
    for (const skill of await loadBundledSkills()) {
      process.stdout.write(`${skill.name}\t${skill.description}\n`);
    }
  });

  skills.command("path")
    .description("Show skill installation paths for a platform or detected environments")
    .argument("[platform]", "Platform name or all")
    .option("--project", "Use project-local scope instead of personal scope")
    .action((platformName: string | undefined, options: { project?: boolean }) => {
      const projectRoot = findProjectRoot();
      for (const platform of resolveSkillPlatforms(platformName)) {
        process.stdout.write(`${platform.name}\t${skillDestination(platform, Boolean(options.project), projectRoot)}\n`);
      }
    });

  skills.command("install")
    .description("Install packaged skills for a platform or detected environments")
    .argument("[platform]", "Platform name or all")
    .option("--project", "Install into project-local scope")
    .option("--name <name>", "Install only one named skill")
    .option("--dir <path>", "Install into a custom parent directory")
    .option("--force", "Overwrite existing managed skill files")
    .action(async (platformName: string | undefined, options: {
      project?: boolean;
      name?: string;
      dir?: string;
      force?: boolean;
    }) => {
      const projectRoot = findProjectRoot();
      const destinations = options.dir
        ? [options.dir]
        : resolveSkillPlatforms(platformName).map((platform) =>
          skillDestination(platform, Boolean(options.project), projectRoot));
      const result = await installSkills({
        destinations,
        ...(options.name ? { names: [options.name] } : {}),
        force: Boolean(options.force),
        manifestFile: skillManifestFile(storageRoot),
      });
      if (!result.filesWritten) {
        throw new Error("No skill files were written. Use --force to replace existing files");
      }
      for (const destination of result.destinations) process.stdout.write(`${destination}\n`);
      process.stdout.write(`Installed ${result.filesWritten} skill file${result.filesWritten === 1 ? "" : "s"}.\n`);
    });

  skills.command("reinstall")
    .description("Refresh all recorded CLI-managed skill installations")
    .action(async () => {
      const result = await reinstallSkills(skillManifestFile(storageRoot));
      if (!result.installations) {
        process.stdout.write("No recorded skill installations.\n");
        return;
      }
      process.stdout.write(`Reinstalled ${result.filesWritten} skill file${result.filesWritten === 1 ? "" : "s"} across ${result.installations} destination${result.installations === 1 ? "" : "s"}.\n`);
    });
}
