#!/usr/bin/env node
import { Argument, Command, Option } from "commander";
import { realpathSync } from "node:fs";
import { randomInt, randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import {
  describeSession,
  InteractiveLoginRequiredError,
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
import type { DataTokenTarget } from "./auth.js";
import { clearStatus, configureDiagnostics, showStatus } from "./diagnostics.js";
import {
  activatePolicy,
  canonicalSubjectPath,
  initializePolicy,
  loadPolicyStore,
  policyProtectionInstruction,
  policyStatusWarnings,
  requireMessageRead,
  requireMessageSend,
  requirePolicyIdentity,
  requireRawTokenExport,
  resolvePolicies,
  resolvePolicyByName,
  type MessageTarget,
  type ResolvedPolicies,
} from "./policy.js";
import { inspectPolicyStore, startPolicyEditor } from "./policy-editor.js";
import {
  loadProfiles,
  removeProfile,
  requireRuntimeIdentity,
  resolveRuntimeContext,
  saveProfile,
  type RuntimeContext,
  type RuntimeOverrides,
} from "./config.js";
import { decodeJwtClaims, formatDuration, readJwtMetadata, secondsUntil } from "./jwt.js";
import {
  loadSession,
  requireCurrentSession,
  storagePaths,
  type Identity,
  type StoragePaths,
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
  resolveDirectMessageTarget,
  searchChats,
  sendMessage,
  searchPeople,
  type ChannelList,
  type ChannelResult,
  type ChatPage,
  type ChatResult,
  type MessagePage,
  type MessageResult,
  type MessageSendResult,
  type MessageSummary,
  type PersonImage,
  type PersonImageSize,
  type PersonResult,
  type PersonSearchResult,
} from "./teams-client.js";
import { registerSkillsCommand } from "./commands/skills.js";
import { registerVersionCommand, showAdaptiveVersion } from "./commands/version.js";
import { prepareUpdateNotification, runUpdateWorker } from "./update.js";
import { resolveUpdateChannel } from "./settings.js";
import { BUILD_INFO, CLI_VERSION } from "./version.js";

type TokenTarget = "all" | "access" | "skype" | "chat" | "search";
type GlobalOptions = RuntimeOverrides & { debug?: boolean };
type LoginCommandOptions = { username?: string; passwordCommand?: string; headless?: boolean };
type ConfirmPrompt = (question: string) => Promise<boolean>;
type LoginImplementation = typeof login;

export type ProgramOptions = {
  storageRoot?: string;
  subjectPath?: string;
  confirm?: ConfirmPrompt;
  loginImplementation?: LoginImplementation;
  fetcher?: typeof fetch;
  environment?: NodeJS.ProcessEnv;
};

type InteractiveAuthSupport = {
  confirm: ConfirmPrompt;
  login: LoginImplementation;
};

type AuthorizedRuntime = {
  context: RuntimeContext;
  identity: Identity;
  policies: ResolvedPolicies;
  reportPolicyWarnings: (warnings: readonly string[]) => void;
};

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function editorCommand(context: RuntimeContext): string {
  return `teams-cli --profile ${shellQuote(context.profileName)}${context.tenantId ? ` --tenant ${shellQuote(context.tenantId)}` : ""}${context.userId ? ` --user ${shellQuote(context.userId)}` : ""} policy edit`;
}

function policyWarningReporter(): (warnings: readonly string[]) => void {
  const reported = new Set<string>();
  return (warnings) => {
    for (const warning of warnings) {
      if (reported.has(warning)) continue;
      reported.add(warning);
      process.stderr.write(`Warning: ${warning}.\n`);
    }
  };
}

async function terminalConfirmation(question: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) return false;
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(?:es)?$/i.test((await prompt.question(`${question} [y/N] `)).trim());
  } finally {
    prompt.close();
  }
}

function browserLabel(context: RuntimeContext): string {
  return context.browser === "edge" ? "Microsoft Edge" : "Google Chrome";
}

async function requireChatCollectionConfirmation(
  confirmed: boolean | undefined,
  confirm: ConfirmPrompt,
): Promise<void> {
  if (confirmed || await confirm(
    "Teams does not offer a reliable page limit and may return your complete chat history. Enumerate all chats?",
  )) return;
  throw new Error("Chat collection request cancelled. Use `teams-cli chat search <query>` first, or pass `--all` to allow a potentially complete response.");
}

