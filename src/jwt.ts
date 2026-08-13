export type JwtMetadata = {
  audience?: string;
  tenantId?: string;
  expiresAt?: string;
};

export function readJwtMetadata(token: string): JwtMetadata {
  const payload = token.split(".")[1];
  if (!payload) throw new Error("The returned value is not a JWT");

  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
    aud?: string;
    tid?: string;
    exp?: number;
  };

  return {
    ...(claims.aud ? { audience: claims.aud } : {}),
    ...(claims.tid ? { tenantId: claims.tid } : {}),
    ...(claims.exp ? { expiresAt: new Date(claims.exp * 1000).toISOString() } : {}),
  };
}

