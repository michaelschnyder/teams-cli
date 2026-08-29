import type { Command } from "commander";
import { upgradeCli } from "../upgrade.js";
import { CLI_VERSION } from "../version.js";

export function registerVersionCommand(program: Command): void {
  program.command("version")
    .description("Show the installed version or upgrade the global npm installation")
    .option("--upgrade", "Install the latest npm version and refresh managed skills")
    .action(async (options: { upgrade?: boolean }) => {
      if (!options.upgrade) {
        process.stdout.write(`${CLI_VERSION}\n`);
        return;
      }
      process.stderr.write("Upgrading teams-cli through npm…\n");
      await upgradeCli();
      process.stdout.write("teams-cli and recorded skill installations are up to date.\n");
    });
}
