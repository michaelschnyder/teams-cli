import assert from "node:assert/strict";
import { Command } from "commander";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { registerVersionCommand, renderVersion, showAdaptiveVersion } from "../src/commands/version.js";
import { loadSettings, saveUpdateChannel } from "../src/settings.js";
import { storagePaths } from "../src/storage.js";
import type { UpgradeOptions } from "../src/upgrade.js";
import { parseBuildInfo, type BuildChannel, type BuildInfo } from "../src/version.js";

function installedBuild(channel: BuildChannel, version: string): BuildInfo {
  return { schemaVersion: 1, version, channel, trigger: { kind: "local" } };
}

function manifest(version: string): Response {
  return new Response(JSON.stringify({ version }), { status: 200, headers: { "content-type": "application/json" } });
}

test("keeps adaptive version output terse outside a TTY", async () => {
  let output = "";
  await showAdaptiveVersion({ stdout: { isTTY: false, write: (value) => { output += String(value); return true; } } });
  assert.equal(output, "0.2.0\n");
});

test("sanitizes provenance and release text rendered in a terminal", () => {
  const rendered = renderVersion({
    schemaVersion: 1,
    version: "0.2.0-canary.2.1.gabcdef12",
    channel: "canary",
    source: { author: "Ada\u001b[31m" },
    releaseNotes: { title: "Useful\u0007 release", body: "Details" },
  }, "canary", null);
  assert.match(rendered, /Source author: Ada/);
  assert.doesNotMatch(rendered, /\[31m|\u001b|\u0007/);
});

test("refuses upgrade and channel mutation from npx", async () => {
  const program = new Command().exitOverride();
  registerVersionCommand(program, {
    environment: { npm_command: "exec", npm_lifecycle_event: "npx" },
  });
  await assert.rejects(program.parseAsync(["node", "test", "version", "--upgrade"]), /temporary npx execution/);
  await assert.rejects(program.parseAsync(["node", "test", "version", "--channel", "canary"]), /Cannot switch an installation channel from npx/);
});

test("validates complete packaged build provenance", () => {
  const info = {
    schemaVersion: 1,
    version: "1.2.3-canary.4.1.gabcdef12",
    channel: "canary",
    builtAt: "2026-09-03T00:00:00.000Z",
    source: { branch: "feature/test", commit: "abcdef12", pullRequest: 42 },
    trigger: { kind: "merged-pull-request", actor: "contributor" },
    runner: { name: "GitHub Actions 1", os: "Linux", architecture: "X64" },
    workflow: { runId: "123", runNumber: "4", runAttempt: "1", url: "https://github.com/example/actions/runs/123" },
    releaseNotes: { title: "Useful change", body: "Details", url: "https://github.com/example/pull/42" },
  };
  assert.deepEqual(parseBuildInfo(info, info.version), info);
  assert.equal(parseBuildInfo({ ...info, runner: "linux" }, info.version), null);
  assert.equal(parseBuildInfo({ ...info, releaseNotes: { title: "Missing body" } }, info.version), null);
  assert.equal(parseBuildInfo(info, "1.2.4"), null);
});

test("switches the installed channel and persists it only after installation succeeds", async () => {
  const root = await mkdtemp(join(tmpdir(), "teams-cli-version-"));
  try {
    let output = "";
    let target = "";
    const program = new Command().exitOverride();
    registerVersionCommand(program, {
      storageRoot: root,
      environment: {},
      fetcher: async (input) => String(input).endsWith("/canary")
        ? manifest("0.3.0-canary.4.1.gabcdef12")
        : manifest("0.2.0"),
      upgrader: async (options) => {
        target = options.targetVersion ?? "";
        await options.onInstalled?.();
      },
      stdout: { write: (value) => { output += String(value); return true; } },
      stderr: { write: () => true },
    });
    await program.parseAsync(["node", "test", "version", "--channel", "canary"]);
    assert.deepEqual(await loadSettings(storagePaths(root)), { version: 1, updateChannel: "canary" });
    assert.equal(target, "0.3.0-canary.4.1.gabcdef12");
    assert.match(output, /follows the canary channel/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not persist a channel when installation fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "teams-cli-version-"));
  try {
    const program = new Command().exitOverride();
    registerVersionCommand(program, {
      storageRoot: root,
      environment: {},
      fetcher: async () => manifest("0.3.0-canary.4.1.gabcdef12"),
      upgrader: async () => { throw new Error("install failed"); },
      stdout: { write: () => true },
      stderr: { write: () => true },
    });
    await assert.rejects(program.parseAsync(["node", "test", "version", "--channel", "canary"]), /install failed/);
    assert.deepEqual(await loadSettings(storagePaths(root)), { version: 1 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("upgrades a canary installation to the newest effective-channel version", async () => {
  const root = await mkdtemp(join(tmpdir(), "teams-cli-version-"));
  try {
    await saveUpdateChannel(storagePaths(root), "canary");
    let target = "";
    const program = new Command().exitOverride();
    registerVersionCommand(program, {
      storageRoot: root,
      environment: {},
      buildInfo: installedBuild("canary", "0.2.0-canary.1.1.g11111111"),
      fetcher: async (input) => String(input).endsWith("/canary")
        ? manifest("0.2.0-canary.5.1.g55555555")
        : manifest("0.1.0"),
      upgrader: async (options) => { target = options.targetVersion ?? ""; },
      stdout: { write: () => true },
      stderr: { write: () => true },
    });
    await program.parseAsync(["node", "test", "version", "--upgrade"]);
    assert.equal(target, "0.2.0-canary.5.1.g55555555");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps snapshot upgrades pinned while allowing an explicit channel switch", async () => {
  const root = await mkdtemp(join(tmpdir(), "teams-cli-version-"));
  try {
    let calls = 0;
    const options = {
      storageRoot: root,
      environment: {},
      buildInfo: installedBuild("snapshot", "0.2.0-snapshot.1.1.g11111111"),
      fetcher: async () => manifest("0.2.0"),
      upgrader: async (upgradeOptions: UpgradeOptions) => {
        calls += 1;
        await upgradeOptions.onInstalled?.();
      },
      stdout: { write: () => true },
      stderr: { write: () => true },
    };
    const pinned = new Command().exitOverride();
    registerVersionCommand(pinned, options);
    await assert.rejects(pinned.parseAsync(["node", "test", "version", "--upgrade"]), /Snapshot builds are pinned/);
    assert.equal(calls, 0);

    const switcher = new Command().exitOverride();
    registerVersionCommand(switcher, options);
    await switcher.parseAsync(["node", "test", "version", "--channel", "stable"]);
    assert.equal(calls, 1);
    assert.equal((await loadSettings(storagePaths(root))).updateChannel, "stable");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("offers an interactive upgrade only for a verified global npm installation", async () => {
  const root = await mkdtemp(join(tmpdir(), "teams-cli-version-"));
  try {
    let confirmations = 0;
    let upgrades = 0;
    const program = new Command().exitOverride();
    registerVersionCommand(program, {
      storageRoot: root,
      environment: {},
      buildInfo: installedBuild("stable", "0.1.0"),
      fetcher: async () => manifest("0.2.0"),
      canUpgrade: async () => true,
      confirm: async () => {
        confirmations += 1;
        return true;
      },
      upgrader: async () => { upgrades += 1; },
      stdout: { isTTY: true, write: () => true },
      stderr: { isTTY: true, write: () => true },
    });
    await program.parseAsync(["node", "test", "version"]);
    assert.equal(confirmations, 1);
    assert.equal(upgrades, 1);

    const local = new Command().exitOverride();
    registerVersionCommand(local, {
      storageRoot: root,
      environment: {},
      buildInfo: installedBuild("stable", "0.1.0"),
      fetcher: async () => manifest("0.2.0"),
      canUpgrade: async () => false,
      confirm: async () => {
        confirmations += 1;
        return true;
      },
      upgrader: async () => { upgrades += 1; },
      stdout: { isTTY: true, write: () => true },
      stderr: { isTTY: true, write: () => true },
    });
    await local.parseAsync(["node", "test", "version"]);
    assert.equal(confirmations, 1);
    assert.equal(upgrades, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
