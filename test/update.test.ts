import { fakeRegistry } from "./registry.js";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  UPDATE_INTERVAL_MS,
  isNewerVersion,
  isNpxExecution,
  latestForChannel,
  loadUpdateState,
  prepareUpdateNotification,
  runUpdateWorker,
  updateChecksDisabled,
} from "../src/update.js";

function manifest(version: string, title?: string) {
  return { version, ...(title ? { teamsCli: { releaseSummary: { title, summary: `${title} summary` } } } : {}) };
}

test("compares versions with standard semver precedence", () => {
  assert.equal(isNewerVersion("0.1.0", "0.2.0"), true);
  assert.equal(isNewerVersion("0.2.0", "0.1.9"), false);
  assert.equal(isNewerVersion("0.1.0", "0.2.0-beta.1"), true);
  assert.equal(isNewerVersion("0.2.0-beta.1", "0.2.0"), true);
  assert.equal(isNewerVersion("0.2.0-canary.9", "0.2.0-canary.10"), true);
  assert.equal(isNewerVersion("invalid", "0.2.0"), false);
});

test("selects latest for stable and the newer of latest and canary", async () => {
  const registry = await fakeRegistry(async (input) =>
    input === "canary"
      ? manifest("0.2.0-canary.4", "Canary changes")
      : manifest("0.1.0", "Stable notes"));
  assert.equal((await latestForChannel("stable", registry)).version, "0.1.0");
  const canary = await latestForChannel("canary", registry);
  assert.equal(canary.version, "0.2.0-canary.4");
  assert.equal(canary.summary?.title, "Canary changes");

  const stableWins = await latestForChannel("canary", await fakeRegistry(async (input) =>
    input === "canary" ? manifest("0.2.0-canary.4") : manifest("0.2.0")),
  );
  assert.equal(stableWins.version, "0.2.0");
});

test("honors update opt-outs, CI, and npx", () => {
  assert.equal(updateChecksDisabled({ NO_UPDATE_NOTIFIER: "1" }), true);
  assert.equal(updateChecksDisabled({ TEAMS_CLI_DISABLE_UPDATE_CHECK: "true" }), true);
  assert.equal(updateChecksDisabled({ CI: "true" }), true);
  assert.equal(isNpxExecution({ npm_command: "exec", npm_lifecycle_event: "npx" }), true);
  assert.equal(isNpxExecution({ npm_command: "exec" }), true);
  assert.equal(isNpxExecution({ npm_lifecycle_event: "npx" }), true);
  assert.equal(updateChecksDisabled({ npm_command: "exec", npm_lifecycle_event: "npx" }), true);
  assert.equal(updateChecksDisabled({}), false);
});

test("caches a channel result and shows its release title on the next invocation", async () => {
  const root = await mkdtemp(join(tmpdir(), "teams-update-"));
  const file = join(root, "state.json");
  await runUpdateWorker(
    "0.1.0",
    file,
    await fakeRegistry(async () => manifest("0.2.0", "Useful release")),
    new Date("2026-01-01T00:00:00Z"),
    "stable",
  );
  assert.equal((await loadUpdateState(file))?.pendingVersion, "0.2.0");

  let stderr = "";
  let spawned = 0;
  await prepareUpdateNotification({
    currentVersion: "0.1.0",
    channel: "stable",
    installedChannel: "stable",
    stateFile: file,
    environment: process.env,
    now: new Date("2026-01-01T00:30:00Z"),
    stderr: {
      write: (value) => {
        stderr += String(value);
        return true;
      },
    },
    spawnWorker: () => {
      spawned += 1;
    },
  });
  assert.match(stderr, /0\.1\.0 → 0\.2\.0/);
  assert.match(stderr, /Useful release/);
  assert.match(stderr, /@michaelschnyder\/teams-cli@0\.2\.0/);
  assert.equal(spawned, 0);
  assert.equal((await loadUpdateState(file))?.pendingVersion, undefined);
});

test("discards the legacy cache, starts checks after one hour, and pins snapshots", async () => {
  const root = await mkdtemp(join(tmpdir(), "teams-update-"));
  const file = join(root, "state.json");
  await writeFile(file, JSON.stringify({ version: 1, checkedAt: "2026-01-01T00:00:00Z", pendingVersion: "0.2.0" }));
  assert.equal(await loadUpdateState(file), null);
  let spawned = 0;
  await prepareUpdateNotification({
    currentVersion: "0.1.0",
    channel: "stable",
    installedChannel: "stable",
    stateFile: file,
    environment: process.env,
    spawnWorker: () => {
      spawned += 1;
    },
  });
  assert.equal(spawned, 1);

  const checkedAt = new Date("2026-01-01T00:00:00Z");
  await runUpdateWorker("0.1.0", file, await fakeRegistry(async () => { throw new Error("unavailable"); }), checkedAt, "stable");
  await prepareUpdateNotification({
    currentVersion: "0.1.0",
    channel: "stable",
    installedChannel: "stable",
    stateFile: file,
    environment: process.env,
    now: new Date(checkedAt.getTime() + UPDATE_INTERVAL_MS - 1),
    spawnWorker: () => {
      spawned += 1;
    },
  });
  assert.equal(spawned, 1);
  assert.doesNotMatch(await readFile(file, "utf8"), /pendingVersion/);

  await prepareUpdateNotification({
    currentVersion: "0.2.0-snapshot.1.1.abcdef12",
    channel: "canary",
    installedChannel: "snapshot",
    stateFile: join(root, "snapshot.json"),
    environment: process.env,
    spawnWorker: () => {
      spawned += 1;
    },
  });
  assert.equal(spawned, 1);
});

test("registry configuration changes invalidate notices before another registry request", async (t) => {
  const { configurationKey } = await import("../src/npm.js");
  const { PACKAGE_NAME } = await import("../src/version.js");
  const { rm } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "teams-cache-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, "npmrc");
  const state = join(root, "state.json");
  await writeFile(config, "registry=https://first.example/");
  let requests = 0;
  await runUpdateWorker("0.1.0", state, {
    packageName: PACKAGE_NAME,
    registry: "https://first.example/",
    npm: { command: "npm", args: [] },
    configFiles: [config],
    configurationKey: await configurationKey([config]),
    manifest: async () => {
      requests++;
      return { version: "0.2.0" };
    },
  });
  await writeFile(config, "registry=https://second.example/");
  let notices = "";
  let workers = 0;
  await prepareUpdateNotification({
    currentVersion: "0.1.0",
    stateFile: state,
    environment: process.env,
    stderr: {
      write: (text) => {
        notices += text;
        return true;
      },
    },
    spawnWorker: () => {
      workers++;
    },
  });
  assert.equal(notices, "");
  assert.equal(workers, 1);
  assert.equal(requests, 1);
  const cached = JSON.parse(await readFile(state, "utf8"));
  cached.packageName = "@another/cli";
  await writeFile(state, JSON.stringify(cached));
  assert.equal(await loadUpdateState(state), null);
});
