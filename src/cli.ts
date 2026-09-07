#!/usr/bin/env node
import { Option } from "commander";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ResultCommand } from "./command-runner.js";
import { createServices, type ProgramOptions } from "./command-services.js";
import { registerAuthCommand } from "./commands/auth.js";
import { registerChannelCommand } from "./commands/channel.js";
import { registerChatCommand } from "./commands/chat.js";
import { registerDoctorCommand } from "./commands/doctor.js";
import { registerMessageCommand } from "./commands/message.js";
import { registerPersonCommand } from "./commands/person.js";
import { registerPolicyCommand } from "./commands/policy.js";
import { registerProfileCommand } from "./commands/profile.js";
import { registerSkillsCommand } from "./commands/skills.js";
import { registerVersionCommand, showAdaptiveVersion } from "./commands/version.js";
import { resolveUpdateChannel } from "./settings.js";
import { storagePaths } from "./storage.js";
import { reportError } from "./terminal.js";
import { prepareUpdateNotification, runUpdateWorker } from "./update.js";
import { BUILD_INFO, CLI_VERSION } from "./version.js";
export type { ProgramOptions } from "./command-services.js";

export function createProgram(options: ProgramOptions = {}): ResultCommand {
  const program = new ResultCommand("teams-cli", options)
    .description("A safety-conscious command-line client for persistent Microsoft Teams sessions")
    .option("-V, --version", "Show the installed version and build provenance")
    .option("--debug", "Show sanitized HTTP diagnostics")
    .addOption(new Option("--log <level>", "Terminal log level").choices(["error", "warn", "info", "debug", "trace"]))
    .option("-v, --verbose", "Increase verbosity (-v info, -vv debug, -vvv trace)", (_, previous: number) => previous + 1, 0)
    .option("--log-file <path>", "Append sanitized JSON Lines diagnostics (10 MiB maximum)")
    .option("--profile <name>", "Optional named profile for selecting another identity")
    .option("--tenant <tenant-id>", "Optional expected Microsoft tenant ID")
    .option("--user <user-id>", "Optional expected Microsoft user object ID")
    .addOption(new Option("--browser <browser>", "Dedicated browser for Microsoft sign-in").choices(["edge", "chrome"]))
    .showHelpAfterError();
  const services = createServices(options, () => program.opts());
  const versionOptions = { ...options, confirm: services.interactiveAuth.confirm };
  registerVersionCommand(program, versionOptions);
  program.action(async () => {
    if (program.opts().version === true) return showAdaptiveVersion({ ...versionOptions, ...(program.opts().json ? { output: "json" as const } : program.opts().output ? { output: program.opts().output } : {}) });
    program.outputHelp();
  });
  registerSkillsCommand(program, services.skillsOptions);
  registerDoctorCommand(program, { ...services.skillsOptions, paths: services.paths, context: services.context });
  registerAuthCommand(program, services);
  registerProfileCommand(program, services);
  registerPolicyCommand(program, services);
  registerPersonCommand(program, services);
  registerChatCommand(program, services);
  registerChannelCommand(program, services);
  registerMessageCommand(program, services);
  return program;
}

const entrypoint = process.argv[1];
if (entrypoint && realpathSync(entrypoint) === realpathSync(fileURLToPath(import.meta.url))) {
  const run = async () => {
    if (process.argv[2] === "--internal-update-check" && process.env.TEAMS_CLI_UPDATE_WORKER === "1") {
      const currentVersion = process.argv[3];
      const file = process.argv[4];
      const channel = process.argv[5];
      if (currentVersion && file && (channel === "stable" || channel === "canary")) {
        await runUpdateWorker(currentVersion, file, fetch, new Date(), channel);
      }
      return;
    }
    const readOnlyInvocation = process.argv[2] === "version" || process.argv.slice(2).includes("doctor") ||
      process.argv.includes("--version") || process.argv.includes("-V");
    if (!readOnlyInvocation) {
      const paths = storagePaths();
      const channel = await resolveUpdateChannel({ paths, installedChannel: BUILD_INFO.channel });
      await prepareUpdateNotification({ currentVersion: CLI_VERSION, channel, installedChannel: BUILD_INFO.channel });
    }
    await createProgram().parseAsync(process.argv);
  };
  run().catch((error: unknown) => {
    reportError(error);
    process.exitCode = 1;
  });
}
