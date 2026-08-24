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
  loadSession,
  prepareBrowserProfile,
  requireCurrentSession,
  saveSession,
  type AnyStoredSession,
  type StoragePaths,
  type StoredSession,
  type StoredToken,
} from "./storage.js";
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
export type DataTokenTarget = "skype" | "chat" | "search";

export type RefreshResult = {
  target: RefreshTarget;
  before: AnyStoredSession;
  after: StoredSession;
};

function tokenExpiry(metadata: JwtMetadata, expiresIn?: number, now = new Date()): string {
  if (metadata.expiresAt) return metadata.expiresAt;
  if (expiresIn !== undefined) return new Date(now.getTime() + expiresIn * 1000).toISOString();
  throw new Error("Teams returned a token without an expiry");
}

function validateTokenTenant(token: string, expectedTenant: string): JwtMetadata {
  const metadata = readJwtMetadata(token);
  if (!metadata.tenantId) throw new Error("Teams returned a token without a tenant ID");
  if (metadata.tenantId !== expectedTenant) {
    throw new Error(`Teams returned a token for unexpected tenant ${metadata.tenantId}`);
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
  if (expectedTenant && expectedTenant !== tenantId) {
    throw new Error(`Teams returned a token for unexpected tenant ${tenantId}`);
  }
  for (const token of [exchanged.skypeToken, chatToken, searchToken]) {
    validateTokenTenant(token, tenantId);
  }
  if (!exchanged.region) throw new Error("Teams auth exchange returned no region");
  if (!exchanged.endpoints.chatService) {
    throw new Error("Teams auth exchange returned no regional chat service endpoint");
  }
  return {
    version: 2,
    browser,
    tenantId,
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
    throw new Error(
      `Microsoft could not refresh the session without interaction (${error.code}). Run \`teams-cli auth login\`.`,
    );
  }
  throw error;
}

async function acquireAndExchange(
  paths: StoragePaths,
  options: Omit<LoginOptions, "profileDirectory">,
  dependencies: AuthDependencies,
  expectedTenant?: string,
): Promise<StoredSession> {
  const profileDirectory = await prepareBrowserProfile(paths, options.browser);
  const acquired = await dependencies.acquireTokens(ALL_RESOURCES, { ...options, profileDirectory });
  try {
    const exchanged = await dependencies.exchangeToken(requireResource(acquired.tokens, SKYPE_RESOURCE));
    return createStoredSession(
      acquired.tokens,
      exchanged,
      options.browser,
      expectedTenant,
      dependencies.now(),
    );
  } finally {
    await acquired.close();
  }
}

export async function login(
  paths: StoragePaths,
  options: { browser: BrowserName; tenant?: string },
  dependencies = defaultDependencies,
): Promise<StoredSession> {
  const session = await acquireAndExchange(
    paths,
    {
      browser: options.browser,
      interactive: true,
      ...(options.tenant ? { tenant: options.tenant } : {}),
    },
    dependencies,
    options.tenant,
  );
  await saveSession(paths, session);
  return session;
}

async function refreshAll(
  paths: StoragePaths,
  session: AnyStoredSession,
  dependencies: AuthDependencies,
): Promise<StoredSession> {
  try {
    return await acquireAndExchange(
      paths,
      { browser: session.browser, interactive: false, tenant: session.tenantId },
      dependencies,
      session.tenantId,
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
): Promise<StoredToken> {
  const profileDirectory = await prepareBrowserProfile(paths, session.browser);
  try {
    const acquired = await dependencies.acquireTokens([resource], {
      browser: session.browser,
      interactive: false,
      tenant: session.tenantId,
      profileDirectory,
    });
    try {
      const token = requireResource(acquired.tokens, resource);
      const metadata = validateTokenTenant(token, session.tenantId);
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
): Promise<StoredSession> {
  return {
    ...session,
    savedAt: dependencies.now().toISOString(),
    accessToken: await acquireOneResource(paths, session, SKYPE_RESOURCE, dependencies),
  };
}

async function refreshOAuthTarget(
  paths: StoragePaths,
  session: StoredSession,
  target: "chat" | "search",
  dependencies: AuthDependencies,
): Promise<StoredSession> {
  const resource = target === "chat" ? CHAT_SVC_AGG_RESOURCE : OUTLOOK_SEARCH_RESOURCE;
  const token = await acquireOneResource(paths, session, resource, dependencies);
  return {
    ...session,
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
  const metadata = validateTokenTenant(exchanged.skypeToken, session.tenantId);
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
  target: RefreshTarget = "all",
  dependencies = defaultDependencies,
): Promise<RefreshResult> {
  const before = await loadSession(paths);
  if (before.version === 1 && target !== "all") {
    throw new Error(
      "Stored Teams session is outdated. Run `teams-cli auth refresh all` to update it.",
    );
  }
  const session = target === "all"
    ? await refreshAll(paths, before, dependencies)
    : target === "access"
      ? await refreshAccess(paths, requireCurrentSession(before), dependencies)
      : target === "skype"
        ? await refreshSkype(requireCurrentSession(before), dependencies)
        : await refreshOAuthTarget(paths, requireCurrentSession(before), target, dependencies);
  await saveSession(paths, session);
  return { target, before, after: session };
}

export async function validateSession(
  paths: StoragePaths,
  dependencies = defaultDependencies,
): Promise<StoredSession> {
  const stored = requireCurrentSession(await loadSession(paths));
  let session: StoredSession;
  if (secondsUntil(stored.accessToken.expiresAt, dependencies.now()) === 0) {
    session = await refreshAll(paths, stored, dependencies);
  } else {
    try {
      session = await refreshSkype(stored, dependencies);
    } catch (error) {
      if (!(error instanceof TeamsAuthError) || (error.status !== 401 && error.status !== 403)) {
        throw error;
      }
      session = await refreshAll(paths, stored, dependencies);
    }
  }
  await saveSession(paths, session);
  return session;
}

function tokenForTarget(session: StoredSession, target: DataTokenTarget): StoredToken {
  return target === "skype"
    ? session.skypeToken
    : target === "chat"
      ? session.chatToken
      : session.searchToken;
}

export async function ensureDataSession(
  paths: StoragePaths,
  target: DataTokenTarget,
  dependencies = defaultDependencies,
): Promise<StoredSession> {
  const session = requireCurrentSession(await loadSession(paths));
  if (secondsUntil(tokenForTarget(session, target).expiresAt, dependencies.now()) > 60) {
    return session;
  }
  if (target === "skype" && secondsUntil(session.accessToken.expiresAt, dependencies.now()) <= 60) {
    await refreshTokens(paths, "access", dependencies);
  }
  return (await refreshTokens(paths, target, dependencies)).after;
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
      id: identity.userId ?? null,
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

export async function logout(paths: StoragePaths): Promise<void> {
  await clearAuthentication(paths);
}
