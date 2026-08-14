import { readJwtMetadata, secondsUntil, type JwtMetadata } from "./jwt.js";
import {
  acquireInitialToken,
  OAuthRedirectError,
  type BrowserName,
  type LoginOptions,
} from "./oauth.js";
import {
  clearAuthentication,
  loadSession,
  prepareBrowserProfile,
  saveSession,
  type StoragePaths,
  type StoredSession,
  type StoredToken,
} from "./storage.js";
import {
  exchangeInitialToken,
  TeamsAuthError,
  type TeamsSession,
} from "./teams-auth.js";

export type AuthDependencies = {
  acquireToken: typeof acquireInitialToken;
  exchangeToken: typeof exchangeInitialToken;
  now: () => Date;
};

const defaultDependencies: AuthDependencies = {
  acquireToken: acquireInitialToken,
  exchangeToken: exchangeInitialToken,
  now: () => new Date(),
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
  };
};

export type TokenResult = {
  value: string;
  audience: string | null;
  expiresAt: string;
  expiresInSeconds: number;
};

export type RefreshTarget = "all" | "access" | "skype";

export type RefreshResult = {
  target: RefreshTarget;
  before: StoredSession;
  after: StoredSession;
};

function tokenExpiry(metadata: JwtMetadata, expiresIn?: number, now = new Date()): string {
  if (metadata.expiresAt) return metadata.expiresAt;
  if (expiresIn !== undefined) return new Date(now.getTime() + expiresIn * 1000).toISOString();
  throw new Error("Teams returned a token without an expiry");
}

function createStoredSession(
  accessToken: string,
  exchanged: TeamsSession,
  browser: BrowserName,
  expectedTenant: string | undefined,
  now: Date,
): StoredSession {
  const access = readJwtMetadata(accessToken);
  const skype = readJwtMetadata(exchanged.skypeToken);
  if (access.tenantId && skype.tenantId && access.tenantId !== skype.tenantId) {
    throw new Error("Teams returned tokens for different tenants");
  }
  if (expectedTenant && access.tenantId && expectedTenant !== access.tenantId) {
    throw new Error(`Teams returned a token for unexpected tenant ${access.tenantId}`);
  }
  const tenantId = access.tenantId ?? skype.tenantId;
  if (!tenantId) throw new Error("Teams returned tokens without a tenant ID");
  return {
    version: 1,
    browser,
    tenantId,
    savedAt: now.toISOString(),
    accessToken: { value: accessToken, expiresAt: tokenExpiry(access, undefined, now) },
    skypeToken: {
      value: exchanged.skypeToken,
      expiresAt: tokenExpiry(skype, exchanged.expiresIn, now),
    },
  };
}

async function acquireAndExchange(
  paths: StoragePaths,
  options: Omit<LoginOptions, "profileDirectory">,
  dependencies: AuthDependencies,
  expectedTenant?: string,
): Promise<StoredSession> {
  const profileDirectory = await prepareBrowserProfile(paths, options.browser);
  const acquired = await dependencies.acquireToken({ ...options, profileDirectory });
  try {
    const exchanged = await dependencies.exchangeToken(acquired.token);
    return createStoredSession(
      acquired.token,
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
    { browser: options.browser, interactive: true, ...(options.tenant ? { tenant: options.tenant } : {}) },
    dependencies,
    options.tenant,
  );
  await saveSession(paths, session);
  return session;
}

function validateTokenTenant(token: string, expectedTenant: string): JwtMetadata {
  const metadata = readJwtMetadata(token);
  if (!metadata.tenantId) throw new Error("Teams returned a token without a tenant ID");
  if (metadata.tenantId !== expectedTenant) {
    throw new Error(`Teams returned a token for unexpected tenant ${metadata.tenantId}`);
  }
  return metadata;
}

function interactiveRefreshError(error: unknown): never {
  if (error instanceof OAuthRedirectError) {
    throw new Error(
      `Microsoft could not refresh the session without interaction (${error.code}). Run \`teams-cli auth login\`.`,
    );
  }
  throw error;
}

async function refreshAll(
  paths: StoragePaths,
  session: StoredSession,
  dependencies: AuthDependencies,
): Promise<StoredSession> {
  try {
    return await acquireAndExchange(
      paths,
      {
        browser: session.browser,
        interactive: false,
        tenant: session.tenantId,
      },
      dependencies,
      session.tenantId,
    );
  } catch (error) {
    interactiveRefreshError(error);
  }
}

async function refreshAccess(
  paths: StoragePaths,
  session: StoredSession,
  dependencies: AuthDependencies,
): Promise<StoredSession> {
  const profileDirectory = await prepareBrowserProfile(paths, session.browser);
  try {
    const acquired = await dependencies.acquireToken({
      browser: session.browser,
      interactive: false,
      tenant: session.tenantId,
      profileDirectory,
    });
    try {
      const metadata = validateTokenTenant(acquired.token, session.tenantId);
      return {
        ...session,
        savedAt: dependencies.now().toISOString(),
        accessToken: {
          value: acquired.token,
          expiresAt: tokenExpiry(metadata, undefined, dependencies.now()),
        },
      };
    } finally {
      await acquired.close();
    }
  } catch (error) {
    interactiveRefreshError(error);
  }
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
  return {
    ...session,
    savedAt: dependencies.now().toISOString(),
    skypeToken: {
      value: exchanged.skypeToken,
      expiresAt: tokenExpiry(metadata, exchanged.expiresIn, dependencies.now()),
    },
  };
}

export async function refreshTokens(
  paths: StoragePaths,
  target: RefreshTarget = "all",
  dependencies = defaultDependencies,
): Promise<RefreshResult> {
  const stored = await loadSession(paths);
  const session = target === "all"
    ? await refreshAll(paths, stored, dependencies)
    : target === "access"
      ? await refreshAccess(paths, stored, dependencies)
      : await refreshSkype(stored, dependencies);
  await saveSession(paths, session);
  return { target, before: stored, after: session };
}

export async function validateSession(
  paths: StoragePaths,
  dependencies = defaultDependencies,
): Promise<StoredSession> {
  const stored = await loadSession(paths);
  let session = stored;
  const isExpired = secondsUntil(stored.accessToken.expiresAt, dependencies.now()) === 0;
  if (isExpired) {
    session = await refreshAll(paths, stored, dependencies);
  } else {
    try {
      const exchanged = await dependencies.exchangeToken(stored.accessToken.value);
      session = createStoredSession(
        stored.accessToken.value,
        exchanged,
        stored.browser,
        stored.tenantId,
        dependencies.now(),
      );
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
    },
  };
}

export async function logout(paths: StoragePaths): Promise<void> {
  await clearAuthentication(paths);
}
