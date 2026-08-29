#!/usr/bin/env node
import { Argument, Command, Option } from "commander";
import { realpathSync } from "node:fs";
import { randomInt, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
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
import type { DataTokenTarget } from "./auth.js";
import { clearStatus, configureDiagnostics, showStatus } from "./diagnostics.js";
import {
  activatePolicy,
  initializePolicy,
  loadPolicyStore,
  policyProtectionInstruction,
  policyStatusWarnings,
  requireMessageSend,
  requirePolicyIdentity,
  requireRawTokenExport,
  resolvePolicies,
  resolvePolicyByName,
  type MessageTarget,
  type ResolvedPolicies,
} from "./policy.js";
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

type TokenTarget = "all" | "access" | "skype" | "chat" | "search";
type GlobalOptions = RuntimeOverrides & { debug?: boolean };

type AuthorizedRuntime = {
  context: RuntimeContext;
  identity: Identity;
  policies: ResolvedPolicies;
  reportPolicyWarnings: (warnings: readonly string[]) => void;
};

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

async function runtimeContext(program: Command, paths: StoragePaths): Promise<RuntimeContext> {
  return resolveRuntimeContext(paths, program.opts() as GlobalOptions);
}

async function authorizedRuntime(
  program: Command,
  paths: StoragePaths,
  subjectStart?: string,
  reportPolicyWarnings = policyWarningReporter(),
): Promise<AuthorizedRuntime> {
  const context = await runtimeContext(program, paths);
  const identity = requireRuntimeIdentity(context);
  const policies = await resolvePolicies(paths, subjectStart);
  reportPolicyWarnings(policyStatusWarnings(policies));
  reportPolicyWarnings(requirePolicyIdentity(policies, identity));
  return { context, identity, policies, reportPolicyWarnings };
}

async function withAuthorizedDataSession<T>(
  program: Command,
  paths: StoragePaths,
  subjectStart: string | undefined,
  targets: DataTokenTarget | readonly DataTokenTarget[],
  operation: (session: StoredSession, runtime: AuthorizedRuntime) => Promise<T>,
): Promise<T> {
  const runtime = await authorizedRuntime(program, paths, subjectStart);
  return withDataSession(
    paths,
    runtime.identity,
    runtime.context.browser,
    targets,
    (session) => operation(session, runtime),
  );
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

export function createProgram(options: { storageRoot?: string; subjectPath?: string } = {}): Command {
  const paths = storagePaths(options.storageRoot);
  const subjectPath = options.subjectPath;
  const program = new Command()
    .name("teams-cli")
    .description("A minimal command-line client for a persistent Microsoft Teams session")
    .version("0.1.0")
    .option("--debug", "Show sanitized HTTP request diagnostics")
    .option("--profile <name>", "Named configuration profile")
    .option("--tenant <tenant-id>", "Microsoft tenant ID")
    .option("--user <user-id>", "Microsoft user object ID")
    .addOption(new Option("--browser <browser>", "Browser used for Microsoft sign-in").choices(["edge", "chrome"]))
    .showHelpAfterError();
  const auth = program.command("auth").description("Manage Microsoft Teams authentication");

  auth
    .command("login")
    .description("Sign in with Microsoft and save the Teams session")
    .option("--username <login-name>", "Microsoft login name used by automated login")
    .option("--password-command <absolute-path>", "Executable that writes the password to stdout")
    .option("--headless", "Run automated login without a visible browser")
    .action(async (loginOptions: { username?: string; passwordCommand?: string; headless?: boolean }) => {
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
      process.stderr.write(`Opening ${context.browser === "edge" ? "Microsoft Edge" : "Google Chrome"} for Teams sign-in…\n`);
      const session = await runWithStatus(program, false, "Signing in…", () => login(paths, {
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
      const runtime = await authorizedRuntime(program, paths, subjectPath);
      const result = await runWithStatus(program, false, `Refreshing ${target} token${target === "all" ? "s" : ""}…`, () =>
        refreshTokens(paths, runtime.identity, target, runtime.context.browser));
      process.stdout.write(renderRefreshResult(result));
    });

  auth
    .command("whoami")
    .description("Validate the saved session and show its user and token expiry")
    .action(async () => {
      const runtime = await authorizedRuntime(program, paths, subjectPath);
      const session = await runWithStatus(program, false, "Validating session…", () =>
        validateSession(paths, runtime.identity, runtime.context.browser));
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
      const runtime = await authorizedRuntime(program, paths, subjectPath);
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
      const runtime = await authorizedRuntime(program, paths, subjectPath);
      await logout(paths, runtime.identity);
      process.stdout.write("Logged out. Local Teams tokens and browser profiles were removed.\n");
    });

  const profile = program.command("profile").description("Manage named configuration profiles");
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

  const person = program.command("person").description("Search and inspect Microsoft Teams people");
  person.command("search")
    .description("Search for people by name or email")
    .argument("<query>", "Person name or email query")
    .option("--json", "Output stable JSON")
    .action(async (query: string, options: { json?: boolean }) => {
      const result = await runWithStatus(program, options.json ?? false, "Searching for people…", () =>
        withAuthorizedDataSession(program, paths, subjectPath, "search", (session) => searchPeople(session, query)));
      writeData(result, renderPeople(result), options.json ?? false);
    });
  person.command("get")
    .description("Get a detailed person profile by email, object ID, or MRI")
    .argument("<email-or-id>", "Email address, object ID, or Teams MRI")
    .option("--json", "Output stable JSON")
    .action(async (identifier: string, options: { json?: boolean }) => {
      const result = await runWithStatus(program, options.json ?? false, "Loading person profile…", () =>
        withAuthorizedDataSession(program, paths, subjectPath, "access", (session) => getPerson(session, identifier)));
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
        withAuthorizedDataSession(program, paths, subjectPath, "access", (session) => getPersonImage(session, identifier, options.size)));
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
        withAuthorizedDataSession(program, paths, subjectPath, ["chat", "skype"], (session) => listChats(session, options.cursor)));
      writeData(result, renderChats(result), options.json ?? false);
    });
  chat
    .command("get")
    .description("Get one chat by ID")
    .argument("<chat-id>", "Teams chat ID")
    .option("--json", "Output stable JSON")
    .action(async (chatId: string, options: { json?: boolean }) => {
      const result = await runWithStatus(program, options.json ?? false, "Loading chat…", () =>
        withAuthorizedDataSession(program, paths, subjectPath, ["chat", "skype"], (session) => getChat(session, chatId)));
      writeData(result, renderChatResult(result), options.json ?? false);
    });

  const channel = program.command("channel").description("Read Microsoft Teams channels");
  channel.command("list").description("List channels across available teams")
    .option("--json", "Output stable JSON")
    .action(async (options: { json?: boolean }) => {
      const result = await runWithStatus(program, options.json ?? false, "Loading channels…", () =>
        withAuthorizedDataSession(program, paths, subjectPath, ["chat", "skype"], (session) => listChannels(session)));
      writeData(result, renderChannels(result), options.json ?? false);
    });
  channel.command("get").description("Get one channel by ID")
    .argument("<channel-id>", "Teams channel ID")
    .option("--json", "Output stable JSON")
    .action(async (channelId: string, options: { json?: boolean }) => {
      const result = await runWithStatus(program, options.json ?? false, "Loading channel…", () =>
        withAuthorizedDataSession(program, paths, subjectPath, ["chat", "skype"], (session) => getChannel(session, channelId)));
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
        withAuthorizedDataSession(program, paths, subjectPath, "skype", (session) => listMessages(session, target, options)));
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
        withAuthorizedDataSession(program, paths, subjectPath, "skype", (session) => getMessage(session, target, messageId)));
      writeData(result, renderMessageResult(result), options.json ?? false);
    });
  message.command("send").description("Send one policy-authorized plain-text message")
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
        const runtime = await authorizedRuntime(program, paths, subjectPath);
        runtime.reportPolicyWarnings(requireMessageSend(runtime.policies, runtime.identity, target));
        return withDataSession(
          paths,
          runtime.identity,
          runtime.context.browser,
          "skype",
          (session) => sendMessage(
            session,
            target,
            body,
            requestId,
            sessionId,
            async () => {
              const currentPolicies = await resolvePolicies(paths, subjectPath);
              runtime.reportPolicyWarnings(policyStatusWarnings(currentPolicies));
              runtime.reportPolicyWarnings(requireMessageSend(currentPolicies, runtime.identity, target));
            },
          ),
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
