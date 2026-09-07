import { ResultCommand as Command } from "../command-runner.js";
import {
  loadProfiles,
  removeProfile,
  requireRuntimeIdentity,
  saveProfile
} from "../config.js";
import {
  loadSession,
  requireCurrentSession
} from "../storage.js";

import { type CommandServices } from "../command-services.js";
import { commandResult } from "../output.js";

export function registerProfileCommand(program: Command, services: CommandServices): void {
  const { paths } = services;
  const profile = program.command("profile").description("Manage optional named configuration profiles");
  profile.command("list").description("List configured profiles").action(async () => {
    const config = await loadProfiles(paths);
    const names = Object.keys(config.profiles).sort();
    return commandResult("list", { title: "Profiles", items: names.map(name => ({ name })) });
  });
  profile.command("show").description("Show one profile or the selected profile")
    .argument("[name]", "Profile name")
    .action(async (name?: string) => {
      const context = await services.context();
      const profileName = name ?? context.profileName;
      const config = await loadProfiles(paths);
      const stored = config.profiles[profileName];
      if (!stored) throw new Error(`Profile ${profileName} does not exist`);
      return commandResult("record", { name: profileName, ...stored });
    });
  profile.command("save").description("Save the effective tenant, user, and browser as a profile")
    .argument("<name>", "Profile name")
    .action(async (name: string) => {
      const context = await services.context();
      const identity = requireRuntimeIdentity(context);
      const session = requireCurrentSession(await loadSession(paths, identity));
      await saveProfile(paths, name, {
        ...identity,
        ...(session.username ? { username: session.username } : {}),
        browser: context.browser,
      });
      return commandResult("ack", { action: "Saved profile", name });
    });
  profile.command("remove").description("Remove profile configuration without deleting its session")
    .argument("<name>", "Profile name")
    .action(async (name: string) => {
      if (!await removeProfile(paths, name)) throw new Error(`Profile ${name} does not exist`);
      return commandResult("ack", { action: "Removed profile", name, authenticationRetained: true });
    });

}
