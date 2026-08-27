import {
  refreshTokens,
  type DataTokenTarget,
} from "./auth.js";
import { debugDecision, setRequestAttempt, showStatus } from "./diagnostics.js";
import { secondsUntil } from "./jwt.js";
import {
  loadSession,
  requireCurrentSession,
  type StoragePaths,
  type StoredSession,
  type StoredToken,
} from "./storage.js";
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

async function refreshTarget(paths: StoragePaths, target: DataTokenTarget): Promise<StoredSession> {
  let session = requireCurrentSession(await loadSession(paths));
  if (
    target === "skype" &&
    secondsUntil(session.accessToken.expiresAt) <= REFRESH_SKEW_SECONDS
  ) {
    showStatus("Refreshing access token…");
    debugDecision("refresh token=access reason=Skype-prerequisite");
    session = (await refreshTokens(paths, "access")).after;
  }
  showStatus(`Refreshing ${label(target)} token…`);
  debugDecision(`refresh token=${target}`);
  return (await refreshTokens(paths, target)).after;
}

async function prepareSession(
  paths: StoragePaths,
  targets: readonly DataTokenTarget[],
  force: boolean,
): Promise<StoredSession> {
  let session = requireCurrentSession(await loadSession(paths));
  for (const target of targets) {
    if (force || secondsUntil(tokenForTarget(session, target).expiresAt) <= REFRESH_SKEW_SECONDS) {
      session = await refreshTarget(paths, target);
    }
  }
  return session;
}

export async function withDataSession<T>(
  paths: StoragePaths,
  targets: DataTokenTarget | readonly DataTokenTarget[],
  operation: (session: StoredSession) => Promise<T>,
  beforeRetry?: () => Promise<void>,
): Promise<T> {
  const required = typeof targets === "string" ? [targets] : [...targets];
  const session = await prepareSession(paths, required, false);
  setRequestAttempt(1);
  try {
    return await operation(session);
  } catch (error) {
    if (!(error instanceof TeamsApiError) || (error.status !== 401 && error.status !== 403)) {
      throw error;
    }
    debugDecision(`retry authenticationStatus=${error.status} attempt=2`);
    const refreshed = await prepareSession(paths, required, true);
    if (beforeRetry) await beforeRetry();
    setRequestAttempt(2);
    return operation(refreshed);
  }
}