async function loginForRuntime(
  paths: StoragePaths,
  context: RuntimeContext,
  policies: ResolvedPolicies,
  reportPolicyWarnings: (warnings: readonly string[]) => void,
  loginImplementation: LoginImplementation,
): Promise<StoredSession> {
  process.stderr.write(`Opening a dedicated ${browserLabel(context)} profile for Teams sign-in…\n`);
  const session = await loginImplementation(paths, {
    browser: context.browser,
    ...(context.tenantId ? { tenant: context.tenantId } : {}),
    ...(context.userId ? { user: context.userId } : {}),
    ...(context.username ? { username: context.username } : {}),
    authorizeIdentity: async (identity) => {
      reportPolicyWarnings(requirePolicyIdentity(policies, identity));
    },
  });
  await saveProfile(paths, context.profileName, {
    tenantId: session.tenantId,
    userId: session.userId,
    ...(session.username ? { username: session.username } : context.username ? { username: context.username } : {}),
    browser: context.browser,
  });
  return session;
}

async function runtimeContext(program: Command, paths: StoragePaths): Promise<RuntimeContext> {
  return resolveRuntimeContext(paths, program.opts() as GlobalOptions);
}

async function authorizedRuntime(
  program: Command,
  paths: StoragePaths,
  subjectStart?: string,
  reportPolicyWarnings = policyWarningReporter(),
  interactiveAuth: InteractiveAuthSupport = { confirm: terminalConfirmation, login },
  offerLogin = true,
): Promise<AuthorizedRuntime> {
  let context = await runtimeContext(program, paths);
  let policies = await resolvePolicies(paths, subjectStart);
  let identity: Identity;
  let openedLogin = false;
  try {
    identity = requireRuntimeIdentity(context);
  } catch (error) {
    if (!offerLogin) throw error;
    if (!await interactiveAuth.confirm(
      `No Teams session is configured. Open a dedicated ${browserLabel(context)} profile to sign in?`,
    )) throw error;
    const session = await loginForRuntime(paths, context, policies, reportPolicyWarnings, interactiveAuth.login);
    openedLogin = true;
    identity = { tenantId: session.tenantId, userId: session.userId };
    context = {
      ...context,
      tenantId: session.tenantId,
      userId: session.userId,
      ...(session.username ? { username: session.username } : {}),
    };
  }
  if (!openedLogin && offerLogin) {
    try {
      requireCurrentSession(await loadSession(paths, identity));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/^(?:Not logged in|Stored Teams session)/.test(message)) throw error;
      if (!await interactiveAuth.confirm(
        `${message.replace(/\s+(?:Run \`teams-cli (?:auth )?login\`\.?|Log in again\.?)$/, "")} Open a dedicated ${browserLabel(context)} profile to sign in?`,
      )) throw error;
      const session = await loginForRuntime(paths, context, policies, reportPolicyWarnings, interactiveAuth.login);
      identity = { tenantId: session.tenantId, userId: session.userId };
      context = {
        ...context,
        tenantId: session.tenantId,
        userId: session.userId,
        ...(session.username ? { username: session.username } : {}),
      };
    }
  }
  if (!policies.policies.some(({ policy }) => policy.active)) {
    const message = policies.policies.length === 0
      ? `No policy applies to ${policies.subjectPath}`
      : `Only inactive policies apply to ${policies.subjectPath}`;
    if (process.stdin.isTTY && process.stderr.isTTY) {
      const prompt = createInterface({ input: process.stdin, output: process.stderr });
      let answer = "";
      try {
        answer = await prompt.question(`${message}. Open the policy editor? [y/N] `);
      } finally {
        prompt.close();
      }
      if (/^y(?:es)?$/i.test(answer.trim())) {
        await startPolicyEditor({ paths, context, ...(subjectStart ? { subjectStart } : {}), open: true, version: CLI_VERSION });
        policies = await resolvePolicies(paths, subjectStart);
        if (!policies.policies.some(({ policy }) => policy.active)) {
          process.stderr.write(`Warning: The editor closed without an active policy for ${policies.subjectPath}.\n`);
        }
      }
    } else {
      process.stderr.write(`Warning: ${message}. Run \`${editorCommand(context)}\` to configure least-privilege access.\n`);
    }
  }
  reportPolicyWarnings(policyStatusWarnings(policies));
  reportPolicyWarnings(requirePolicyIdentity(policies, identity));
  return { context, identity, policies, reportPolicyWarnings };
}

