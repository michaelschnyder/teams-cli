import { TEAMS_AUTHZ_URL } from "./constants.js";
import { observedFetch } from "./diagnostics.js";

type AuthzPayload = {
  tokens?: { skypeToken?: string; expiresIn?: number; };
  region?: string;
  partition?: string;
  regionGtms?: {
    chatService?: string;
    chatServiceAggregator?: string;
    middleTier?: string;
  };
};

export type TeamsSession = {
  skypeToken: string;
  expiresIn?: number;
  region?: string;
  partition?: string;
  endpoints: {
    chatService?: string;
    chatServiceAggregator?: string;
    middleTier?: string;
  };
};

export class TeamsAuthError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "TeamsAuthError";
  }
}

export async function exchangeInitialToken(initialToken: string): Promise<TeamsSession> {
  const response = await observedFetch(fetch, TEAMS_AUTHZ_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${initialToken}`,
      "ms-teams-authz-type": "TokenRefresh",
    },
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new TeamsAuthError(response.status, `Teams auth exchange failed (${response.status})`);
  }

  let payload: AuthzPayload;
  try { payload = JSON.parse(raw) as AuthzPayload; }
  catch { throw new Error("Teams auth exchange returned invalid JSON"); }
  const skypeToken = payload.tokens?.skypeToken;
  if (!skypeToken) throw new Error("Teams auth exchange returned no Skype token");

  return {
    skypeToken,
    ...(payload.tokens?.expiresIn !== undefined
      ? { expiresIn: payload.tokens.expiresIn }
      : {}),
    ...(payload.region ? { region: payload.region } : {}),
    ...(payload.partition ? { partition: payload.partition } : {}),
    endpoints: {
      ...(payload.regionGtms?.chatService
        ? { chatService: payload.regionGtms.chatService }
        : {}),
      ...(payload.regionGtms?.chatServiceAggregator
        ? { chatServiceAggregator: payload.regionGtms.chatServiceAggregator }
        : {}),
      ...(payload.regionGtms?.middleTier
        ? { middleTier: payload.regionGtms.middleTier }
        : {}),
    },
  };
}
