#!/usr/bin/env node
import { Argument, Command, Option } from "commander";
import { realpathSync } from "node:fs";
import { randomInt, randomUUID } from "node:crypto";
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
import { clearStatus, configureDiagnostics, showStatus } from "./diagnostics.js";
import { requireAllowedTarget, type MessageTarget } from "./guardrails.js";
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
  getChannel,
  getChat,
  getMessage,
  getPerson,
  getPersonImage,
  listChannels,
  listChats,
  listMessages,
  sendMessage,
  searchPeople,
  type ChannelList,
  type ChannelResult,
  type ChatPage,
  type ChatResult,
  type ChatSummary,
  type MessagePage,
  type MessageResult,
  type MessageSendResult,
  type MessageSummary,
  type PersonImage,
  type PersonImageSize,
  type PersonResult,
  type PersonSearchResult,
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

function renderChats(result: ChatPage): string {
  const rows = result.chats.map((chat) => {
    const returnedNames = chat.participants.map((participant) =>
      participant.displayName ?? participant.id);
    const missing = Math.max(0, chat.participantCount - chat.participants.length - 1);
    const missingLabel = missing > 1 ? ` (+${missing} not returned)` : "";
    const participantText = returnedNames.length
      ? `${returnedNames.join(", ")}${missingLabel}`
      : `none returned${missing > 1 ? ` (${missing} not returned)` : ""}`;
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

function renderChatResult(result: ChatResult): string {
  const chat = result.chat;
  return `${chat.title}\nChat ID: ${chat.id}\nParticipants: ${chat.participants.map((participant) => participant.displayName ?? participant.id).join(", ")}\n`;
}

function renderChannels(result: ChannelList): string {
  const rows = result.channels.map((channel) => [
    fitCell(channel.name, 40),
    fitCell(channel.team.name, 40),
    channel.id,
  ]);
  const lines = [`Channels (${result.channels.length})`];
  if (rows.length) lines.push(...renderTable(rows, ["Channel", "Team", "Channel ID"]));
  return `${lines.join("\n")}\n`;
}

function renderChannelResult(result: ChannelResult): string {
  const channel = result.channel;
  return `${channel.name}\nChannel ID: ${channel.id}\nTeam: ${channel.team.name} (${channel.team.id})\nDescription: ${channel.description ?? ""}\n`;
}

function renderMessage(message: MessageSummary): string[] {
  const sender = message.sender.displayName ?? message.sender.id ?? "unknown";
  return [
    `- ${message.composedAt ?? message.originalArrivalAt ?? "unknown time"} ${sender} [${message.id}]`,
    `  ${message.content ?? ""}`,
  ];
}

function renderMessages(result: MessagePage): string {
  const lines = [`Messages (${result.messages.length}) for ${result.target.kind} ${result.target.id}`];
  for (const message of result.messages) lines.push(...renderMessage(message));
  if (result.page.nextCursor) lines.push(`Next cursor: ${result.page.nextCursor}`);
  return `${lines.join("\n")}\n`;
}

function renderMessageResult(result: MessageResult): string {
  return `${[`Message for ${result.target.kind} ${result.target.id}`, ...renderMessage(result.message)].join("\n")}\n`;
}

function renderMessageSendResult(result: MessageSendResult): string {
  const identifier = result.message ? ` ${result.message.id}` : "";
  return `Sent message${identifier} to ${result.target.kind} ${result.target.id}.\n`;
}

export function renderPeople(result: PersonSearchResult): string {
  const rows = result.people.map((person) => [
    fitCell(person.displayName ?? "", 40),
    fitCell(person.jobTitle ?? "", 40),
    fitCell(person.email ?? "", 48),
    person.id,
  ]);
  const lines = [`People (${result.people.length})`];
  if (rows.length) lines.push(...renderTable(rows, ["Name", "Job title", "Email", "Person ID"]));
  return `${lines.join("\n")}\n`;
}

export function renderPerson(result: PersonResult): string {
  const person = result.person;
  const phones = person.phones.map((phone) =>
    `${phone.type ? `${phone.type}: ` : ""}${phone.number}`);
  return `${[
    person.displayName ?? "unknown",
    `Person ID: ${person.id}`,
    `MRI: ${person.mri ?? ""}`,
    `Given name: ${person.givenName ?? ""}`,
    `Surname: ${person.surname ?? ""}`,
    `Email: ${person.email ?? ""}`,
    `Mail: ${person.mail ?? ""}`,
    `User principal name: ${person.userPrincipalName ?? ""}`,
    `SMTP addresses: ${person.smtpAddresses.join(", ")}`,
    `Job title: ${person.jobTitle ?? ""}`,
    `Department: ${person.department ?? ""}`,
    `Office: ${person.officeLocation ?? ""}`,
    `Mobile: ${person.mobile ?? ""}`,
    `Telephone: ${person.telephoneNumber ?? ""}`,
    `Phones: ${phones.join(", ")}`,
    `Tenant: ${person.tenantName ?? ""}`,
    `User type: ${person.userType ?? ""}`,
    `Account enabled: ${person.accountEnabled === null ? "unknown" : String(person.accountEnabled)}`,
    `Teams enabled: ${person.teamsEnabled === null ? "unknown" : String(person.teamsEnabled)}`,
  ].join("\n")}\n`;
}

export function personImageOutput(
  image: PersonImage,
  base64: boolean,
  stdoutIsTTY: boolean,
): Buffer {
  if (!base64 && stdoutIsTTY) {
    throw new Error("Refusing to write a raw profile image to an interactive terminal. Pipe it to a file or use --base64.");
  }
  return base64 ? Buffer.from(`${image.data.toString("base64")}\n`, "utf8") : image.data;
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

type TargetOptions = { chat?: string; channel?: string };

export function selectedTarget(options: TargetOptions): MessageTarget {
  if ((options.chat ? 1 : 0) + (options.channel ? 1 : 0) !== 1) {
    throw new Error("Exactly one of --chat or --channel is required");
  }
  return options.chat
    ? { kind: "chat", id: options.chat }
    : { kind: "channel", id: options.channel as string };
}

async function messageBody(body: string | undefined): Promise<string> {
  let value = body;
  if (value === undefined) {
    if (process.stdin.isTTY) throw new Error("Provide --body or pipe a message on stdin");
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    value = Buffer.concat(chunks).toString("utf8");
  }
  if (!value.trim()) throw new Error("Message body must not be empty");
  return value;
}

async function runWithStatus<T>(
  program: Command,
  json: boolean,
  status: string,
  operation: () => Promise<T>,
): Promise<T> {
  configureDiagnostics({ progress: Boolean(process.stderr.isTTY) && !json, debug: program.opts().debug === true });
  showStatus(status);
  try {
    return await operation();
  } finally {
    clearStatus();
  }
}

export function createProgram(): Command {
  const paths = storagePaths();
  const program = new Command()
    .name("teams-cli")
    .description("A minimal command-line client for a persistent Microsoft Teams session")
    .version("0.1.0")
    .option("--debug", "Show sanitized HTTP request diagnostics")
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
      const session = await runWithStatus(program, false, "Signing in…", () => login(paths, options));
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
      const result = await runWithStatus(program, false, `Refreshing ${target} token${target === "all" ? "s" : ""}…`, () => refreshTokens(paths, target));
      process.stdout.write(renderRefreshResult(result));
    });

  auth
    .command("whoami")
    .description("Validate the saved session and show its user and token expiry")
    .action(async () => {
      const session = await runWithStatus(program, false, "Validating session…", () => validateSession(paths));
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

  const person = program.command("person").description("Search and inspect Microsoft Teams people");
  person.command("search")
    .description("Search for people by name or email")
    .argument("<query>", "Person name or email query")
    .option("--json", "Output stable JSON")
    .action(async (query: string, options: { json?: boolean }) => {
      const result = await runWithStatus(program, options.json ?? false, "Searching for people…", () =>
        withDataSession(paths, "search", (session) => searchPeople(session, query)));
      writeData(result, renderPeople(result), options.json ?? false);
    });
  person.command("get")
    .description("Get a detailed person profile by email, object ID, or MRI")
    .argument("<email-or-id>", "Email address, object ID, or Teams MRI")
    .option("--json", "Output stable JSON")
    .action(async (identifier: string, options: { json?: boolean }) => {
      const result = await runWithStatus(program, options.json ?? false, "Loading person profile…", () =>
        withDataSession(paths, "access", (session) => getPerson(session, identifier)));
      writeData(result, renderPerson(result), options.json ?? false);
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
    .action(async (identifier: string, options: { base64?: boolean; size: PersonImageSize }) => {
      const base64 = options.base64 ?? false;
      if (!base64 && process.stdout.isTTY) {
        personImageOutput({ data: Buffer.alloc(0), contentType: "application/octet-stream" }, false, true);
      }
      const result = await runWithStatus(program, base64, "Loading person image…", () =>
        withDataSession(paths, "access", (session) => getPersonImage(session, identifier, options.size)));
      process.stdout.write(personImageOutput(result, base64, Boolean(process.stdout.isTTY)));
    });

  const chat = program.command("chat").description("Read Microsoft Teams chats");
  chat
    .command("list")
    .description("List the server-provided chat collection and participants")
    .option("--cursor <cursor>", "Opaque cursor returned by the previous page")
    .option("--json", "Output stable JSON")
    .action(async (options: { cursor?: string; json?: boolean }) => {
      const result = await runWithStatus(program, options.json ?? false, "Loading chats…", () =>
        withDataSession(paths, ["chat", "skype"], (session) => listChats(session, options.cursor)));
      writeData(result, renderChats(result), options.json ?? false);
    });
  chat
    .command("get")
    .description("Get one chat by ID")
    .argument("<chat-id>", "Teams chat ID")
    .option("--json", "Output stable JSON")
    .action(async (chatId: string, options: { json?: boolean }) => {
      const result = await runWithStatus(program, options.json ?? false, "Loading chat…", () =>
        withDataSession(paths, ["chat", "skype"], (session) => getChat(session, chatId)));
      writeData(result, renderChatResult(result), options.json ?? false);
    });

  const channel = program.command("channel").description("Read Microsoft Teams channels");
  channel.command("list").description("List channels across available teams")
    .option("--json", "Output stable JSON")
    .action(async (options: { json?: boolean }) => {
      const result = await runWithStatus(program, options.json ?? false, "Loading channels…", () =>
        withDataSession(paths, ["chat", "skype"], (session) => listChannels(session)));
      writeData(result, renderChannels(result), options.json ?? false);
    });
  channel.command("get").description("Get one channel by ID")
    .argument("<channel-id>", "Teams channel ID")
    .option("--json", "Output stable JSON")
    .action(async (channelId: string, options: { json?: boolean }) => {
      const result = await runWithStatus(program, options.json ?? false, "Loading channel…", () =>
        withDataSession(paths, ["chat", "skype"], (session) => getChannel(session, channelId)));
      writeData(result, renderChannelResult(result), options.json ?? false);
    });

  const message = program.command("message").description("Read and send Microsoft Teams messages");
  message.command("list").description("List a server-provided page of messages")
    .option("--chat <chat-id>", "Target chat ID")
    .option("--channel <channel-id>", "Target channel ID")
    .option("--page-size <number>", "Server page size from 1 to 200", parsePageSize)
    .option("--cursor <cursor>", "Opaque cursor returned by the previous page")
    .option("--json", "Output stable JSON")
    .action(async (options: TargetOptions & {
      pageSize?: number;
      cursor?: string;
      json?: boolean;
    }) => {
      if (options.cursor && options.pageSize !== undefined) {
        throw new Error("--cursor cannot be combined with --page-size");
      }
      const target = selectedTarget(options);
      const result = await runWithStatus(program, options.json ?? false, "Fetching messages…", () =>
        withDataSession(paths, "skype", (session) => listMessages(session, target, options)));
      writeData(result, renderMessages(result), options.json ?? false);
    });
  message.command("get").description("Get one message by ID")
    .argument("<message-id>", "Teams message ID")
    .option("--chat <chat-id>", "Target chat ID")
    .option("--channel <channel-id>", "Target channel ID")
    .option("--json", "Output stable JSON")
    .action(async (messageId: string, options: TargetOptions & { json?: boolean }) => {
      const target = selectedTarget(options);
      const result = await runWithStatus(program, options.json ?? false, "Fetching message…", () =>
        withDataSession(paths, "skype", (session) => getMessage(session, target, messageId)));
      writeData(result, renderMessageResult(result), options.json ?? false);
    });
  message.command("send").description("Send one allowlisted plain-text message")
    .option("--chat <chat-id>", "Target chat ID")
    .option("--channel <channel-id>", "Target channel ID")
    .option("--body <text>", "Plain-text message body; otherwise read stdin")
    .option("--json", "Output stable JSON")
    .action(async (options: TargetOptions & { body?: string; json?: boolean }) => {
      const target = selectedTarget(options);
      const body = await messageBody(options.body);
      const requestId = `${Date.now()}${randomInt(1_000_000).toString().padStart(6, "0")}`;
      const sessionId = randomUUID();
      const result = await runWithStatus(program, options.json ?? false, "Sending message…", async () => {
        await requireAllowedTarget(paths, target);
        return withDataSession(
          paths,
          "skype",
          (session) => sendMessage(session, target, body, requestId, sessionId),
          () => requireAllowedTarget(paths, target),
        );
      });
      writeData(result, renderMessageSendResult(result), options.json ?? false);
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
