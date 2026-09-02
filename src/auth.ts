import {
  CHAT_SVC_AGG_RESOURCE,
  OUTLOOK_SEARCH_RESOURCE,
  SKYPE_RESOURCE,
} from "./constants.js";
import { readJwtMetadata, secondsUntil, type JwtMetadata } from "./jwt.js";
import {
  acquireResourceTokens,
  OAuthRedirectError,
  type BrowserName,
  type LoginOptions,
} from "./oauth.js";
import {
  clearAuthentication,
  discardStagingBrowserProfile,
  loadSession,
  prepareBrowserProfile,
  prepareStagingBrowserProfile,
  promoteStagingBrowserProfile,
  requireCurrentSession,
  saveSession,
  type Identity,
  type StoragePaths,
  type StoredSession,
  type StoredToken,
} from "./storage.js";
import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import {
  exchangeInitialToken,
  TeamsAuthError,
  type TeamsSession,
} from "./teams-auth.js";

const ALL_RESOURCES = [SKYPE_RESOURCE, CHAT_SVC_AGG_RESOURCE, OUTLOOK_SEARCH_RESOURCE] as const;

export type AuthDependencies = {
  acquireTokens: typeof acquireResourceTokens;
  exchangeToken: typeof exchangeInitialToken;
  now: () => Date;
};

const defaultDependencies: AuthDependencies = {
  acquireTokens: acquireResourceTokens,
  exchangeToken: exchangeInitialToken,
  now: () => new Date(),
};

export type TokenResult = {
  value: string;
  audience: string | null;
  expiresAt: string;
  expiresInSeconds: number;
};

export type WhoamiResult = {
  authenticated: true;
  user: {
    id: string | null;
    name: string | null;
    username: string | null;
    tenantId: string;
  };
  tokens: {
    accessToken: TokenResult;
    skypeToken: TokenResult;
    chatToken: TokenResult;
    searchToken: TokenResult;
  };
};

export type RefreshTarget = "all" | "access" | "skype" | "chat" | "search";
export type DataTokenTarget = "access" | "skype" | "chat" | "search";

export type RefreshResult = {
  target: RefreshTarget;
  before: StoredSession;
  after: StoredSession;
};

export class InteractiveLoginRequiredError extends Error {
  constructor(readonly code: string) {
    super(`Microsoft needs an interactive sign-in (${code}).`);
    this.name = "InteractiveLoginRequiredError";
  }
}

const execFileAsync = promisify(execFile);

export async function passwordFromCommand(command: string): Promise<string> {
  if (!isAbsolute(command)) throw new Error("--password-command must be an absolute executable path");
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(command, [], {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 16 * 1024,
      windowsHide: true,
    }));
  } catch (error) {
    throw new Error("Password helper failed");
  }
  const password = stdout.replace(/\r?\n$/, "");
  if (!password.length) throw new Error("Password helper returned an empty password");
  return password;
}

function tokenExpiry(metadata: JwtMetadata, expiresIn?: number, now = new Date()): string {
  if (metadata.expiresAt) return metadata.expiresAt;
  if (expiresIn !== undefined) return new Date(now.getTime() + expiresIn * 1000).toISOString();
  throw new Error("Teams returned a token without an expiry");
}

function validateTokenIdentity(
  token: string,
  expectedTenant: string,
  expectedUser?: string,
): JwtMetadata {
  const metadata = readJwtMetadata(token);
  if (!metadata.tenantId) throw new Error("Teams returned a token without a tenant ID");
  if (metadata.tenantId !== expectedTenant) {
    throw new Error(`Teams returned a token for unexpected tenant ${metadata.tenantId}`);
  }
  if (expectedUser && metadata.userId && metadata.userId !== expectedUser) {
    throw new Error(`Teams returned a token for unexpected user ${metadata.userId}`);
  }
  return metadata;
}

function requireResource(tokens: ReadonlyMap<string, string>, resource: string): string {
  const token = tokens.get(resource);
  if (!token) throw new Error(`Microsoft login returned no token for ${resource}`);
  return token;
}

