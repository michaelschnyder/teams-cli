import { Argument } from "commander";
import {
  logout,
  refreshTokens,
  validateSession,
  type RefreshTarget
} from "../auth.js";
import { ResultCommand as Command } from "../command-runner.js";
import {
  saveProfile
} from "../config.js";
import { decodeJwtClaims } from "../jwt.js";
import {
  policyStatusWarnings,
  requirePolicyIdentity,
  requireRawTokenExport,
  resolvePolicies
} from "../policy.js";
import {
  hasDetectedAgentEnvironment,
  hasManagedSkillInstallations,
  runSkillsInstall
} from "../skill-installation.js";
import {
  loadSession,
  requireCurrentSession
} from "../storage.js";

import { type CommandServices } from "../command-services.js";
import { tokenExport } from "../export-output.js";
import { commandResult } from "../output.js";
import { safeRefresh, safeSession } from "../results.js";
import { browserLabel, policyWarningReporter, withInteractiveLoginRecovery } from "../runtime.js";
import { notice, withStatus } from "../terminal.js";
type TokenTarget = "all" | "access" | "skype" | "chat" | "search";
type LoginCommandOptions = { username?: string; passwordCommand?: string; headless?: boolean; };

export function registerAuthCommand(program: Command, services: CommandServices): void {
  const { paths, subjectPath, interactiveAuth, options, skillsOptions } = services;
  const runLogin = async (loginOptions: LoginCommandOptions) => {
    const context = await services.context();
    let skillInstallation: Awaited<ReturnType<typeof runSkillsInstall>> | undefined;
    const interactive = options.confirm !== undefined || Boolean(process.stdin.isTTY && process.stderr.isTTY);
    if (
      interactive && !loginOptions.headless && !loginOptions.passwordCommand &&
      !context.tenantId && !context.userId &&
      !await hasManagedSkillInstallations(options.storageRoot) &&
      await hasDetectedAgentEnvironment(skillsOptions) &&
      await interactiveAuth.confirm("No agent skill is installed yet. Install the teams-cli skill before signing in?")
    ) {
      skillInstallation = await runSkillsInstall(undefined, {}, skillsOptions);
    }
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
    notice(`Opening a dedicated ${browserLabel(context)} profile for Teams sign-in…\n`);
    const session = await withStatus("Signing in…", () => interactiveAuth.login(paths, {
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
    return commandResult("session", { ...safeSession(session), ...(skillInstallation ? { skillInstallation } : {}) });
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
      const runtime = await services.authorized(policyWarningReporter(), interactiveAuth);
      const result = await withStatus(`Refreshing ${target} token${target === "all" ? "s" : ""}…`, () =>
        withInteractiveLoginRecovery(paths, runtime, subjectPath, interactiveAuth, () =>
          refreshTokens(paths, runtime.identity, target, runtime.context.browser)));
      return commandResult("refresh", safeRefresh(result));
    });

  auth
    .command("whoami")
    .description("Validate the saved session and show its user and token expiry")
    .action(async () => {
      const runtime = await services.authorized(policyWarningReporter(), interactiveAuth);
      const session = await withStatus("Validating session…", () =>
        withInteractiveLoginRecovery(paths, runtime, subjectPath, interactiveAuth, () =>
          validateSession(paths, runtime.identity, runtime.context.browser)));
      return commandResult("session", safeSession(session));
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
    .action(async (target: TokenTarget, tokenOptions: { decode?: boolean; }, command: Command) => {
      const runtime = await services.authorized(policyWarningReporter(), interactiveAuth);
      if (!tokenOptions.decode) {
        runtime.reportPolicyWarnings(requireRawTokenExport(runtime.policies, runtime.identity));
      }
      const session = requireCurrentSession(await loadSession(paths, runtime.identity));
      const tokenValues = { access: session.accessToken.value, skype: session.skypeToken.value, chat: session.chatToken.value, search: session.searchToken.value };
      const selected = target === "all" ? tokenValues : { [target]: tokenValues[target] };
      if (tokenOptions.decode) return commandResult("tokens", Object.fromEntries(Object.entries(selected).map(([key, value]) => [key, decodeJwtClaims(value)])));
      const format = command.optsWithGlobals().output;
      if (format === "json" || format === "yaml" || command.optsWithGlobals().json) return commandResult("tokens", selected);
      return tokenExport(session, target);
    });

  auth
    .command("logout")
    .description("Remove the saved session and dedicated browser profiles")
    .action(async () => {
      const runtime = await services.authorized(policyWarningReporter(), interactiveAuth, false);
      await logout(paths, runtime.identity);
      return commandResult("ack", { action: "Logged out", removed: ["session", "browser profiles"] });
    });

}
