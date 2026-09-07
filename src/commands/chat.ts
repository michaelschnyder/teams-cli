import { ResultCommand as Command } from "../command-runner.js";
import {
  getChat,
  listChats,
  searchChats
} from "../teams-client.js";

import { type CommandServices } from "../command-services.js";
import { commandResult } from "../output.js";
import { requireChatCollectionConfirmation } from "../runtime.js";
import { withStatus } from "../terminal.js";

export function registerChatCommand(program: Command, services: CommandServices): void {
  const { interactiveAuth } = services;
  const chat = program.command("chat").description("Read Microsoft Teams chats");
  chat
    .command("search")
    .description("Search server-ranked chats and people without loading the full chat collection")
    .argument("<query>", "Chat name or participant query")
    .option("--json", "Output stable JSON")
    .action(async (query: string) => {
      const result = await withStatus("Searching chats…", () =>
        services.data(["search", "skype"], (session) => searchChats(session, query), interactiveAuth));
      return commandResult("chats", result);
    });
  chat
    .command("list")
    .description("List the server-provided chat collection and participants; may return every chat")
    .option("--cursor <cursor>", "Opaque cursor returned by the previous page")
    .option("--all", "Confirm that the initial request may return the complete chat collection")
    .option("--json", "Output stable JSON")
    .action(async (options: { cursor?: string; all?: boolean; json?: boolean; }) => {
      if (!options.cursor) await requireChatCollectionConfirmation(options.all, interactiveAuth.confirm);
      const result = await withStatus("Loading chats…", () =>
        services.data(["chat", "skype"], (session) => listChats(session, options.cursor), interactiveAuth));
      return commandResult("chats", result);
    });
  chat
    .command("get")
    .description("Get one chat by ID through the potentially complete chat collection")
    .argument("<chat-id>", "Teams chat ID")
    .option("--all", "Confirm that the lookup may return the complete chat collection")
    .option("--json", "Output stable JSON")
    .action(async (chatId: string, options: { all?: boolean; json?: boolean; }) => {
      await requireChatCollectionConfirmation(options.all, interactiveAuth.confirm);
      const result = await withStatus("Loading chat…", () =>
        services.data(["chat", "skype"], (session) => getChat(session, chatId), interactiveAuth));
      return commandResult("chat", result);
    });

}
