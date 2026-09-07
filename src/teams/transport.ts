import { TEAMS_WEB_ORIGIN } from "../constants.js";
import { observedFetch } from "../diagnostics.js";
import type { StoredSession } from "../storage.js";

import type { DataTokenTarget } from "./types.js";

export class TeamsApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly tokenTarget?: DataTokenTarget,
  ) {
    super(message);
    this.name = "TeamsApiError";
  }
}

export function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function nullableBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
}

export function csaUrl(updates: boolean): URL {
  const url = new URL(
    `/api/csa/api/v1/teams/users/me${updates ? "/updates" : ""}`,
    TEAMS_WEB_ORIGIN,
  );
  url.searchParams.set("isPrefetch", "false");
  url.searchParams.set("enableMembershipSummary", "true");
  url.searchParams.set("supportsAdditionalSystemGeneratedFolders", "true");
  url.searchParams.set("supportsSliceItems", "true");
  return url;
}

export async function jsonResponse(
  response: Response,
  operation: string,
  tokenTarget?: DataTokenTarget,
): Promise<unknown> {
  const raw = await response.text();
  if (!response.ok) {
    throw new TeamsApiError(
      response.status,
      `${operation} failed (${response.status} ${response.statusText})`,
      tokenTarget,
    );
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${operation} returned invalid JSON`);
  }
}

export async function discoveryPayload(
  session: StoredSession,
  fetchImplementation: typeof fetch,
): Promise<{ chats?: unknown; users?: unknown; teams?: unknown; }> {
  const response = await observedFetch(fetchImplementation, csaUrl(false), {
    headers: {
      authorization: `Bearer ${session.chatToken.value}`,
      "x-skypetoken": session.skypeToken.value,
      accept: "application/json",
    },
  });
  return await jsonResponse(response, "Teams discovery", "chat") as {
    chats?: unknown;
    users?: unknown;
    teams?: unknown;
  };
}
