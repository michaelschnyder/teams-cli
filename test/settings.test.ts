import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadSettings,
  parseSettings,
  resolveUpdateChannel,
  saveUpdateChannel,
} from "../src/settings.js";
import { storagePaths } from "../src/storage.js";

test("stores update settings separately from profiles", async () => {
  const root = await mkdtemp(join(tmpdir(), "teams-cli-settings-"));
  try {
    const paths = storagePaths(root);
    assert.deepEqual(await loadSettings(paths), { version: 1 });
    await saveUpdateChannel(paths, "canary");
    assert.deepEqual(await loadSettings(paths), { version: 1, updateChannel: "canary" });
    assert.match(await readFile(paths.settingsFile, "utf8"), /updateChannel: canary/);
    if (process.platform !== "win32") assert.equal((await stat(paths.settingsFile)).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolves explicit, environment, saved, and installed channels in order", async () => {
  const root = await mkdtemp(join(tmpdir(), "teams-cli-settings-order-"));
  try {
    const paths = storagePaths(root);
    await saveUpdateChannel(paths, "canary");
    assert.equal(await resolveUpdateChannel({ paths, explicit: "stable", environment: { TEAMS_CLI_UPDATE_CHANNEL: "canary" } }), "stable");
    assert.equal(await resolveUpdateChannel({ paths, environment: { TEAMS_CLI_UPDATE_CHANNEL: "stable" } }), "stable");
    assert.equal(await resolveUpdateChannel({ paths, environment: {} }), "canary");
    await rm(paths.settingsFile);
    assert.equal(await resolveUpdateChannel({ paths, environment: {}, installedChannel: "canary" }), "canary");
    assert.equal(await resolveUpdateChannel({ paths, environment: {}, installedChannel: "snapshot" }), "stable");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects unknown settings without changing the profile schema", () => {
  assert.throws(() => parseSettings({ version: 1, updateChannel: "snapshot" }), /stable or canary/);
  assert.throws(() => parseSettings({ version: 1, profiles: {} }), /unknown field/);
});
