import {
  ensureDataSession,
  refreshTokens,
  type DataTokenTarget,
} from "./auth.js";
import type { StoragePaths, StoredSession } from "./storage.js";
import { TeamsApiError } from "./teams-client.js";

export async function withDataSession<T>(
  paths: StoragePaths,
  target: DataTokenTarget,
  operation: (session: StoredSession) => Promise<T>,
): Promise<T> {
  const session = await ensureDataSession(paths, target);
  try {
    return await operation(session);
  } catch (error) {
    if (!(error instanceof TeamsApiError) || (error.status !== 401 && error.status !== 403)) {
      throw error;
    }
    const refreshed = await refreshTokens(paths, error.tokenTarget ?? target);
    return operation(refreshed.after);
  }
}
