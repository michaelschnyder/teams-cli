import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  describeSession,
  refreshTokens,
  validateSession,
  type AuthDependencies,
} from "../src/auth.js";
import { saveSession, storagePaths, type StoredSession } from "../src/storage.js";
import {
  CHAT_SVC_AGG_RESOURCE,
  OUTLOOK_SEARCH_RESOURCE,
  SKYPE_RESOURCE,
} from "../src/constants.js";

function jwt(payload: object): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

test("silently refreshes an expired session with its saved browser and tenant", async () => {
  const root = await mkdtemp(join(tmpdir(), "teams-cli-auth-"));
  try {
    const paths = storagePaths(root);
    const expired: StoredSession = {
      version: 2,
      browser: "chrome",
      tenantId: "tenant",
      savedAt: "2026-08-13T00:00:00.000Z",
      region: "emea",
      accessToken: {
        value: jwt({ tid: "tenant", exp: 1_700_000_000 }),
        expiresAt: "2023-11-14T22:13:20.000Z",
      },
      skypeToken: {
        value: jwt({ tid: "tenant", exp: 1_700_000_000 }),
        expiresAt: "2023-11-14T22:13:20.000Z",
      },
      chatToken: {
        value: jwt({ tid: "tenant", exp: 1_700_000_000 }),
        expiresAt: "2023-11-14T22:13:20.000Z",
      },
      searchToken: {
        value: jwt({ tid: "tenant", exp: 1_700_000_000 }),
        expiresAt: "2023-11-14T22:13:20.000Z",
      },
      endpoints: { chatService: "https://emea.ng.msg.teams.microsoft.com" },
    };
    await saveSession(paths, expired);

    let closed = false;
    const freshAccess = jwt({
      aud: "access-audience",
      tid: "tenant",
      oid: "user-id",
      name: "Ada Lovelace",
      preferred_username: "ada@example.com",
      exp: 1_800_000_000,
    });
    const freshSkype = jwt({ aud: "skype-audience", tid: "tenant", exp: 1_800_000_100 });
    const freshChat = jwt({ aud: "chat-audience", tid: "tenant", exp: 1_800_000_100 });
    const freshSearch = jwt({ aud: "search-audience", tid: "tenant", exp: 1_800_000_100 });
    const dependencies: AuthDependencies = {
      now: () => new Date("2026-08-14T00:00:00.000Z"),
      acquireTokens: async (resources, options) => {
        assert.deepEqual(resources, [SKYPE_RESOURCE, CHAT_SVC_AGG_RESOURCE, OUTLOOK_SEARCH_RESOURCE]);
        assert.equal(options.browser, "chrome");
        assert.equal(options.interactive, false);
        assert.equal(options.tenant, "tenant");
        assert.equal(options.profileDirectory, paths.browserProfile("chrome"));
        return {
          tokens: new Map([
            [SKYPE_RESOURCE, freshAccess],
            [CHAT_SVC_AGG_RESOURCE, freshChat],
            [OUTLOOK_SEARCH_RESOURCE, freshSearch],
          ]),
          close: async () => { closed = true; },
        };
      },
      exchangeToken: async (token) => {
        assert.equal(token, freshAccess);
        return {
          skypeToken: freshSkype,
          region: "emea",
          endpoints: { chatService: "https://emea.ng.msg.teams.microsoft.com" },
        };
      },
    };

    const refreshed = await validateSession(paths, dependencies);
    assert.equal(closed, true);
    assert.equal(refreshed.accessToken.value, freshAccess);
    const output = describeSession(refreshed, dependencies.now());
    assert.equal(output.user.name, "Ada Lovelace");
    assert.equal(output.tokens.accessToken.expiresInSeconds, 13_334_400);
    assert.equal(output.tokens.skypeToken.expiresInSeconds, 13_334_500);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refreshes only the access token when requested", async () => {
  const root = await mkdtemp(join(tmpdir(), "teams-cli-refresh-access-"));
  try {
    const paths = storagePaths(root);
    const oldAccess = jwt({ tid: "tenant", exp: 1_800_000_000 });
    const oldSkype = jwt({ tid: "tenant", exp: 1_800_000_100 });
    await saveSession(paths, {
      version: 2,
      browser: "edge",
      tenantId: "tenant",
      savedAt: "2026-08-13T00:00:00.000Z",
      region: "emea",
      accessToken: { value: oldAccess, expiresAt: "2027-01-15T08:00:00.000Z" },
      skypeToken: { value: oldSkype, expiresAt: "2027-01-15T08:01:40.000Z" },
      chatToken: { value: jwt({ tid: "tenant" }), expiresAt: "2027-01-15T08:01:40.000Z" },
      searchToken: { value: jwt({ tid: "tenant" }), expiresAt: "2027-01-15T08:01:40.000Z" },
      endpoints: { chatService: "https://emea.ng.msg.teams.microsoft.com" },
    });
    const freshAccess = jwt({ tid: "tenant", exp: 1_800_001_000 });
    const dependencies: AuthDependencies = {
      now: () => new Date("2026-08-14T00:00:00.000Z"),
      acquireTokens: async (resources, options) => {
        assert.deepEqual(resources, [SKYPE_RESOURCE]);
        assert.equal(options.browser, "edge");
        assert.equal(options.interactive, false);
        return {
          tokens: new Map([[SKYPE_RESOURCE, freshAccess]]),
          close: async () => undefined,
        };
      },
      exchangeToken: async () => {
        throw new Error("access-only refresh must not exchange the Skype token");
      },
    };

    const refreshed = await refreshTokens(paths, "access", dependencies);
    assert.equal(refreshed.before.accessToken.value, oldAccess);
    assert.equal(refreshed.after.accessToken.value, freshAccess);
    assert.equal(refreshed.after.skypeToken.value, oldSkype);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refreshes only the Skype token when the access token is valid", async () => {
  const root = await mkdtemp(join(tmpdir(), "teams-cli-refresh-skype-"));
  try {
    const paths = storagePaths(root);
    const access = jwt({ tid: "tenant", exp: 1_800_000_000 });
    const oldSkype = jwt({ tid: "tenant", exp: 1_700_000_000 });
    const freshSkype = jwt({ tid: "tenant", exp: 1_800_001_000 });
    await saveSession(paths, {
      version: 2,
      browser: "chrome",
      tenantId: "tenant",
      savedAt: "2026-08-13T00:00:00.000Z",
      region: "emea",
      accessToken: { value: access, expiresAt: "2027-01-15T08:00:00.000Z" },
      skypeToken: { value: oldSkype, expiresAt: "2023-11-14T22:13:20.000Z" },
      chatToken: { value: jwt({ tid: "tenant" }), expiresAt: "2027-01-15T08:01:40.000Z" },
      searchToken: { value: jwt({ tid: "tenant" }), expiresAt: "2027-01-15T08:01:40.000Z" },
      endpoints: { chatService: "https://emea.ng.msg.teams.microsoft.com" },
    });
    const dependencies: AuthDependencies = {
      now: () => new Date("2026-08-14T00:00:00.000Z"),
      acquireTokens: async () => {
        throw new Error("Skype-only refresh must not launch a browser");
      },
      exchangeToken: async (token) => {
        assert.equal(token, access);
        return {
          skypeToken: freshSkype,
          region: "emea",
          endpoints: { chatService: "https://emea.ng.msg.teams.microsoft.com" },
        };
      },
    };

    const refreshed = await refreshTokens(paths, "skype", dependencies);
    assert.equal(refreshed.before.skypeToken.value, oldSkype);
    assert.equal(refreshed.after.accessToken.value, access);
    assert.equal(refreshed.after.skypeToken.value, freshSkype);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
