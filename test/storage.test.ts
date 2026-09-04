import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";
import {
  clearAuthentication,
  loadSession,
  prepareBrowserProfile,
  saveSession,
  storagePaths,
  type StoredSession,
} from "../src/storage.js";

const session: StoredSession = {
  version: 3,
  browser: "chrome",
  tenantId: "tenant",
  userId: "user-id",
  savedAt: "2026-08-14T00:00:00.000Z",
  region: "emea",
  accessToken: { value: "access", expiresAt: "2026-08-14T01:00:00.000Z" },
  skypeToken: { value: "skype", expiresAt: "2026-08-14T01:00:00.000Z" },
  chatToken: { value: "chat", expiresAt: "2026-08-14T01:00:00.000Z" },
  searchToken: { value: "search", expiresAt: "2026-08-14T01:00:00.000Z" },
  endpoints: { chatService: "https://emea.ng.msg.teams.microsoft.com" },
};

test("partitions auth and browser state below a replaceable storage root", async () => {
  const root = await mkdtemp(join(tmpdir(), "teams-cli-storage-"));
  try {
    const paths = storagePaths(root);
    const identity = { tenantId: "tenant", userId: "user-id" };
    assert.ok(paths.sessionFile(identity).startsWith(`${join(root, "auth")}${sep}`));
    assert.equal(paths.configFile, join(root, "config.yaml"));
    assert.equal(paths.settingsFile, join(root, "settings.yaml"));
    assert.ok(paths.browserProfile(identity, "edge").startsWith(`${join(root, "browser-profiles")}${sep}`));
    assert.match(paths.browserProfile(identity, "chrome"), /chrome$/);

    await prepareBrowserProfile(paths, identity, "chrome");
    await saveSession(paths, session);
    assert.deepEqual(await loadSession(paths, identity), session);
    assert.match(await readFile(paths.sessionFile(identity), "utf8"), /"tenantId": "tenant"/);
    if (process.platform !== "win32") {
      assert.equal((await stat(paths.sessionFile(identity))).mode & 0o777, 0o600);
    }

    await clearAuthentication(paths, identity);
    await assert.rejects(loadSession(paths, identity), /Not logged in/);
    await clearAuthentication(paths, identity);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("isolates sessions and browser state for two users in one tenant", async () => {
  const root = await mkdtemp(join(tmpdir(), "teams-cli-storage-users-"));
  try {
    const paths = storagePaths(root);
    const alice = { tenantId: "tenant", userId: "alice" };
    const bob = { tenantId: "tenant", userId: "bob" };
    await saveSession(paths, { ...session, userId: alice.userId });
    await saveSession(paths, { ...session, userId: bob.userId, accessToken: { ...session.accessToken, value: "bob-access" } });
    assert.equal((await loadSession(paths, alice)).userId, "alice");
    assert.equal((await loadSession(paths, bob)).accessToken.value, "bob-access");
    assert.notEqual(paths.sessionFile(alice), paths.sessionFile(bob));
    assert.notEqual(paths.browserProfile(alice, "chrome"), paths.browserProfile(bob, "chrome"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
