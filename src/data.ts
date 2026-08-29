import {
  refreshTokens,
  type DataTokenTarget,
} from "./auth.js";
import { debugDecision, setRequestAttempt, showStatus } from "./diagnostics.js";
import { secondsUntil } from "./jwt.js";
import {
  loadSession,
  requireCurrentSession,
  type Identity,
  type StoragePaths,
  type StoredSession,
  type StoredToken,
} from "./storage.js";
import type { BrowserName } from "./oauth.js";
import { TeamsApiError } from "./teams-client.js";

const REFRESH_SKEW_SECONDS = 60;

function tokenForTarget(session: StoredSession, target: DataTokenTarget): StoredToken {
  return target === "access"
    ? session.accessToken
    : target === "skype"
      ? session.skypeToken
      : target === "chat"
        ? session.chatToken
        : session.searchToken;
}

function label(target: DataTokenTarget | "access"): string {
  return target === "skype" ? "Skype" : target === "chat" ? "Chat" : target === "search" ? "Search" : "access";
}

async function refreshTarget(
  paths: StoragePaths,
  identity: Identity,
  browser: BrowserName,
  target: DataTokenTarget,
): Promise<StoredSession> {
  let session = requireCurrentSession(await loadSession(paths, identity));
  if (
    target === "skype" &&
    secondsUntil(session.accessToken.expiresAt) <= REFRESH_SKEW_SECONDS
  ) {
    showStatus("Refreshing access token…");
    debugDecision("refresh token=access reason=Skype-prerequisite");
    session = (await refreshTokens(paths, identity, "access", browser)).after;
  }
  showStatus(`Refreshing ${label(target)} token…`);
  debugDecision(`refresh token=${target}`);
  return (await refreshTokens(paths, identity, target, browser)).after;
}

async function prepareSession(
  paths: StoragePaths,
  identity: Identity,
  browser: BrowserName,
  targets: readonly DataTokenTarget[],
  force: boolean,
): Promise<StoredSession> {
  let session = requireCurrentSession(await loadSession(paths, identity));
  for (const target of targets) {
    if (force || secondsUntil(tokenForTarget(session, target).expiresAt) <= REFRESH_SKEW_SECONDS) {
      session = await refreshTarget(paths, identity, browser, target);
    }
  }
  return session;
}

export async function withDataSession<T>(
  paths: StoragePaths,
  identity: Identity,
  browser: BrowserName,
  targets: DataTokenTarget | readonly DataTokenTarget[],
  operation: (session: StoredSession) => Promise<T>,
): Promise<T> {
  const required = typeof targets === "string" ? [targets] : [...targets];
  const session = await prepareSession(paths, identity, browser, required, false);
  setRequestAttempt(1);
  try {
    return await operation(session);
  } catch (error) {
    if (!(error instanceof TeamsApiError) || (error.status !== 401 && error.status !== 403)) {
      throw error;
    }
    debugDecision(`retry authenticationStatus=${error.status} attempt=2`);
    const refreshed = await prepareSession(paths, identity, browser, required, true);
    setRequestAttempt(2);
    return operation(refreshed);
  }
}
