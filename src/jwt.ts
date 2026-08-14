export type JwtMetadata = {
  audience?: string;
  tenantId?: string;
  userId?: string;
  name?: string;
  username?: string;
  expiresAt?: string;
};

export function decodeJwtClaims(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  if (!payload) throw new Error("The returned value is not a JWT");
  const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  if (!claims || typeof claims !== "object" || Array.isArray(claims)) {
    throw new Error("The JWT payload is not a claims object");
  }
  return claims as Record<string, unknown>;
}

export function readJwtMetadata(token: string): JwtMetadata {
  const claims = decodeJwtClaims(token) as {
    aud?: string;
    tid?: string;
    oid?: string;
    name?: string;
    preferred_username?: string;
    upn?: string;
    exp?: number;
  };

  return {
    ...(claims.aud ? { audience: claims.aud } : {}),
    ...(claims.tid ? { tenantId: claims.tid } : {}),
    ...(claims.oid ? { userId: claims.oid } : {}),
    ...(claims.name ? { name: claims.name } : {}),
    ...(claims.preferred_username || claims.upn
      ? { username: claims.preferred_username ?? claims.upn }
      : {}),
    ...(claims.exp ? { expiresAt: new Date(claims.exp * 1000).toISOString() } : {}),
  };
}

export function secondsUntil(expiresAt: string, now = new Date()): number {
  const milliseconds = new Date(expiresAt).getTime() - now.getTime();
  if (!Number.isFinite(milliseconds)) throw new Error("Invalid token expiry date");
  return Math.max(0, Math.ceil(milliseconds / 1000));
}

export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  return [
    ...(days ? [`${days}d`] : []),
    ...(hours ? [`${hours}h`] : []),
    ...(minutes ? [`${minutes}m`] : []),
    ...(!days && !hours ? [`${remainder}s`] : []),
  ].join(" ");
}
