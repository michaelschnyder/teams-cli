import assert from "node:assert/strict";
import test from "node:test";
import { createProgram, renderRefreshResult, renderTokens } from "../src/cli.js";
import type { StoredSession } from "../src/storage.js";

function jwt(payload: object): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

const session: StoredSession = {
  version: 1,
  browser: "edge",
  tenantId: "tenant",
  savedAt: "2026-08-14T00:00:00.000Z",
  accessToken: { value: jwt({ kind: "access" }), expiresAt: "2027-01-01T00:00:00.000Z" },
  skypeToken: { value: jwt({ kind: "skype" }), expiresAt: "2027-01-01T00:00:00.000Z" },
};

test("exposes only the minimal auth command group", () => {
  const program = createProgram();
  assert.deepEqual(program.commands.map((command) => command.name()), ["auth"]);
  assert.deepEqual(
    program.commands[0]?.commands.map((command) => command.name()),
    ["login", "refresh", "whoami", "tokens", "logout"],
  );
});

test("shows an individual raw token without labels for piping", () => {
  assert.equal(renderTokens(session, "access", false), `${session.accessToken.value}\n`);
});

test("decodes JWT claims without showing the header or signature", () => {
  const rendered = renderTokens(session, "skype", true);
  assert.deepEqual(JSON.parse(rendered), { kind: "skype" });
  assert.doesNotMatch(rendered, /header|signature/);
});

test("shows audience and expiry before and after a token refresh", () => {
  const after: StoredSession = {
    ...session,
    accessToken: {
      value: jwt({ aud: "new-audience" }),
      expiresAt: "2027-02-01T00:00:00.000Z",
    },
  };
  const rendered = renderRefreshResult(
    { target: "access", before: session, after },
    new Date("2026-12-31T23:00:00.000Z"),
  );
  assert.match(rendered, /Before audience: unknown/);
  assert.match(rendered, /Before expiry: 2027-01-01T00:00:00.000Z \(1h remaining\)/);
  assert.match(rendered, /After audience: new-audience/);
  assert.match(rendered, /After expiry: 2027-02-01T00:00:00.000Z/);
  assert.doesNotMatch(rendered, /Skype token/);
});
