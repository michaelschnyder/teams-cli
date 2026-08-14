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
  type WhoamiResult,
} from "./auth.js";
import { decodeJwtClaims, formatDuration } from "./jwt.js";
import type { BrowserName } from "./oauth.js";
import { loadSession, storagePaths, type StoredSession } from "./storage.js";

type TokenTarget = "all" | "access" | "skype";

function outputWhoami(result: WhoamiResult): void {
  const user = result.user;
  process.stdout.write(`Authenticated: yes\n`);
  process.stdout.write(`Name: ${user.name ?? "unknown"}\n`);
  process.stdout.write(`Username: ${user.username ?? "unknown"}\n`);
  process.stdout.write(`User ID: ${user.id ?? "unknown"}\n`);
  process.stdout.write(`Tenant ID: ${user.tenantId}\n`);
  for (const [label, token] of [
    ["Access token", result.tokens.accessToken],
    ["Skype token", result.tokens.skypeToken],
  ] as const) {
    process.stdout.write(`${label} audience: ${token.audience ?? "unknown"}\n`);
    process.stdout.write(`  Expires: ${token.expiresAt} (${formatDuration(token.expiresInSeconds)} remaining)\n`);
  }
}

export function renderTokens(
  session: StoredSession,
  target: TokenTarget,
  decode: boolean,
): string {
  const selected = target === "access"
    ? { access: session.accessToken.value }
    : target === "skype"
      ? { skype: session.skypeToken.value }
      : { access: session.accessToken.value, skype: session.skypeToken.value };

  if (decode) {
    const claims = Object.fromEntries(
      Object.entries(selected).map(([name, token]) => [name, decodeJwtClaims(token)]),
    );
    const output = target === "all" ? claims : Object.values(claims)[0];
    return `${JSON.stringify(output, null, 2)}\n`;
  }
  if (target !== "all") return `${Object.values(selected)[0]}\n`;
  return `Access token:\n${selected.access}\n\nSkype token:\n${selected.skype}\n`;
}

export function renderRefreshResult(result: RefreshResult, now = new Date()): string {
  const before = describeSession(result.before, now).tokens;
  const after = describeSession(result.after, now).tokens;
  const targets = result.target === "all" ? ["access", "skype"] as const : [result.target];
  const lines = [`Refreshed ${result.target === "all" ? "access and Skype tokens" : `${result.target} token`}.`];
  for (const target of targets) {
    const label = target === "access" ? "Access token" : "Skype token";
    const previous = target === "access" ? before.accessToken : before.skypeToken;
    const current = target === "access" ? after.accessToken : after.skypeToken;
    lines.push(
      `${label}:`,
      `  Before audience: ${previous.audience ?? "unknown"}`,
      `  Before expiry: ${previous.expiresAt} (${formatDuration(previous.expiresInSeconds)} remaining)`,
      `  After audience: ${current.audience ?? "unknown"}`,
      `  After expiry: ${current.expiresAt} (${formatDuration(current.expiresInSeconds)} remaining)`,
    );
  }
  return `${lines.join("\n")}\n`;
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
        .choices(["all", "access", "skype"])
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
        .choices(["all", "access", "skype"])
        .default("all"),
    )
    .option("--decode", "Show only the decoded JWT claims")
    .action(async (target: TokenTarget, options: { decode?: boolean }) => {
      const session = await loadSession(paths);
      process.stdout.write(renderTokens(session, target, options.decode ?? false));
    });

  auth
    .command("logout")
    .description("Remove the saved session and dedicated browser profiles")
    .action(async () => {
      await logout(paths);
      process.stdout.write("Logged out. Local Teams tokens and browser profiles were removed.\n");
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
