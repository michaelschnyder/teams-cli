import assert from "node:assert/strict";
import test from "node:test";
import { formatDuration, readJwtMetadata, secondsUntil } from "../src/jwt.js";

function jwt(payload: object): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

test("reads identity and expiry metadata from a Teams JWT", () => {
  const metadata = readJwtMetadata(jwt({
    aud: "audience",
    tid: "tenant",
    oid: "user-id",
    name: "Ada Lovelace",
    preferred_username: "ada@example.com",
    exp: 1_700_000_000,
  }));

  assert.deepEqual(metadata, {
    audience: "audience",
    tenantId: "tenant",
    userId: "user-id",
    name: "Ada Lovelace",
    username: "ada@example.com",
    expiresAt: "2023-11-14T22:13:20.000Z",
  });
});

test("computes and formats the duration remaining until expiry", () => {
  assert.equal(secondsUntil("2026-08-14T01:01:02.000Z", new Date("2026-08-14T00:00:00.000Z")), 3662);
  assert.equal(secondsUntil("2026-08-13T00:00:00.000Z", new Date("2026-08-14T00:00:00.000Z")), 0);
  assert.equal(formatDuration(3662), "1h 1m");
  assert.equal(formatDuration(62), "1m 2s");
});
