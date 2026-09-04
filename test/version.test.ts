import assert from "node:assert/strict";
import { Command } from "commander";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { registerVersionCommand, renderVersion, showAdaptiveVersion } from "../src/commands/version.js";
import { loadSettings } from "../src/settings.js";
import { storagePaths } from "../src/storage.js";
import { parseBuildInfo } from "../src/version.js";

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

test("refuses persistent channel mutation from npx", async () => {
  const program = new Command().exitOverride();
  registerVersionCommand(program, {
    environment: { npm_command: "exec", npm_lifecycle_event: "npx" },
  });
  await assert.rejects(program.parseAsync(["node", "test", "version", "--channel", "canary"]), /Cannot change persistent settings from npx/);
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

test("persists the notification channel without fetching or changing the installation", async () => {
  const root = await mkdtemp(join(tmpdir(), "teams-cli-version-"));
  try {
    let output = "";
    const program = new Command().exitOverride();
    registerVersionCommand(program, {
      storageRoot: root,
      environment: {},
      fetcher: async () => { throw new Error("channel changes must not contact npm"); },
      stdout: { write: (value) => { output += String(value); return true; } },
      stderr: { write: () => true },
    });
    await program.parseAsync(["node", "test", "version", "--channel", "canary"]);
    assert.deepEqual(await loadSettings(storagePaths(root)), { version: 1, updateChannel: "canary" });
    assert.match(output, /@michaelschnyder\/teams-cli@canary/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