async function recoverInteractiveLogin(
  paths: StoragePaths,
  runtime: AuthorizedRuntime,
  subjectStart: string | undefined,
  error: InteractiveLoginRequiredError,
  interactiveAuth: InteractiveAuthSupport,
): Promise<void> {
  if (!await interactiveAuth.confirm(
    `${error.message} Open the dedicated ${browserLabel(runtime.context)} profile to continue?`,
  )) {
    throw new Error(`${error.message} Run \`teams-cli login\` to continue.`);
  }
  const policies = await resolvePolicies(paths, subjectStart);
  await loginForRuntime(
    paths,
    runtime.context,
    policies,
    runtime.reportPolicyWarnings,
    interactiveAuth.login,
  );
}

async function withInteractiveLoginRecovery<T>(
  paths: StoragePaths,
  runtime: AuthorizedRuntime,
  subjectStart: string | undefined,
  interactiveAuth: InteractiveAuthSupport,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!(error instanceof InteractiveLoginRequiredError)) throw error;
    await recoverInteractiveLogin(paths, runtime, subjectStart, error, interactiveAuth);
    return operation();
  }
}

async function withAuthorizedDataSession<T>(
  program: Command,
  paths: StoragePaths,
  subjectStart: string | undefined,
  targets: DataTokenTarget | readonly DataTokenTarget[],
  operation: (session: StoredSession, runtime: AuthorizedRuntime) => Promise<T>,
  interactiveAuth: InteractiveAuthSupport = { confirm: terminalConfirmation, login },
): Promise<T> {
  const runtime = await authorizedRuntime(program, paths, subjectStart, policyWarningReporter(), interactiveAuth);
  return withInteractiveLoginRecovery(paths, runtime, subjectStart, interactiveAuth, () =>
    withDataSession(
      paths,
      runtime.identity,
      runtime.context.browser,
      targets,
      (session) => operation(session, runtime),
    ));
}

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

