import type { DataTokenTarget } from "./auth.js";
import {
  InteractiveLoginRequiredError,
  login
} from "./auth.js";
import { withDataSession } from "./data.js";

import {
  requireRuntimeIdentity,
  saveProfile,
  type RuntimeContext
} from "./config.js";
import { startPolicyEditor } from "./policy-editor.js";
import {
  policyStatusWarnings,
  requirePolicyIdentity,
  resolvePolicies,
  type ResolvedPolicies
} from "./policy.js";
import {
  loadSession,
  requireCurrentSession,
  type Identity,
  type StoragePaths,
  type StoredSession
} from "./storage.js";
import { CLI_VERSION } from "./version.js";

import { confirmTerminal, notice } from "./terminal.js";
export type ConfirmPrompt = (question: string) => Promise<boolean>;
export type LoginImplementation = typeof login;

export type InteractiveAuthSupport = {
  confirm: ConfirmPrompt;
  login: LoginImplementation;
};

export type AuthorizedRuntime = {
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

export function policyWarningReporter(): (warnings: readonly string[]) => void {
  const reported = new Set<string>();
  return (warnings) => {
    for (const warning of warnings) {
      if (reported.has(warning)) continue;
      reported.add(warning);
      notice(`Warning: ${warning}.\n`);
    }
  };
}

export function browserLabel(context: RuntimeContext): string {
  return context.browser === "edge" ? "Microsoft Edge" : "Google Chrome";
}

export async function requireChatCollectionConfirmation(
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
  notice(`Opening a dedicated ${browserLabel(context)} profile for Teams sign-in…\n`);
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

export async function authorizedRuntime(
  resolveContext: () => Promise<RuntimeContext>,
  paths: StoragePaths,
  subjectStart?: string,
  reportPolicyWarnings = policyWarningReporter(),
  interactiveAuth: InteractiveAuthSupport = { confirm: confirmTerminal, login },
  offerLogin = true,
): Promise<AuthorizedRuntime> {
  let context = await resolveContext();
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
    if (await confirmTerminal(`${message}. Open the policy editor?`)) {
      await startPolicyEditor({ paths, context, ...(subjectStart ? { subjectStart } : {}), open: true, version: CLI_VERSION });
      policies = await resolvePolicies(paths, subjectStart);
      if (!policies.policies.some(({ policy }) => policy.active)) notice(`Warning: The editor closed without an active policy for ${policies.subjectPath}.`);
    } else {
      notice(`Warning: ${message}. Run \`${editorCommand(context)}\` to configure least-privilege access.`);
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

export async function withInteractiveLoginRecovery<T>(
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

export async function withAuthorizedDataSession<T>(
  resolveContext: () => Promise<RuntimeContext>,
  paths: StoragePaths,
  subjectStart: string | undefined,
  targets: DataTokenTarget | readonly DataTokenTarget[],
  operation: (session: StoredSession, runtime: AuthorizedRuntime) => Promise<T>,
  interactiveAuth: InteractiveAuthSupport = { confirm: confirmTerminal, login },
): Promise<T> {
  const runtime = await authorizedRuntime(resolveContext, paths, subjectStart, policyWarningReporter(), interactiveAuth);
  return withInteractiveLoginRecovery(paths, runtime, subjectStart, interactiveAuth, () =>
    withDataSession(
      paths,
      runtime.identity,
      runtime.context.browser,
      targets,
      (session) => operation(session, runtime),
    ));
}
