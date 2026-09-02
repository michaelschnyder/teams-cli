import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  describeSession,
  ensureDataSession,
  InteractiveLoginRequiredError,
  login,
  passwordFromCommand,
  refreshTokens,
  validateSession,
  type AuthDependencies,
} from "../src/auth.js";
import { OAuthRedirectError } from "../src/oauth.js";
import { loadSession, saveSession, storagePaths, type StoredSession } from "../src/storage.js";
import {
  CHAT_SVC_AGG_RESOURCE,
  OUTLOOK_SEARCH_RESOURCE,
  SKYPE_RESOURCE,
} from "../src/constants.js";

test("reads a CI password from bounded executable stdout", async () => {
  const root = await mkdtemp(join(tmpdir(), "teams-cli-password-helper-"));
  try {
    const helper = process.platform === "win32"
      ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "whoami.exe")
      : "/usr/bin/whoami";
    assert.ok((await passwordFromCommand(helper)).length > 0);
    await assert.rejects(passwordFromCommand("relative-helper"), /absolute executable path/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("login stores the verified tenant and user in isolated identity storage", async () => {
  const root = await mkdtemp(join(tmpdir(), "teams-cli-login-identity-"));
  try {
    const paths = storagePaths(root);
    const identity = { tenantId: "tenant", userId: "alice" };
    const access = jwt({ tid: identity.tenantId, oid: identity.userId, preferred_username: "alice@example.test", exp: 1_900_000_000 });
    const chat = jwt({ tid: identity.tenantId, oid: identity.userId, exp: 1_900_000_000 });
    const search = jwt({ tid: identity.tenantId, oid: identity.userId, exp: 1_900_000_000 });
    const skype = jwt({ tid: identity.tenantId, oid: identity.userId, exp: 1_900_000_000 });
    const dependencies: AuthDependencies = {
      now: () => new Date("2026-08-28T00:00:00.000Z"),
      acquireTokens: async (_resources, options) => {
        assert.equal(options.username, "alice@example.test");
        assert.equal(options.password, "test-password");
        assert.equal(options.headless, true);
        return {
          tokens: new Map([
            [SKYPE_RESOURCE, access],
            [CHAT_SVC_AGG_RESOURCE, chat],
            [OUTLOOK_SEARCH_RESOURCE, search],
          ]),
          close: async () => undefined,
        };
      },
      exchangeToken: async () => ({
        skypeToken: skype,
        region: "test",
        endpoints: { chatService: "https://test.invalid" },
      }),
    };
    const loggedIn = await login(paths, {
      browser: "edge",
      tenant: identity.tenantId,
      user: identity.userId,
      username: "alice@example.test",
      password: "test-password",
      headless: true,
    }, dependencies);
    assert.equal(loggedIn.version, 3);
    assert.equal(loggedIn.username, "alice@example.test");
    assert.deepEqual(await loadSession(paths, identity), loggedIn);
    assert.equal((await stat(paths.browserProfile(identity, "edge"))).isDirectory(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("first login discovers the tenant and user without explicit identity options", async () => {
  const root = await mkdtemp(join(tmpdir(), "teams-cli-login-default-"));
  try {
    const paths = storagePaths(root);
    const identity = { tenantId: "discovered-tenant", userId: "discovered-user" };
    const access = jwt({
      tid: identity.tenantId,
      oid: identity.userId,
      preferred_username: "alex@example.test",
      exp: 1_900_000_000,
    });
    const supportingToken = jwt({ tid: identity.tenantId, oid: identity.userId, exp: 1_900_000_000 });
    const dependencies: AuthDependencies = {
      now: () => new Date("2026-08-28T00:00:00.000Z"),
      acquireTokens: async (_resources, options) => {
        assert.equal(options.interactive, true);
        assert.equal(options.tenant, undefined);
        assert.equal(options.username, undefined);
        return {
          tokens: new Map([
            [SKYPE_RESOURCE, access],
            [CHAT_SVC_AGG_RESOURCE, supportingToken],
            [OUTLOOK_SEARCH_RESOURCE, supportingToken],
          ]),
          close: async () => undefined,
        };
      },
      exchangeToken: async () => ({
        skypeToken: supportingToken,
        region: "test",
        endpoints: { chatService: "https://test.invalid" },
      }),
    };

    const loggedIn = await login(paths, { browser: "edge" }, dependencies);

    assert.equal(loggedIn.tenantId, identity.tenantId);
    assert.equal(loggedIn.userId, identity.userId);
    assert.equal(loggedIn.username, "alex@example.test");
    assert.deepEqual(await loadSession(paths, identity), loggedIn);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function jwt(payload: object): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

test("silently refreshes an expired session with its saved browser and tenant", async () => {
  const root = await mkdtemp(join(tmpdir(), "teams-cli-auth-"));
  try {
    const paths = storagePaths(root);
    const expired: StoredSession = {
      version: 3,
      browser: "chrome",
      tenantId: "tenant",
      userId: "user-id",
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
        assert.equal(options.profileDirectory, paths.browserProfile({ tenantId: "tenant", userId: "user-id" }, "chrome"));
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

    const refreshed = await validateSession(paths, { tenantId: "tenant", userId: "user-id" }, "chrome", dependencies);
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
      version: 3,
      browser: "edge",
      tenantId: "tenant",
      userId: "user-id",
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

    const refreshed = await refreshTokens(paths, { tenantId: "tenant", userId: "user-id" }, "access", "edge", dependencies);
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
      version: 3,
      browser: "chrome",
      tenantId: "tenant",
      userId: "user-id",
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

    const refreshed = await refreshTokens(paths, { tenantId: "tenant", userId: "user-id" }, "skype", "chrome", dependencies);
    assert.equal(refreshed.before.skypeToken.value, oldSkype);
    assert.equal(refreshed.after.accessToken.value, access);
    assert.equal(refreshed.after.skypeToken.value, freshSkype);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refreshes a data token within the sixty-second expiry skew", async () => {
  const root = await mkdtemp(join(tmpdir(), "teams-cli-refresh-skew-"));
  try {
    const paths = storagePaths(root);
    const now = new Date("2026-08-18T00:00:00.000Z");
    const freshChat = jwt({ tid: "tenant", exp: Math.floor(now.getTime() / 1000) + 3600 });
    await saveSession(paths, {
      version: 3,
      browser: "edge",
      tenantId: "tenant",
      userId: "user-id",
      savedAt: now.toISOString(),
      region: "emea",
      accessToken: { value: jwt({ tid: "tenant" }), expiresAt: "2027-01-01T00:00:00.000Z" },
      skypeToken: { value: jwt({ tid: "tenant" }), expiresAt: "2027-01-01T00:00:00.000Z" },
      chatToken: { value: jwt({ tid: "tenant" }), expiresAt: "2026-08-18T00:00:59.000Z" },
      searchToken: { value: jwt({ tid: "tenant" }), expiresAt: "2027-01-01T00:00:00.000Z" },
      endpoints: { chatService: "https://emea.ng.msg.teams.microsoft.com" },
    });
    let acquisitions = 0;
    const dependencies: AuthDependencies = {
      now: () => now,
      acquireTokens: async (resources) => {
        acquisitions += 1;
        assert.deepEqual(resources, [CHAT_SVC_AGG_RESOURCE]);
        return { tokens: new Map([[CHAT_SVC_AGG_RESOURCE, freshChat]]), close: async () => undefined };
      },
      exchangeToken: async () => { throw new Error("chat refresh must not exchange Skype"); },
    };
    const refreshed = await ensureDataSession(paths, { tenantId: "tenant", userId: "user-id" }, "chat", "edge", dependencies);
    assert.equal(acquisitions, 1);
    assert.equal(refreshed.chatToken.value, freshChat);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refreshes the access token used by person profile operations", async () => {
  const root = await mkdtemp(join(tmpdir(), "teams-cli-refresh-person-access-"));
  try {
    const paths = storagePaths(root);
    const now = new Date("2026-08-18T00:00:00.000Z");
    const freshAccess = jwt({ tid: "tenant", exp: Math.floor(now.getTime() / 1000) + 3600 });
    await saveSession(paths, {
      version: 3,
      browser: "edge",
      tenantId: "tenant",
      userId: "user-id",
      savedAt: now.toISOString(),
      region: "emea",
      accessToken: { value: jwt({ tid: "tenant" }), expiresAt: "2026-08-18T00:00:59.000Z" },
      skypeToken: { value: jwt({ tid: "tenant" }), expiresAt: "2027-01-01T00:00:00.000Z" },
      chatToken: { value: jwt({ tid: "tenant" }), expiresAt: "2027-01-01T00:00:00.000Z" },
      searchToken: { value: jwt({ tid: "tenant" }), expiresAt: "2027-01-01T00:00:00.000Z" },
      endpoints: { chatService: "https://emea.ng.msg.teams.microsoft.com" },
    });
    const dependencies: AuthDependencies = {
      now: () => now,
      acquireTokens: async (resources) => {
        assert.deepEqual(resources, [SKYPE_RESOURCE]);
        return { tokens: new Map([[SKYPE_RESOURCE, freshAccess]]), close: async () => undefined };
      },
      exchangeToken: async () => { throw new Error("access refresh must not exchange Skype"); },
    };
    const refreshed = await ensureDataSession(paths, { tenantId: "tenant", userId: "user-id" }, "access", "edge", dependencies);
    assert.equal(refreshed.accessToken.value, freshAccess);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports when silent refresh needs an interactive login", async () => {
  const root = await mkdtemp(join(tmpdir(), "teams-cli-refresh-interactive-"));
  try {
    const paths = storagePaths(root);
    await saveSession(paths, {
      version: 3,
      browser: "edge",
      tenantId: "tenant",
      userId: "user-id",
      savedAt: "2026-08-18T00:00:00.000Z",
      region: "emea",
      accessToken: { value: jwt({ tid: "tenant" }), expiresAt: "2026-08-18T00:00:00.000Z" },
      skypeToken: { value: jwt({ tid: "tenant" }), expiresAt: "2026-08-18T00:00:00.000Z" },
      chatToken: { value: jwt({ tid: "tenant" }), expiresAt: "2026-08-18T00:00:00.000Z" },
      searchToken: { value: jwt({ tid: "tenant" }), expiresAt: "2026-08-18T00:00:00.000Z" },
      endpoints: { chatService: "https://emea.ng.msg.teams.microsoft.com" },
    });
    const dependencies: AuthDependencies = {
      now: () => new Date("2026-08-18T00:00:00.000Z"),
      acquireTokens: async () => {
        throw new OAuthRedirectError("interaction_required", "MFA required");
      },
      exchangeToken: async () => { throw new Error("unexpected exchange"); },
    };

    await assert.rejects(
      refreshTokens(paths, { tenantId: "tenant", userId: "user-id" }, "access", "edge", dependencies),
      (error: unknown) => error instanceof InteractiveLoginRequiredError && error.code === "interaction_required",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
