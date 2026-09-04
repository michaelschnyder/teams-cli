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

function manifest(version: string, title?: string): Response {
  return new Response(JSON.stringify({
    version,
    ...(title ? { teamsCli: { releaseSummary: { title, summary: `${title} summary` } } } : {}),
  }), { status: 200, headers: { "content-type": "application/json" } });
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
  const fetcher = async (input: string | URL | Request) => String(input).endsWith("/canary")
    ? manifest("0.2.0-canary.4", "Canary changes")
    : manifest("0.1.0", "Stable notes");
  assert.equal((await latestForChannel("stable", fetcher)).version, "0.1.0");
  const canary = await latestForChannel("canary", fetcher);
  assert.equal(canary.version, "0.2.0-canary.4");
  assert.equal(canary.summary?.title, "Canary changes");

  const stableWins = await latestForChannel("canary", async (input) => String(input).endsWith("/canary")
    ? manifest("0.2.0-canary.4")
    : manifest("0.2.0"));
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
  await runUpdateWorker("0.1.0", file, async () => manifest("0.2.0", "Useful release"), new Date("2026-01-01T00:00:00Z"), "stable");
  assert.equal((await loadUpdateState(file))?.pendingVersion, "0.2.0");

  let stderr = "";
  let spawned = 0;
  await prepareUpdateNotification({
    currentVersion: "0.1.0",
    channel: "stable",
    installedChannel: "stable",
    stateFile: file,
    environment: {},
    now: new Date("2026-01-01T00:30:00Z"),
    stderr: { write: (value) => { stderr += String(value); return true; } },
    spawnWorker: () => { spawned += 1; },
  });
  assert.match(stderr, /0\.1\.0 → 0\.2\.0/);
  assert.match(stderr, /Useful release/);
  assert.equal(spawned, 0);
  assert.equal((await loadUpdateState(file))?.pendingVersion, undefined);
});

test("migrates the old cache to stable, starts checks after one hour, and pins snapshots", async () => {
  const root = await mkdtemp(join(tmpdir(), "teams-update-"));
  const file = join(root, "state.json");
  await writeFile(file, JSON.stringify({ version: 1, checkedAt: "2026-01-01T00:00:00Z", pendingVersion: "0.2.0" }));
  assert.deepEqual(await loadUpdateState(file), {
    version: 2,
    channel: "stable",
    checkedAt: "2026-01-01T00:00:00Z",
    pendingVersion: "0.2.0",
  });
  let spawned = 0;
  await prepareUpdateNotification({
    currentVersion: "0.1.0",
    channel: "stable",
    installedChannel: "stable",
    stateFile: file,
    environment: {},
    spawnWorker: () => { spawned += 1; },
  });
  assert.equal(spawned, 1);

  const checkedAt = new Date("2026-01-01T00:00:00Z");
  await runUpdateWorker("0.1.0", file, async () => new Response("no", { status: 500 }), checkedAt, "stable");
  await prepareUpdateNotification({
    currentVersion: "0.1.0",
    channel: "stable",
    installedChannel: "stable",
    stateFile: file,
    environment: {},
    now: new Date(checkedAt.getTime() + UPDATE_INTERVAL_MS - 1),
    spawnWorker: () => { spawned += 1; },
  });
  assert.equal(spawned, 1);
  assert.doesNotMatch(await readFile(file, "utf8"), /pendingVersion/);

  await prepareUpdateNotification({
    currentVersion: "0.2.0-snapshot.1.1.abcdef12",
    channel: "canary",
    installedChannel: "snapshot",
    stateFile: join(root, "snapshot.json"),
    environment: {},
    spawnWorker: () => { spawned += 1; },
  });
  assert.equal(spawned, 1);
});