function createStoredSession(
  tokens: ReadonlyMap<string, string>,
  exchanged: TeamsSession,
  browser: BrowserName,
  expectedTenant: string | undefined,
  now: Date,
): StoredSession {
  const accessToken = requireResource(tokens, SKYPE_RESOURCE);
  const chatToken = requireResource(tokens, CHAT_SVC_AGG_RESOURCE);
  const searchToken = requireResource(tokens, OUTLOOK_SEARCH_RESOURCE);
  const access = readJwtMetadata(accessToken);
  const skype = readJwtMetadata(exchanged.skypeToken);
  const tenantId = access.tenantId ?? skype.tenantId;
  if (!tenantId) throw new Error("Teams returned tokens without a tenant ID");
  const userId = access.userId;
  if (!userId) throw new Error("Teams returned an access token without a user ID");
  if (expectedTenant && expectedTenant !== tenantId) {
    throw new Error(`Teams returned a token for unexpected tenant ${tenantId}`);
  }
  for (const token of [exchanged.skypeToken, chatToken, searchToken]) {
    validateTokenIdentity(token, tenantId, userId);
  }
  if (!exchanged.region) throw new Error("Teams auth exchange returned no region");
  if (!exchanged.endpoints.chatService) {
    throw new Error("Teams auth exchange returned no regional chat service endpoint");
  }
  return {
    version: 3,
    browser,
    tenantId,
    userId,
    ...(access.username ? { username: access.username } : {}),
    savedAt: now.toISOString(),
    region: exchanged.region,
    accessToken: { value: accessToken, expiresAt: tokenExpiry(access, undefined, now) },
    skypeToken: {
      value: exchanged.skypeToken,
      expiresAt: tokenExpiry(skype, exchanged.expiresIn, now),
    },
    chatToken: {
      value: chatToken,
      expiresAt: tokenExpiry(readJwtMetadata(chatToken), undefined, now),
    },
    searchToken: {
      value: searchToken,
      expiresAt: tokenExpiry(readJwtMetadata(searchToken), undefined, now),
    },
    endpoints: {
      chatService: exchanged.endpoints.chatService,
      ...(exchanged.endpoints.chatServiceAggregator
        ? { chatServiceAggregator: exchanged.endpoints.chatServiceAggregator }
        : {}),
      ...(exchanged.endpoints.middleTier ? { middleTier: exchanged.endpoints.middleTier } : {}),
    },
  };
}

function interactiveRefreshError(error: unknown): never {
  if (error instanceof OAuthRedirectError) {
    throw new InteractiveLoginRequiredError(error.code);
  }
  throw error;
}

async function acquireAndExchange(
  paths: StoragePaths,
  options: Omit<LoginOptions, "profileDirectory">,
  dependencies: AuthDependencies,
  expectedIdentity: { tenantId?: string; userId?: string } = {},
): Promise<StoredSession> {
  const knownIdentity = !options.interactive && expectedIdentity.tenantId && expectedIdentity.userId
    ? { tenantId: expectedIdentity.tenantId, userId: expectedIdentity.userId }
    : null;
  const staging = knownIdentity ? null : await prepareStagingBrowserProfile(paths, options.browser);
  const profileDirectory = knownIdentity
    ? await prepareBrowserProfile(paths, knownIdentity, options.browser)
    : staging?.directory as string;
  try {
    const acquired = await dependencies.acquireTokens(ALL_RESOURCES, { ...options, profileDirectory });
    let session: StoredSession;
    try {
      const exchanged = await dependencies.exchangeToken(requireResource(acquired.tokens, SKYPE_RESOURCE));
      session = createStoredSession(
        acquired.tokens,
        exchanged,
        options.browser,
        expectedIdentity.tenantId,
        dependencies.now(),
      );
      if (expectedIdentity.userId && expectedIdentity.userId !== session.userId) {
        throw new Error(`Microsoft login returned unexpected user ${session.userId}`);
      }
    } finally {
      await acquired.close();
    }
    if (staging) {
      await promoteStagingBrowserProfile(paths, staging.identifier, session, options.browser);
    }
    return session;
  } catch (error) {
    if (staging) await discardStagingBrowserProfile(paths, staging.identifier);
    throw error;
  }
}

