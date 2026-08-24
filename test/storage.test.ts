import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  version: 2,
  browser: "chrome",
  tenantId: "tenant",
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
    assert.equal(paths.sessionFile, join(root, "auth", "session.json"));
    assert.equal(paths.guardrailsFile, join(root, "guardrails.json"));
    assert.equal(paths.browserProfile("edge"), join(root, "browser-profiles", "edge"));
    assert.equal(paths.browserProfile("chrome"), join(root, "browser-profiles", "chrome"));

    await prepareBrowserProfile(paths, "chrome");
    await saveSession(paths, session);
    assert.deepEqual(await loadSession(paths), session);
    assert.match(await readFile(paths.sessionFile, "utf8"), /"tenantId": "tenant"/);
    if (process.platform !== "win32") {
      assert.equal((await stat(paths.sessionFile)).mode & 0o777, 0o600);
    }

    await clearAuthentication(paths);
    await assert.rejects(loadSession(paths), /Not logged in/);
    await clearAuthentication(paths);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
