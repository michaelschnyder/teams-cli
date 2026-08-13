#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { readJwtMetadata } from "./jwt.js";
import { acquireInitialToken, acquireResourceTokens } from "./oauth.js";
import { exchangeInitialToken } from "./teams-auth.js";
import { listConversations } from "./teams-client.js";
import { CHAT_SVC_AGG_RESOURCE, SKYPE_RESOURCE } from "./constants.js";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function positiveIntegerOption(name: string, fallback: number): number {
  const raw = option(name);
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "help";
  if (command !== "auth" && command !== "list") {
    console.log(`Usage:\n  npm run dev -- auth [--tenant TENANT_ID] [--profile PATH] [--ephemeral]\n  npm run dev -- list [--tenant TENANT_ID] [--profile PATH] [--ephemeral] [--limit N] [--all] [--json]\n\nThe Edge login state is preserved in .state/edge-profile by default. Token values are never printed or persisted by the CLI.`);
    return;
  }

  const ephemeral = process.argv.includes("--ephemeral");
  const profileOption = option("--profile") ?? ".state/edge-profile";
  const profileDirectory = ephemeral ? undefined : resolve(profileOption);
  const tenant = option("--tenant");
  if (profileDirectory) {
    await mkdir(profileDirectory, { recursive: true, mode: 0o700 });
  }

  console.log("Opening Microsoft Edge for Teams sign-in…");
  if (command === "list") {
    const { close, tokens } = await acquireResourceTokens(
      [SKYPE_RESOURCE, CHAT_SVC_AGG_RESOURCE],
      {
        ...(profileDirectory ? { profileDirectory } : {}),
        ...(tenant ? { tenant } : {}),
      },
    );
    try {
      const skypeRootToken = tokens.get(SKYPE_RESOURCE);
      const chatSvcAggToken = tokens.get(CHAT_SVC_AGG_RESOURCE);
      if (!skypeRootToken || !chatSvcAggToken) {
        throw new Error("Edge login did not return all required resource tokens");
      }
      const session = await exchangeInitialToken(skypeRootToken);
      const conversations = await listConversations(chatSvcAggToken);
      const includeAll = process.argv.includes("--all");
      const limit = positiveIntegerOption("--limit", 50);
      const chats = conversations.chats
        .filter((chat) => includeAll || !chat.hidden)
        .sort((left, right) =>
          (right.lastActivity ?? "").localeCompare(left.lastActivity ?? ""),
        )
        .slice(0, includeAll ? undefined : limit);
      const output = { chats, teams: conversations.teams };
      if (process.argv.includes("--json")) {
        console.log(JSON.stringify(output, null, 2));
      } else {
        console.log(`Chats (${chats.length} shown)`);
        for (const chat of chats) {
          console.log(`- ${chat.title} [${chat.id}]${chat.hidden ? " (hidden)" : ""}`);
        }
        console.log(`Teams (${conversations.teams.length})`);
        for (const team of conversations.teams) {
          console.log(`- ${team.name} [${team.id}] (${team.channels.length} channels)`);
        }
        console.log(`Region: ${session.region ?? "unknown"}`);
      }
    } finally {
      await close();
    }
    return;
  }

  const { close, token } = await acquireInitialToken({
    ...(profileDirectory ? { profileDirectory } : {}),
    ...(tenant ? { tenant } : {}),
  });

  try {
    const initial = readJwtMetadata(token);
    console.log("Initial token acquired:", initial);

    const session = await exchangeInitialToken(token);
    const derived = readJwtMetadata(session.skypeToken);
    console.log("Teams token exchange succeeded:", {
      region: session.region,
      partition: session.partition,
      expiresIn: session.expiresIn,
      token: derived,
      endpoints: session.endpoints,
    });
  } finally {
    await close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