export async function login(
  paths: StoragePaths,
  options: {
    browser: BrowserName;
    tenant?: string;
    user?: string;
    username?: string;
    password?: string;
    passwordCommand?: string;
    headless?: boolean;
    authorizeIdentity?: (identity: Identity) => Promise<void>;
  },
  dependencies = defaultDependencies,
): Promise<StoredSession> {
  if (options.password && options.passwordCommand) {
    throw new Error("Provide either a password or --password-command, not both");
  }
  if ((options.password || options.passwordCommand) && !options.username) {
    throw new Error("Automated login requires a username");
  }
  if (options.headless && !options.password && !options.passwordCommand) {
    throw new Error("--headless login requires automated credentials");
  }
  const password = options.password ?? (options.passwordCommand
    ? await passwordFromCommand(options.passwordCommand)
    : undefined);
  const session = await acquireAndExchange(
    paths,
    {
      browser: options.browser,
      interactive: true,
      ...(options.headless ? { headless: true } : {}),
      ...(options.username ? { username: options.username } : {}),
      ...(password ? { password } : {}),
      ...(options.tenant ? { tenant: options.tenant } : {}),
    },
    dependencies,
    {
      ...(options.tenant ? { tenantId: options.tenant } : {}),
      ...(options.user ? { userId: options.user } : {}),
    },
  );
  if (options.authorizeIdentity) await options.authorizeIdentity(session);
  await saveSession(paths, session);
  return session;
}

async function refreshAll(
  paths: StoragePaths,
  session: StoredSession,
  dependencies: AuthDependencies,
  browser: BrowserName,
): Promise<StoredSession> {
  try {
    return await acquireAndExchange(
      paths,
      { browser, interactive: false, tenant: session.tenantId },
      dependencies,
      { tenantId: session.tenantId, userId: session.userId },
    );
  } catch (error) {
    interactiveRefreshError(error);
  }
}

async function acquireOneResource(
  paths: StoragePaths,
  session: StoredSession,
  resource: string,
  dependencies: AuthDependencies,
  browser: BrowserName,
): Promise<StoredToken> {
  const profileDirectory = await prepareBrowserProfile(paths, session, browser);
  try {
    const acquired = await dependencies.acquireTokens([resource], {
      browser,
      interactive: false,
      tenant: session.tenantId,
      profileDirectory,
    });
    try {
      const token = requireResource(acquired.tokens, resource);
      const metadata = validateTokenIdentity(token, session.tenantId, session.userId);
      return { value: token, expiresAt: tokenExpiry(metadata, undefined, dependencies.now()) };
    } finally {
      await acquired.close();
    }
  } catch (error) {
    interactiveRefreshError(error);
  }
}

async function refreshAccess(
  paths: StoragePaths,
  session: StoredSession,
  dependencies: AuthDependencies,
  browser: BrowserName,
): Promise<StoredSession> {
  return {
    ...session,
    savedAt: dependencies.now().toISOString(),
    browser,
    accessToken: await acquireOneResource(paths, session, SKYPE_RESOURCE, dependencies, browser),
  };
}

async function refreshOAuthTarget(
  paths: StoragePaths,
  session: StoredSession,
  target: "chat" | "search",
  dependencies: AuthDependencies,
  browser: BrowserName,
): Promise<StoredSession> {
  const resource = target === "chat" ? CHAT_SVC_AGG_RESOURCE : OUTLOOK_SEARCH_RESOURCE;
  const token = await acquireOneResource(paths, session, resource, dependencies, browser);
  return {
    ...session,
    browser,
    savedAt: dependencies.now().toISOString(),
    ...(target === "chat" ? { chatToken: token } : { searchToken: token }),
  };
}

async function refreshSkype(
  session: StoredSession,
  dependencies: AuthDependencies,
): Promise<StoredSession> {
  if (secondsUntil(session.accessToken.expiresAt, dependencies.now()) === 0) {
    throw new Error(
      "Cannot refresh the Skype token because the access token has expired. Refresh `all` or `access` first.",
    );
  }
  const exchanged = await dependencies.exchangeToken(session.accessToken.value);
  const metadata = validateTokenIdentity(exchanged.skypeToken, session.tenantId, session.userId);
  if (!exchanged.region || !exchanged.endpoints.chatService) {
    throw new Error("Teams auth exchange returned an incomplete regional endpoint map");
  }
  return {
    ...session,
    savedAt: dependencies.now().toISOString(),
    region: exchanged.region,
    skypeToken: {
      value: exchanged.skypeToken,
      expiresAt: tokenExpiry(metadata, exchanged.expiresIn, dependencies.now()),
    },
    endpoints: {
      chatService: exchanged.endpoints.chatService,
      ...(exchanged.endpoints.chatServiceAggregator
        ? { chatServiceAggregator: exchanged.endpoints.chatServiceAggregator }
        : {}),
      ...(exchanged.endpoints.middleTier ? { middleTier: exchanged.endpoints.middleTier } : {}),
    },
  };
}

