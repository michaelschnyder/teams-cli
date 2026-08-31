import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  UPDATE_INTERVAL_MS,
  isNewerVersion,
  loadUpdateState,
  prepareUpdateNotification,
  runUpdateWorker,
  updateChecksDisabled,
} from "../src/update.js";

test("compares stable and prerelease versions conservatively", () => {
  assert.equal(isNewerVersion("0.1.0", "0.2.0"), true);
  assert.equal(isNewerVersion("0.2.0", "0.1.9"), false);
  assert.equal(isNewerVersion("0.1.0", "0.2.0-beta.1"), false);
  assert.equal(isNewerVersion("0.2.0-beta.1", "0.2.0"), true);
  assert.equal(isNewerVersion("invalid", "0.2.0"), false);
});

test("honors update opt-outs and CI", () => {
  assert.equal(updateChecksDisabled({ NO_UPDATE_NOTIFIER: "1" }), true);
  assert.equal(updateChecksDisabled({ TEAMS_CLI_DISABLE_UPDATE_CHECK: "true" }), true);
  assert.equal(updateChecksDisabled({ CI: "true" }), true);
  assert.equal(updateChecksDisabled({}), false);
});

test("caches a registry result and shows it on the next invocation", async () => {
  const root = await mkdtemp(join(tmpdir(), "teams-update-"));
  const file = join(root, "state.json");
  const response = new Response(JSON.stringify({ version: "0.2.0" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  await runUpdateWorker("0.1.0", file, async () => response, new Date("2026-01-01T00:00:00Z"));
  assert.equal((await loadUpdateState(file))?.pendingVersion, "0.2.0");

  let stderr = "";
  let spawned = 0;
  await prepareUpdateNotification({
    currentVersion: "0.1.0",
    stateFile: file,
    environment: {},
    now: new Date("2026-01-01T00:30:00Z"),
    stderr: { write: (value) => {
      stderr += String(value);
      return true;
    } },
    spawnWorker: () => {
      spawned += 1;
    },
  });
  assert.match(stderr, /0\.1\.0 → 0\.2\.0/);
  assert.equal(spawned, 0);
  assert.equal((await loadUpdateState(file))?.pendingVersion, undefined);
});

test("starts another check only after one hour and ignores malformed cache", async () => {
  const root = await mkdtemp(join(tmpdir(), "teams-update-"));
  const file = join(root, "state.json");
  await writeFile(file, "not json");
  let spawned = 0;
  await prepareUpdateNotification({
    currentVersion: "0.1.0",
    stateFile: file,
    environment: {},
    spawnWorker: () => {
      spawned += 1;
    },
  });
  assert.equal(spawned, 1);

  const checkedAt = new Date("2026-01-01T00:00:00Z");
  await runUpdateWorker("0.1.0", file, async () => new Response("no", { status: 500 }), checkedAt);
  await prepareUpdateNotification({
    currentVersion: "0.1.0",
    stateFile: file,
    environment: {},
    now: new Date(checkedAt.getTime() + UPDATE_INTERVAL_MS - 1),
    spawnWorker: () => {
      spawned += 1;
    },
  });
  assert.equal(spawned, 1);
  assert.doesNotMatch(await readFile(file, "utf8"), /pendingVersion/);
});
