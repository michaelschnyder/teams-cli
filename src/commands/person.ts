import { Option } from "commander";
import { ResultCommand as Command } from "../command-runner.js";
import {
  getPerson,
  getPersonImage,
  searchPeople,
  type PersonImageSize
} from "../teams-client.js";

import { type CommandServices } from "../command-services.js";
import { imageExport, personImageOutput } from "../export-output.js";
import { commandResult } from "../output.js";
import { currentTerminal, withStatus } from "../terminal.js";

export function registerPersonCommand(program: Command, services: CommandServices): void {
  const { interactiveAuth } = services;
  const person = program.command("person").description("Search and inspect Microsoft Teams people");
  person.command("search")
    .description("Search for people by name or email")
    .argument("<query>", "Person name or email query")
    .option("--json", "Output stable JSON")
    .action(async (query: string) => {
      const result = await withStatus("Searching for people…", () =>
        services.data("search", (session) => searchPeople(session, query), interactiveAuth));
      return commandResult("people", result);
    });
  person.command("get")
    .description("Get a detailed person profile by email, object ID, or MRI")
    .argument("<email-or-id>", "Email address, object ID, or Teams MRI")
    .option("--json", "Output stable JSON")
    .action(async (identifier: string) => {
      const result = await withStatus("Loading person profile…", () =>
        services.data("access", (session) => getPerson(session, identifier), interactiveAuth));
      return commandResult("person", result);
    });
  person.command("image")
    .description("Stream a person's authenticated profile image")
    .argument("<email-or-id>", "Email address, object ID, or Teams MRI")
    .option("--base64", "Output one base64-encoded line instead of raw image bytes")
    .addOption(
      new Option("--size <pixels>", "Requested image size; unavailable sizes fall back")
        .choices(["48", "64", "96", "120", "240", "360", "432", "504", "648", "max"])
        .default("max"),
    )
    .action(async (identifier: string, options: { base64?: boolean; size: PersonImageSize; output?: string; json?: boolean; }, command: Command) => {
      const base64 = options.base64 ?? false;
      const format = command.optsWithGlobals().output;
      const structured = format === "json" || format === "yaml" || command.optsWithGlobals().json;
      if (base64 && structured) throw new Error("--base64 cannot be combined with structured output");
      if (!base64 && !structured && currentTerminal()?.stdout.isTTY) {
        personImageOutput({ data: Buffer.alloc(0), contentType: "application/octet-stream" }, false, true);
      }
      const result = await withStatus("Loading person image…", () =>
        services.data("access", (session) => getPersonImage(session, identifier, options.size), interactiveAuth));
      if (structured) return commandResult("image", { contentType: result.contentType, data: result.data.toString("base64") });
      return imageExport(result, base64, Boolean(currentTerminal()?.stdout.isTTY));
    });

}
