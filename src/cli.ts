#!/usr/bin/env node
import { Argument, Command, Option } from "commander";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  describeSession,
  login,
  logout,
  refreshTokens,
  validateSession,
  type RefreshResult,
  type RefreshTarget,
  type TokenResult,
  type WhoamiResult,
} from "./auth.js";
import { withDataSession } from "./data.js";
import { decodeJwtClaims, formatDuration, readJwtMetadata, secondsUntil } from "./jwt.js";
import type { BrowserName } from "./oauth.js";
import {
  loadSession,
  requireCurrentSession,
  storagePaths,
  type AnyStoredSession,
  type StoredSession,
  type StoredToken,
} from "./storage.js";
import {
  findChats,
  getMessage,
  listChats,
  listMessages,
  type ChatPage,
  type ChatSearchResult,
  type ChatSummary,
  type MessagePage,
  type MessageResult,
  type MessageSummary,
} from "./teams-client.js";

type TokenTarget = "all" | "access" | "skype" | "chat" | "search";

function outputWhoami(result: WhoamiResult): void {
  const user = result.user;
  process.stdout.write("Authenticated: yes\n");
  process.stdout.write(`Name: ${user.name ?? "unknown"}\n`);
  process.stdout.write(`Username: ${user.username ?? "unknown"}\n`);
  process.stdout.write(`User ID: ${user.id ?? "unknown"}\n`);
  process.stdout.write(`Tenant ID: ${user.tenantId}\n`);
  for (const [label, token] of [
    ["Access token", result.tokens.accessToken],
    ["Skype token", result.tokens.skypeToken],
    ["Chat token", result.tokens.chatToken],
    ["Search token", result.tokens.searchToken],
  ] as const) {
    process.stdout.write(`${label} audience: ${token.audience ?? "unknown"}\n`);
    process.stdout.write(`  Expires: ${token.expiresAt} (${formatDuration(token.expiresInSeconds)} remaining)\n`);
  }
}

function selectedTokens(session: StoredSession, target: TokenTarget): Record<string, string> {
  const all = {
    access: session.accessToken.value,
    skype: session.skypeToken.value,
    chat: session.chatToken.value,
    search: session.searchToken.value,
  };
  return target === "all" ? all : { [target]: all[target] };
}

export function renderTokens(
  session: StoredSession,
  target: TokenTarget,
  decode: boolean,
): string {
  const selected = selectedTokens(session, target);
  if (decode) {
    const claims = Object.fromEntries(
      Object.entries(selected).map(([name, token]) => [name, decodeJwtClaims(token)]),
    );
    const output = target === "all" ? claims : Object.values(claims)[0];
    return `${JSON.stringify(output, null, 2)}\n`;
  }
  if (target !== "all") return `${Object.values(selected)[0]}\n`;
  return [
    `Access token:\n${selected.access}`,
    `Skype token:\n${selected.skype}`,
    `Chat token:\n${selected.chat}`,
    `Search token:\n${selected.search}`,
  ].join("\n\n") + "\n";
}

function storedToken(session: AnyStoredSession, target: Exclude<TokenTarget, "all">): StoredToken | null {
  if (target === "access") return session.accessToken;
  if (target === "skype") return session.skypeToken;
  if (session.version === 1) return null;
  return target === "chat" ? session.chatToken : session.searchToken;
}

function describeStoredToken(token: StoredToken, now: Date): TokenResult {
  return {
    value: token.value,
    audience: readJwtMetadata(token.value).audience ?? null,
    expiresAt: token.expiresAt,
    expiresInSeconds: secondsUntil(token.expiresAt, now),
  };
}

