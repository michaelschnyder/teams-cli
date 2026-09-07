import { ResultCommand as Command } from "../command-runner.js";
import { commandResult } from "../output.js";
import { commandEnvironment, resolvePathPlatforms, runSkillsInstall, supportedPlatforms, type InstallOptions, type SkillsCommandOptions } from "../skill-installation.js";
import { loadBundledSkills, reinstallSkills, skillDestination, skillManifestFile } from "../skills.js";
export function registerSkillsCommand(program: Command, options: SkillsCommandOptions = {}): void {
  const skills = program.command("skills").description("List and install built-in agent skills");
  skills.command("list").description("List packaged teams-cli skills").action(async () => {
    return commandResult("list", { title: "Skills", items: (await loadBundledSkills()).map(({ name, description }) => ({ name, description })) });
  });

  skills.command("path")
    .description("Show skill installation paths for a platform or detected environments")
    .argument("[platform]", "Platform name or all")
    .option("--project", "Use project-local scope instead of personal scope")
    .action((platformName: string | undefined, command: { project?: boolean; }) => {
      const { projectRoot, userHome } = commandEnvironment(options);
      return commandResult("list", { title: "Skill paths", items: resolvePathPlatforms(platformName, projectRoot, userHome).map(platform => ({ platform: platform.name, path: skillDestination(platform, Boolean(command.project), projectRoot, userHome) })) });
    });

  skills.command("install")
    .description("Install packaged skills for a platform or detected environments")
    .argument("[platform]", `Platform name (${supportedPlatforms()})`)
    .option("--project", "Install into project-local scope")
    .option("--name <name>", "Install only one named skill")
    .option("--dir <path>", "Use a custom installation or output directory")
    .option("--force", "Overwrite existing managed skill files")
    .action(async (platformName: string | undefined, command: InstallOptions) => commandResult("skills", await runSkillsInstall(platformName, command, options)));

  skills.command("reinstall")
    .description("Refresh all recorded CLI-managed skill installations")
    .action(async () => {
      const result = await reinstallSkills(skillManifestFile(options.storageRoot));
      return commandResult("ack", { action: "Reinstalled skills", ...result });
    });
}
