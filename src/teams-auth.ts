import { TEAMS_AUTHZ_URL } from "./constants.js";

type AuthzPayload = {
  tokens?: { skypeToken?: string; expiresIn?: number };
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

export async function exchangeInitialToken(initialToken: string): Promise<TeamsSession> {
  const response = await fetch(TEAMS_AUTHZ_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${initialToken}`,
      "ms-teams-authz-type": "TokenRefresh",
    },
  });

  const raw = await response.text();
  if (!response.ok) {
    let message = raw.slice(0, 300);
    try {
      const parsed = JSON.parse(raw) as { errorCode?: string; message?: string };
      message = parsed.errorCode ?? parsed.message ?? message;
    } catch {
      // Preserve the bounded text response for diagnostics.
    }
    throw new Error(`Teams auth exchange failed (${response.status}): ${message}`);
  }

  const payload = JSON.parse(raw) as AuthzPayload;
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