function storedToken(session: StoredSession, target: Exclude<TokenTarget, "all">): StoredToken {
  if (target === "access") return session.accessToken;
  if (target === "skype") return session.skypeToken;
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
  for (const target of targets) {
    const previousToken = storedToken(result.before, target);
    const currentToken = storedToken(result.after, target);
    const current = describeStoredToken(currentToken, now);
    lines.push(`${labels[target]}:`);
    const previous = describeStoredToken(previousToken, now);
    lines.push(
      `  Before audience: ${previous.audience ?? "unknown"}`,
      `  Before expiry: ${previous.expiresAt} (${formatDuration(previous.expiresInSeconds)} remaining)`,
      `  After audience: ${current.audience ?? "unknown"}`,
      `  After expiry: ${current.expiresAt} (${formatDuration(current.expiresInSeconds)} remaining)`,
    );
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
type SendTargetOptions = TargetOptions & { person?: string };

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function policyDecisionSummary(resolved: ResolvedPolicies): string {
  const active = resolved.policies.filter(({ policy }) => policy.active).length;
  if (active === 0) return "Allowed: no active policy applies.\n";
  return `Allowed by ${active} active polic${active === 1 ? "y" : "ies"}.\n`;
}

export function selectedTarget(options: TargetOptions): MessageTarget {
  if ((options.chat ? 1 : 0) + (options.channel ? 1 : 0) !== 1) {
    throw new Error("Exactly one of --chat or --channel is required");
  }
  return options.chat
    ? { kind: "chat", id: options.chat }
    : { kind: "channel", id: options.channel as string };
}

export function selectedSendTarget(options: SendTargetOptions): MessageTarget | string {
  if ((options.chat ? 1 : 0) + (options.channel ? 1 : 0) + (options.person ? 1 : 0) !== 1) {
    throw new Error("Exactly one of --person, --chat, or --channel is required");
  }
  return options.person ?? selectedTarget(options);
}

function resolvePolicyMessageTarget(
  identity: Identity,
  target: MessageTarget,
): MessageTarget {
  if (target.kind === "channel" || target.category) return target;
  const encodedPeople = /^19:([^_@]+)_([^@]+)@unq\.gbl\.spaces$/i.exec(target.id)?.slice(1);
  if (!encodedPeople) return { ...target, category: "group" };
  const personIds = [...new Set(encodedPeople.flatMap((value) => {
    const decoded = decodeURIComponent(value);
    const objectId = decoded.startsWith("8:orgid:") ? decoded.slice("8:orgid:".length) : decoded;
    return objectId === identity.userId ? [] : [decoded, objectId, `8:orgid:${objectId}`];
  }))];
  return { ...target, category: "person", personIds };
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

export function createProgram(options: ProgramOptions = {}): Command {
  const paths = storagePaths(options.storageRoot);
  const subjectPath = options.subjectPath;
  const interactiveAuth: InteractiveAuthSupport = {
    confirm: options.confirm ?? terminalConfirmation,
    login: options.loginImplementation ?? login,
  };
  const program = new Command()
    .name("teams-cli")
    .description("A safety-conscious command-line client for persistent Microsoft Teams sessions")
    .option("-V, --version", "Show the installed version and build provenance")
    .option("--debug", "Show sanitized HTTP request diagnostics")
    .option("--profile <name>", "Optional named profile for selecting another identity")
    .option("--tenant <tenant-id>", "Optional expected Microsoft tenant ID")
    .option("--user <user-id>", "Optional expected Microsoft user object ID")
    .addOption(new Option("--browser <browser>", "Dedicated browser profile used for Microsoft sign-in").choices(["edge", "chrome"]))
    .showHelpAfterError();

  const versionOptions = {
    ...(options.storageRoot ? { storageRoot: options.storageRoot } : {}),
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    ...(options.environment ? { environment: options.environment } : {}),
  };
  registerVersionCommand(program, versionOptions);
  program.action(async () => {
    if (program.opts().version === true) {
      await showAdaptiveVersion(versionOptions);
      return;
    }
    program.outputHelp();
  });
  registerSkillsCommand(program, options.storageRoot);
  const runLogin = async (loginOptions: LoginCommandOptions) => {
    const context = await runtimeContext(program, paths);
    const policies = await resolvePolicies(paths, subjectPath);
    const reportPolicyWarnings = policyWarningReporter();
    reportPolicyWarnings(policyStatusWarnings(policies));
    if (context.tenantId && context.userId) {
      reportPolicyWarnings(requirePolicyIdentity(policies, {
        tenantId: context.tenantId,
        userId: context.userId,
      }));
    }
    const selectedUsername = loginOptions.username ?? context.username;
    process.stderr.write(`Opening a dedicated ${browserLabel(context)} profile for Teams sign-in…\n`);
    const session = await runWithStatus(program, false, "Signing in…", () => interactiveAuth.login(paths, {
      browser: context.browser,
      ...(context.tenantId ? { tenant: context.tenantId } : {}),
      ...(context.userId ? { user: context.userId } : {}),
      ...(selectedUsername ? { username: selectedUsername } : {}),
      ...(loginOptions.passwordCommand ? { passwordCommand: loginOptions.passwordCommand } : {}),
      ...(loginOptions.headless ? { headless: true } : {}),
      authorizeIdentity: async (identity) => {
        reportPolicyWarnings(requirePolicyIdentity(policies, identity));
      },
    }));
    await saveProfile(paths, context.profileName, {
      tenantId: session.tenantId,
      userId: session.userId,
      ...(session.username ? { username: session.username } : selectedUsername ? { username: selectedUsername } : {}),
      browser: context.browser,
    });
    process.stdout.write(`Logged in to tenant ${session.tenantId}.\n`);
  };
  const configureLoginCommand = (command: Command): Command => command
    .description("Sign in with Microsoft and save the Teams session")
    .option("--username <login-name>", "Microsoft login name used by automated login")
    .option("--password-command <absolute-path>", "Executable that writes the password to stdout")
    .option("--headless", "Run automated login without a visible browser")
    .action(runLogin);

  configureLoginCommand(program.command("login"));
  const auth = program.command("auth").description("Manage Microsoft Teams authentication");
  configureLoginCommand(auth.command("login"));

  auth
    .command("refresh")
    .description("Refresh all tokens or one token")
    .addArgument(
      new Argument("[token]", "Token to refresh")
        .choices(["all", "access", "skype", "chat", "search"])
        .default("all"),
    )
    .action(async (target: RefreshTarget) => {
      const runtime = await authorizedRuntime(program, paths, subjectPath, policyWarningReporter(), interactiveAuth);
      const result = await runWithStatus(program, false, `Refreshing ${target} token${target === "all" ? "s" : ""}…`, () =>
        withInteractiveLoginRecovery(paths, runtime, subjectPath, interactiveAuth, () =>
          refreshTokens(paths, runtime.identity, target, runtime.context.browser)));
      process.stdout.write(renderRefreshResult(result));
    });

  auth
    .command("whoami")
    .description("Validate the saved session and show its user and token expiry")
    .action(async () => {
      const runtime = await authorizedRuntime(program, paths, subjectPath, policyWarningReporter(), interactiveAuth);
      const session = await runWithStatus(program, false, "Validating session…", () =>
        withInteractiveLoginRecovery(paths, runtime, subjectPath, interactiveAuth, () =>
          validateSession(paths, runtime.identity, runtime.context.browser)));
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
    .action(async (target: TokenTarget, tokenOptions: { decode?: boolean }) => {
      const runtime = await authorizedRuntime(program, paths, subjectPath, policyWarningReporter(), interactiveAuth);
      if (!tokenOptions.decode) {
        runtime.reportPolicyWarnings(requireRawTokenExport(runtime.policies, runtime.identity));
      }
      const session = requireCurrentSession(await loadSession(paths, runtime.identity));
      process.stdout.write(renderTokens(session, target, tokenOptions.decode ?? false));
    });

  auth
    .command("logout")
    .description("Remove the saved session and dedicated browser profiles")
    .action(async () => {
      const runtime = await authorizedRuntime(program, paths, subjectPath, policyWarningReporter(), interactiveAuth, false);
      await logout(paths, runtime.identity);
      process.stdout.write("Logged out. Local Teams tokens and browser profiles were removed.\n");
    });

  const profile = program.command("profile").description("Manage optional named configuration profiles");
  profile.command("list").description("List configured profiles").action(async () => {
    const config = await loadProfiles(paths);
    const names = Object.keys(config.profiles).sort();
    process.stdout.write(names.length ? `${names.join("\n")}\n` : "No profiles configured.\n");
  });
  profile.command("show").description("Show one profile or the selected profile")
    .argument("[name]", "Profile name")
    .action(async (name?: string) => {
      const context = await runtimeContext(program, paths);
      const profileName = name ?? context.profileName;
      const config = await loadProfiles(paths);
      const stored = config.profiles[profileName];
      if (!stored) throw new Error(`Profile ${profileName} does not exist`);
      process.stdout.write(stringify({ name: profileName, ...stored }));
    });
  profile.command("save").description("Save the effective tenant, user, and browser as a profile")
    .argument("<name>", "Profile name")
    .action(async (name: string) => {
      const context = await runtimeContext(program, paths);
      const identity = requireRuntimeIdentity(context);
      const session = requireCurrentSession(await loadSession(paths, identity));
      await saveProfile(paths, name, {
        ...identity,
        ...(session.username ? { username: session.username } : {}),
        browser: context.browser,
      });
      process.stdout.write(`Saved profile ${name}.\n`);
    });
  profile.command("remove").description("Remove profile configuration without deleting its session")
    .argument("<name>", "Profile name")
    .action(async (name: string) => {
      if (!await removeProfile(paths, name)) throw new Error(`Profile ${name} does not exist`);
      process.stdout.write(`Removed profile ${name}. Authentication was retained.\n`);
    });

  const policy = program.command("policy").description("Manage subject-based safety policies");
  policy.command("init").description("Create a restrictive inactive policy")
    .argument("<name>", "Policy name")
    .option("--subject <absolute-path-glob>", "Subject path glob; repeat for multiple paths", collect, [])
    .action(async (name: string, policyOptions: { subject: string[] }) => {
      const context = await runtimeContext(program, paths);
      const record = await initializePolicy(paths, name, context, policyOptions.subject, subjectPath);
      process.stdout.write(`Created inactive policy ${record.policy.name} at ${record.file}.\n`);
      process.stderr.write("Warning: The policy is in audit mode and is not enforcing restrictions.\n");
    });
  policy.command("list").description("List all policies")
    .action(async () => {
      const records = await loadPolicyStore(paths);
      if (records.length === 0) {
        process.stdout.write("No policies configured.\n");
        return;
      }
      for (const record of records) {
        process.stdout.write(`${record.policy.name}\t${record.policy.active ? "active" : "inactive"}\t${record.file}\n`);
      }
    });
  policy.command("show").description("Show one named policy or policies applying to a path")
    .argument("[name]", "Policy name")
    .option("--path <path>", "Concrete subject path to evaluate")
    .action(async (name: string | undefined, policyOptions: { path?: string }) => {
      const reportWarnings = policyWarningReporter();
      if (name) {
        const record = await resolvePolicyByName(paths, name);
        reportWarnings(record.permissionWarnings);
        process.stdout.write(`# ${record.file}\n${stringify(record.policy)}`);
        return;
      }
      const resolved = await resolvePolicies(paths, policyOptions.path ?? subjectPath);
      reportWarnings(policyStatusWarnings(resolved));
      if (resolved.policies.length === 0) {
        process.stdout.write(`No policy applies to subject path ${resolved.subjectPath}.\n`);
        return;
      }
      for (const [index, record] of resolved.policies.entries()) {
        if (index > 0) process.stdout.write("---\n");
        process.stdout.write(`# ${record.file}\n${stringify(record.policy)}`);
      }
    });
  const policyCheck = policy.command("check").description("Check an effective policy decision");
  policyCheck.command("send").description("Check a chat or channel send")
    .option("--chat <chat-id>", "Target chat ID")
    .option("--channel <channel-id>", "Target channel ID")
    .option("--path <path>", "Concrete subject path to evaluate")
    .action(async (checkOptions: TargetOptions & { path?: string }) => {
      const context = await runtimeContext(program, paths);
      const identity = requireRuntimeIdentity(context);
      const resolved = await resolvePolicies(paths, checkOptions.path ?? subjectPath);
      const reportWarnings = policyWarningReporter();
      reportWarnings(policyStatusWarnings(resolved));
      reportWarnings(requireMessageSend(resolved, identity, selectedTarget(checkOptions)));
      process.stdout.write(policyDecisionSummary(resolved));
    });
  policyCheck.command("read").description("Check a chat or channel message read")
    .option("--chat <chat-id>", "Target chat ID")
    .option("--channel <channel-id>", "Target channel ID")
    .option("--path <path>", "Concrete subject path to evaluate")
    .action(async (checkOptions: TargetOptions & { path?: string }) => {
      const context = await runtimeContext(program, paths);
      const identity = requireRuntimeIdentity(context);
      const resolved = await resolvePolicies(paths, checkOptions.path ?? subjectPath);
      const reportWarnings = policyWarningReporter();
      reportWarnings(policyStatusWarnings(resolved));
      reportWarnings(requireMessageRead(resolved, identity, selectedTarget(checkOptions)));
      process.stdout.write(policyDecisionSummary(resolved));
    });
  policyCheck.command("raw-tokens").description("Check raw bearer-token export")
    .option("--path <path>", "Concrete subject path to evaluate")
    .action(async (checkOptions: { path?: string }) => {
      const context = await runtimeContext(program, paths);
      const identity = requireRuntimeIdentity(context);
      const resolved = await resolvePolicies(paths, checkOptions.path ?? subjectPath);
      const reportWarnings = policyWarningReporter();
      reportWarnings(policyStatusWarnings(resolved));
      reportWarnings(requireRawTokenExport(resolved, identity));
      process.stdout.write(policyDecisionSummary(resolved));
    });
  policy.command("activate").description("Activate one policy for enforcement")
    .argument("<name>", "Policy name")
    .action(async (name: string) => {
      const activated = await activatePolicy(await resolvePolicyByName(paths, name));
      process.stdout.write(`Activated policy ${activated.policy.name} at ${activated.file}.\n`);
      const instruction = policyProtectionInstruction(activated.file);
      if (instruction) {
        process.stderr.write(`Recommended additional protection: ${instruction}\n`);
      } else {
        process.stderr.write("Protect the active policy with an administrator-managed read-only ACL.\n");
      }
    });
  policy.command("edit").description("Open the temporary browser policy editor")
    .argument("[name]", "Policy name to select")
    .option("--port <number>", "Local editor port", (value: string) => {
      const port = Number(value);
      if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("--port must be an integer from 1 to 65535");
      return port;
    })
    .option("--open", "Open the editor in the system browser")
    .action(async (name: string | undefined, editorOptions: { port?: number; open?: boolean }) => {
      const context = await runtimeContext(program, paths);
      const result = await startPolicyEditor({
        paths,
        context,
        ...(subjectPath ? { subjectStart: subjectPath } : {}),
        ...(name ? { requestedName: name } : {}),
        ...(editorOptions.port ? { port: editorOptions.port } : {}),
        open: editorOptions.open ?? false,
        version: CLI_VERSION,
      });
      const canonical = await canonicalSubjectPath(subjectPath);
      const records = await inspectPolicyStore(paths, canonical);
      const active = records.filter((record) => record.applies && record.policy?.active).length;
      process.stdout.write(`Policy editor closed (${result.reason}). ${active} active polic${active === 1 ? "y" : "ies"} appl${active === 1 ? "ies" : "y"} to ${canonical}.\n`);
    });

  const person = program.command("person").description("Search and inspect Microsoft Teams people");
  person.command("search")
    .description("Search for people by name or email")
    .argument("<query>", "Person name or email query")
    .option("--json", "Output stable JSON")
    .action(async (query: string, options: { json?: boolean }) => {
      const result = await runWithStatus(program, options.json ?? false, "Searching for people…", () =>
        withAuthorizedDataSession(program, paths, subjectPath, "search", (session) => searchPeople(session, query), interactiveAuth));
      writeData(result, renderPeople(result), options.json ?? false);
    });
  person.command("get")
    .description("Get a detailed person profile by email, object ID, or MRI")
    .argument("<email-or-id>", "Email address, object ID, or Teams MRI")
    .option("--json", "Output stable JSON")
    .action(async (identifier: string, options: { json?: boolean }) => {
      const result = await runWithStatus(program, options.json ?? false, "Loading person profile…", () =>
        withAuthorizedDataSession(program, paths, subjectPath, "access", (session) => getPerson(session, identifier), interactiveAuth));
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
        withAuthorizedDataSession(program, paths, subjectPath, "access", (session) => getPersonImage(session, identifier, options.size), interactiveAuth));
      process.stdout.write(personImageOutput(result, base64, Boolean(process.stdout.isTTY)));
    });

  const chat = program.command("chat").description("Read Microsoft Teams chats");
  chat
    .command("search")
    .description("Search server-ranked chats and people without loading the full chat collection")
    .argument("<query>", "Chat name or participant query")
    .option("--json", "Output stable JSON")
    .action(async (query: string, options: { json?: boolean }) => {
      const result = await runWithStatus(program, options.json ?? false, "Searching chats…", () =>
        withAuthorizedDataSession(program, paths, subjectPath, ["search", "skype"], (session) => searchChats(session, query), interactiveAuth));
      writeData(result, renderChats(result), options.json ?? false);
    });
  chat
    .command("list")
    .description("List the server-provided chat collection and participants; may return every chat")
    .option("--cursor <cursor>", "Opaque cursor returned by the previous page")
    .option("--all", "Confirm that the initial request may return the complete chat collection")
    .option("--json", "Output stable JSON")
    .action(async (options: { cursor?: string; all?: boolean; json?: boolean }) => {
      if (!options.cursor) await requireChatCollectionConfirmation(options.all, interactiveAuth.confirm);
      const result = await runWithStatus(program, options.json ?? false, "Loading chats…", () =>
        withAuthorizedDataSession(program, paths, subjectPath, ["chat", "skype"], (session) => listChats(session, options.cursor), interactiveAuth));
      writeData(result, renderChats(result), options.json ?? false);
    });
  chat
    .command("get")
    .description("Get one chat by ID through the potentially complete chat collection")
    .argument("<chat-id>", "Teams chat ID")
    .option("--all", "Confirm that the lookup may return the complete chat collection")
    .option("--json", "Output stable JSON")
    .action(async (chatId: string, options: { all?: boolean; json?: boolean }) => {
      await requireChatCollectionConfirmation(options.all, interactiveAuth.confirm);
      const result = await runWithStatus(program, options.json ?? false, "Loading chat…", () =>
        withAuthorizedDataSession(program, paths, subjectPath, ["chat", "skype"], (session) => getChat(session, chatId), interactiveAuth));
      writeData(result, renderChatResult(result), options.json ?? false);
    });

  const channel = program.command("channel").description("Read Microsoft Teams channels");
  channel.command("list").description("List channels across available teams")
    .option("--json", "Output stable JSON")
    .action(async (options: { json?: boolean }) => {
      const result = await runWithStatus(program, options.json ?? false, "Loading channels…", () =>
        withAuthorizedDataSession(program, paths, subjectPath, ["chat", "skype"], (session) => listChannels(session), interactiveAuth));
      writeData(result, renderChannels(result), options.json ?? false);
    });
  channel.command("get").description("Get one channel by ID")
    .argument("<channel-id>", "Teams channel ID")
    .option("--json", "Output stable JSON")
    .action(async (channelId: string, options: { json?: boolean }) => {
      const result = await runWithStatus(program, options.json ?? false, "Loading channel…", () =>
        withAuthorizedDataSession(program, paths, subjectPath, ["chat", "skype"], (session) => getChannel(session, channelId), interactiveAuth));
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
        withAuthorizedDataSession(program, paths, subjectPath, ["chat", "skype"], async (session, runtime) => {
          const policyTarget = resolvePolicyMessageTarget(runtime.identity, target);
          return listMessages(session, target, options, undefined, async () => {
            const current = await resolvePolicies(paths, subjectPath);
            runtime.reportPolicyWarnings(policyStatusWarnings(current));
            runtime.reportPolicyWarnings(requireMessageRead(current, runtime.identity, policyTarget));
          });
        }, interactiveAuth));
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
        withAuthorizedDataSession(program, paths, subjectPath, ["chat", "skype"], async (session, runtime) => {
          const policyTarget = resolvePolicyMessageTarget(runtime.identity, target);
          return getMessage(session, target, messageId, undefined, async () => {
            const current = await resolvePolicies(paths, subjectPath);
            runtime.reportPolicyWarnings(policyStatusWarnings(current));
            runtime.reportPolicyWarnings(requireMessageRead(current, runtime.identity, policyTarget));
          });
        }, interactiveAuth));
      writeData(result, renderMessageResult(result), options.json ?? false);
    });
  message.command("send").description("Send one policy-authorized plain-text message")
    .option("--person <email-or-id>", "Recipient email address or Microsoft user object ID")
    .option("--chat <chat-id>", "Target chat ID")
    .option("--channel <channel-id>", "Target channel ID")
    .option("--body <text>", "Plain-text message body; otherwise read stdin")
    .option("--json", "Output stable JSON")
    .action(async (options: SendTargetOptions & { body?: string; json?: boolean }) => {
      const selection = selectedSendTarget(options);
      const body = await messageBody(options.body);
      const requestId = `${Date.now()}${randomInt(1_000_000).toString().padStart(6, "0")}`;
      const sessionId = randomUUID();
      let externalRecipientConfirmed = false;
      const result = await runWithStatus(program, options.json ?? false, "Sending message…", async () => {
        const targets: readonly DataTokenTarget[] = typeof selection === "string"
          ? ["access", "chat", "skype"]
          : ["chat", "skype"];
        return withAuthorizedDataSession(program, paths, subjectPath, targets, async (session, runtime) => {
          let target: MessageTarget;
          let policyTarget: MessageTarget;
          let confirmation: { recipient: string; tenant: string } | undefined;
          if (typeof selection === "string") {
            const direct = await resolveDirectMessageTarget(session, selection);
            if (selection.includes("@") && !direct.sameTenantMember && !externalRecipientConfirmed) {
              confirmation = {
                recipient: direct.person.displayName ?? direct.person.email ?? selection,
                tenant: direct.person.tenantName ?? direct.person.tenantId ?? "an unverified tenant",
              };
            }
            target = direct.target;
            policyTarget = direct.target;
          } else {
            target = selection;
            policyTarget = resolvePolicyMessageTarget(runtime.identity, target);
          }
          runtime.reportPolicyWarnings(requireMessageSend(runtime.policies, runtime.identity, policyTarget));
          if (confirmation) {
            clearStatus();
            if (!await interactiveAuth.confirm(
              `${confirmation.recipient} is not verified as a member of the current tenant (${confirmation.tenant}). Send the message anyway?`,
            )) {
              throw new Error(
                `Message not sent. Confirm the external recipient in an interactive terminal, or use the recipient's Microsoft user object ID when you already know it.`,
              );
            }
            externalRecipientConfirmed = true;
          }
          return sendMessage(session, target, body, requestId, sessionId, async () => {
            const currentPolicies = await resolvePolicies(paths, subjectPath);
            runtime.reportPolicyWarnings(policyStatusWarnings(currentPolicies));
            runtime.reportPolicyWarnings(requireMessageSend(currentPolicies, runtime.identity, policyTarget));
          });
        }, interactiveAuth);
      });
      writeData(result, renderMessageSendResult(result), options.json ?? false);
    });

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
    const versionInvocation = process.argv[2] === "version" || process.argv.includes("--version") || process.argv.includes("-V");
    if (!versionInvocation) {
      const paths = storagePaths();
      const channel = await resolveUpdateChannel({ paths, installedChannel: BUILD_INFO.channel });
      await prepareUpdateNotification({ currentVersion: CLI_VERSION, channel, installedChannel: BUILD_INFO.channel });
    }
    await createProgram().parseAsync(process.argv);
  };
  run().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