export function renderRefreshResult(result: RefreshResult, now = new Date()): string {
  const targets: Array<Exclude<TokenTarget, "all">> = result.target === "all"
    ? ["access", "skype", "chat", "search"]
    : [result.target];
  const labels = {
    access: "Access token",
    skype: "Skype token",
    chat: "Chat token",
    search: "Search token",
  } as const;
  const lines = [
    `Refreshed ${result.target === "all" ? "all Teams tokens" : `${result.target} token`}.`,
  ];
  if (result.before.version === 1) lines.push("Previous session: version 1 (outdated)");
  for (const target of targets) {
    const previousToken = storedToken(result.before, target);
    const currentToken = storedToken(result.after, target);
    const current = currentToken ? describeStoredToken(currentToken, now) : null;
    lines.push(`${labels[target]}:`);
    if (previousToken) {
      const previous = describeStoredToken(previousToken, now);
      lines.push(
        `  Before audience: ${previous.audience ?? "unknown"}`,
        `  Before expiry: ${previous.expiresAt} (${formatDuration(previous.expiresInSeconds)} remaining)`,
      );
    } else {
      lines.push("  Before: unavailable in the outdated session");
    }
    if (current) {
      lines.push(
        `  After audience: ${current.audience ?? "unknown"}`,
        `  After expiry: ${current.expiresAt} (${formatDuration(current.expiresInSeconds)} remaining)`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

function fitCell(value: string, maximum: number): string {
  const normalized = value.replaceAll(/\s+/g, " ").trim();
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum - 1)}…`;
}

function formatTimestamp(value: string | null): string {
  if (!value) return "";
  return value
    .replace(/(T\d{2}:\d{2}:\d{2})\.\d+(Z|[+-]\d{2}:\d{2})?$/, "$1$2")
    .replace("T", " ")
    .replace(/Z$/, "");
}

function renderTable(rows: string[][], headers: string[]): string[] {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)));
  const line = (values: string[]) =>
    `| ${values.map((value, index) => value.padEnd(widths[index] ?? 0)).join(" | ")} |`;
  return [line(headers), line(widths.map((width) => "-".repeat(width))), ...rows.map(line)];
}

function renderChats(result: ChatPage | ChatSearchResult): string {
  const rows = result.chats.map((chat) => {
    const returnedNames = chat.participants.map((participant) =>
      participant.displayName ?? participant.id);
    const missing = Math.max(0, chat.participantCount - chat.participants.length - 1);
    const participantText = returnedNames.length
      ? `${returnedNames.join(", ")}${missing ? ` (+${missing} not returned)` : ""}`
      : `none returned${missing ? ` (${missing} total)` : ""}`;
    return [
      fitCell(chat.title, 40),
      fitCell(participantText, 64),
      formatTimestamp(chat.lastActivity),
      chat.id,
    ];
  });
  const lines = [`Chats (${result.chats.length})`, ...renderTable(
    rows,
    ["Chat", "Participants", "Last activity", "Chat ID"],
  )];
  if (result.chats.length === 0) {
    lines.splice(1, 2);
  }
  if (result.page.nextCursor) lines.push(`Next cursor: ${result.page.nextCursor}`);
  return `${lines.join("\n")}\n`;
}

function renderMessage(message: MessageSummary): string[] {
  const sender = message.sender.displayName ?? message.sender.id ?? "unknown";
  return [
    `- ${message.composedAt ?? message.originalArrivalAt ?? "unknown time"} ${sender} [${message.id}]`,
    `  ${message.content ?? ""}`,
  ];
}

function renderMessages(result: MessagePage): string {
  const lines = [`Messages (${result.messages.length}) for ${result.chatId}`];
  for (const message of result.messages) lines.push(...renderMessage(message));
  if (result.page.nextCursor) lines.push(`Next cursor: ${result.page.nextCursor}`);
  return `${lines.join("\n")}\n`;
}

function renderMessageResult(result: MessageResult): string {
  return `${[`Message for ${result.chatId}`, ...renderMessage(result.message)].join("\n")}\n`;
}

function writeData(value: unknown, human: string, json: boolean): void {
  process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : human);
}

function parsePageSize(raw: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 200) {
    throw new Error("--page-size must be an integer from 1 to 200");
  }
  return value;
}

export function createProgram(): Command {
  const paths = storagePaths();
  const program = new Command()
    .name("teams-cli")
    .description("A minimal command-line client for a persistent Microsoft Teams session")
    .version("0.1.0")
    .showHelpAfterError();
  const auth = program.command("auth").description("Manage Microsoft Teams authentication");

  auth
    .command("login")
    .description("Sign in with Microsoft and save the Teams session")
    .option("--tenant <tenant-id>", "Microsoft tenant ID")
    .addOption(
      new Option("--browser <browser>", "Browser used for Microsoft sign-in")
        .choices(["edge", "chrome"])
        .default("edge"),
    )
    .action(async (options: { browser: BrowserName; tenant?: string }) => {
      process.stderr.write(`Opening ${options.browser === "edge" ? "Microsoft Edge" : "Google Chrome"} for Teams sign-in…\n`);
      const session = await login(paths, options);
      process.stdout.write(`Logged in to tenant ${session.tenantId}.\n`);
    });

  auth
    .command("refresh")
    .description("Refresh all tokens or one token")
    .addArgument(
      new Argument("[token]", "Token to refresh")
        .choices(["all", "access", "skype", "chat", "search"])
        .default("all"),
    )
    .action(async (target: RefreshTarget) => {
      const result = await refreshTokens(paths, target);
      process.stdout.write(renderRefreshResult(result));
    });

  auth
    .command("whoami")
    .description("Validate the saved session and show its user and token expiry")
    .action(async () => {
      const session = await validateSession(paths);
      outputWhoami(describeSession(session));
    });

  auth
    .command("tokens")
    .alias("token")
    .description("Show saved tokens or their decoded JWT claims")
    .addArgument(
      new Argument("[token]", "Token to show")
        .choices(["all", "access", "skype", "chat", "search"])
        .default("all"),
    )
    .option("--decode", "Show only the decoded JWT claims")
    .action(async (target: TokenTarget, options: { decode?: boolean }) => {
      const session = requireCurrentSession(await loadSession(paths));
      process.stdout.write(renderTokens(session, target, options.decode ?? false));
    });

  auth
    .command("logout")
    .description("Remove the saved session and dedicated browser profiles")
    .action(async () => {
      await logout(paths);
      process.stdout.write("Logged out. Local Teams tokens and browser profiles were removed.\n");
    });

  const chats = program.command("chats").description("Read Microsoft Teams chats and messages");

  chats
    .command("list")
    .description("List the server-provided chat collection and participants")
    .option("--cursor <cursor>", "Opaque cursor returned by the previous page")
    .option("--json", "Output stable JSON")
    .action(async (options: { cursor?: string; json?: boolean }) => {
      const result = await withDataSession(paths, "chat", (session) =>
        listChats(session, options.cursor));
      writeData(result, renderChats(result), options.json ?? false);
    });

  chats
    .command("find")
    .description("Find chats by chat name or participant using Teams GoTo search")
    .argument("<query>", "Chat name or participant query")
    .option("--json", "Output stable JSON")
    .action(async (query: string, options: { json?: boolean }) => {
      const result = await withDataSession(paths, "search", (session) =>
        findChats(session, query));
      writeData(result, renderChats(result), options.json ?? false);
    });

  chats
    .command("messages")
    .description("List a server-provided page of messages in a chat")
    .argument("<chat-id>", "Teams chat ID")
    .option("--page-size <number>", "Server page size from 1 to 200", parsePageSize)
    .option("--cursor <cursor>", "Opaque cursor returned by the previous page")
    .option("--json", "Output stable JSON")
    .action(async (chatId: string, options: {
      pageSize?: number;
      cursor?: string;
      json?: boolean;
    }) => {
      if (options.cursor && options.pageSize !== undefined) {
        throw new Error("--cursor cannot be combined with --page-size");
      }
      const result = await withDataSession(paths, "skype", (session) =>
        listMessages(session, chatId, options));
      writeData(result, renderMessages(result), options.json ?? false);
    });

  chats
    .command("message")
    .description("Get one message from a chat by ID")
    .argument("<chat-id>", "Teams chat ID")
    .argument("<message-id>", "Teams message ID")
    .option("--json", "Output stable JSON")
    .action(async (chatId: string, messageId: string, options: { json?: boolean }) => {
      const result = await withDataSession(paths, "skype", (session) =>
        getMessage(session, chatId, messageId));
      writeData(result, renderMessageResult(result), options.json ?? false);
    });

  return program;
}

const entrypoint = process.argv[1];
if (entrypoint && realpathSync(entrypoint) === realpathSync(fileURLToPath(import.meta.url))) {
  createProgram().parseAsync(process.argv).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
