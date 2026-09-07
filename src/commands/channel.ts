import { ResultCommand as Command } from "../command-runner.js";
import {
  getChannel,
  listChannels
} from "../teams-client.js";

import { type CommandServices } from "../command-services.js";
import { commandResult } from "../output.js";
import { withStatus } from "../terminal.js";

export function registerChannelCommand(program: Command, services: CommandServices): void {
  const { interactiveAuth } = services;
  const channel = program.command("channel").description("Read Microsoft Teams channels");
  channel.command("list").description("List channels across available teams")
    .option("--json", "Output stable JSON")
    .action(async () => {
      const result = await withStatus("Loading channels…", () =>
        services.data(["chat", "skype"], (session) => listChannels(session), interactiveAuth));
      return commandResult("channels", result);
    });
  channel.command("get").description("Get one channel by ID")
    .argument("<channel-id>", "Teams channel ID")
    .option("--json", "Output stable JSON")
    .action(async (channelId: string) => {
      const result = await withStatus("Loading channel…", () =>
        services.data(["chat", "skype"], (session) => getChannel(session, channelId), interactiveAuth));
      return commandResult("channel", result);
    });

}