export async function refreshTokens(
  paths: StoragePaths,
  identity: Identity,
  target: RefreshTarget = "all",
  browser?: BrowserName,
  dependencies = defaultDependencies,
): Promise<RefreshResult> {
  const before = requireCurrentSession(await loadSession(paths, identity));
  const selectedBrowser = browser ?? before.browser;
  const session = target === "all"
    ? await refreshAll(paths, before, dependencies, selectedBrowser)
    : target === "access"
      ? await refreshAccess(paths, before, dependencies, selectedBrowser)
      : target === "skype"
        ? await refreshSkype(before, dependencies)
        : await refreshOAuthTarget(paths, before, target, dependencies, selectedBrowser);
  await saveSession(paths, session);
  return { target, before, after: session };
}

export async function validateSession(
  paths: StoragePaths,
  identity: Identity,
  browser?: BrowserName,
  dependencies = defaultDependencies,
): Promise<StoredSession> {
  const stored = requireCurrentSession(await loadSession(paths, identity));
  const selectedBrowser = browser ?? stored.browser;
  let session: StoredSession;
  if (secondsUntil(stored.accessToken.expiresAt, dependencies.now()) === 0) {
    session = await refreshAll(paths, stored, dependencies, selectedBrowser);
  } else {
    try {
      session = await refreshSkype(stored, dependencies);
    } catch (error) {
      if (!(error instanceof TeamsAuthError) || (error.status !== 401 && error.status !== 403)) {
        throw error;
      }
      session = await refreshAll(paths, stored, dependencies, selectedBrowser);
    }
  }
  await saveSession(paths, session);
  return session;
}

function tokenForTarget(session: StoredSession, target: DataTokenTarget): StoredToken {
  return target === "access"
    ? session.accessToken
    : target === "skype"
      ? session.skypeToken
      : target === "chat"
        ? session.chatToken
        : session.searchToken;
}

export async function ensureDataSession(
  paths: StoragePaths,
  identity: Identity,
  target: DataTokenTarget,
  browser?: BrowserName,
  dependencies = defaultDependencies,
): Promise<StoredSession> {
  const session = requireCurrentSession(await loadSession(paths, identity));
  if (secondsUntil(tokenForTarget(session, target).expiresAt, dependencies.now()) > 60) {
    return session;
  }
  if (target === "skype" && secondsUntil(session.accessToken.expiresAt, dependencies.now()) <= 60) {
    await refreshTokens(paths, identity, "access", browser, dependencies);
  }
  return (await refreshTokens(paths, identity, target, browser, dependencies)).after;
}

function tokenResult(token: StoredToken, now: Date): TokenResult {
  const metadata = readJwtMetadata(token.value);
  return {
    value: token.value,
    audience: metadata.audience ?? null,
    expiresAt: token.expiresAt,
    expiresInSeconds: secondsUntil(token.expiresAt, now),
  };
}

export function describeSession(session: StoredSession, now = new Date()): WhoamiResult {
  const identity = readJwtMetadata(session.accessToken.value);
  return {
    authenticated: true,
    user: {
      id: identity.userId ?? session.userId,
      name: identity.name ?? null,
      username: identity.username ?? null,
      tenantId: session.tenantId,
    },
    tokens: {
      accessToken: tokenResult(session.accessToken, now),
      skypeToken: tokenResult(session.skypeToken, now),
      chatToken: tokenResult(session.chatToken, now),
      searchToken: tokenResult(session.searchToken, now),
    },
  };
}

export async function logout(paths: StoragePaths, identity: Identity): Promise<void> {
  await clearAuthentication(paths, identity);
}
