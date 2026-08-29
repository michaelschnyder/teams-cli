import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadProfiles,
  removeProfile,
  resolveRuntimeContext,
  saveProfile,
} from "../src/config.js";
import { storagePaths } from "../src/storage.js";

test("resolves flags over environment and selected or default profiles", async () => {
  const root = await mkdtemp(join(tmpdir(), "teams-cli-config-"));
  try {
    const paths = storagePaths(root);
    await saveProfile(paths, "default", {
      tenantId: "default-tenant",
      userId: "default-user",
      browser: "edge",
    });
    await saveProfile(paths, "alice", {
      tenantId: "profile-tenant",
      userId: "profile-user",
      username: "alice@example.test",
      browser: "chrome",
    });
    if (process.platform !== "win32") {
      assert.equal((await stat(paths.configFile)).mode & 0o777, 0o600);
    }

    assert.deepEqual(await resolveRuntimeContext(paths, {}, {}), {
      profileName: "default",
      tenantId: "default-tenant",
      userId: "default-user",
      browser: "edge",
    });
    assert.deepEqual(
      await resolveRuntimeContext(
        paths,
        { profile: "alice", tenant: "flag-tenant", browser: "edge" },
        { TEAMS_CLI_USER: "environment-user" },
      ),
      {
        profileName: "alice",
        tenantId: "flag-tenant",
        userId: "environment-user",
        username: "alice@example.test",
        browser: "edge",
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("removes profile configuration without touching other profiles", async () => {
  const root = await mkdtemp(join(tmpdir(), "teams-cli-config-remove-"));
  try {
    const paths = storagePaths(root);
    await saveProfile(paths, "alice", { tenantId: "tenant", userId: "alice" });
    await saveProfile(paths, "bob", { tenantId: "tenant", userId: "bob" });
    assert.equal(await removeProfile(paths, "alice"), true);
    assert.deepEqual(Object.keys((await loadProfiles(paths)).profiles), ["bob"]);
    assert.equal(await removeProfile(paths, "missing"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
