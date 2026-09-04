import assert from "node:assert/strict";
import test from "node:test";
import { npmInvocation, upgradeCli, type UpgradeRunner } from "../src/upgrade.js";

test("uses npm without a shell and invokes the newly installed skill reinstaller", async () => {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const runner: UpgradeRunner = async (command, args) => {
    calls.push({ command, args });
    return 0;
  };
  await upgradeCli({ runner, globalRoot: async () => "/global/node_modules" });
  const npm = npmInvocation();
  assert.deepEqual(calls[0], {
    command: npm.command,
    args: [...npm.args, "install", "--global", "@michaelschnyder/teams-cli@latest"],
  });
  assert.equal(calls[1]?.command, process.execPath);
  assert.match(calls[1]?.args[0] ?? "", /@michaelschnyder[/\\]teams-cli[/\\]dist[/\\]cli\.js$/);
  assert.deepEqual(calls[1]?.args.slice(1), ["skills", "reinstall"]);
});

test("installs an exact channel candidate and records the channel before refreshing skills", async () => {
  const calls: string[] = [];
  await upgradeCli({
    targetVersion: "0.2.0-canary.12.1.abcdef12",
    runner: async (_command, args) => {
      calls.push(args.at(-1) ?? "");
      return 0;
    },
    globalRoot: async () => "/global/node_modules",
    onInstalled: async () => { calls.push("saved-channel"); },
  });
  assert.equal(calls[0], "@michaelschnyder/teams-cli@0.2.0-canary.12.1.abcdef12");
  assert.equal(calls[1], "saved-channel");
  assert.equal(calls[2], "reinstall");
});

test("invokes npm through Node on Windows without a command shell", () => {
  assert.deepEqual(npmInvocation("win32", "C:\\Program Files\\nodejs\\node.exe", null), {
    command: "C:\\Program Files\\nodejs\\node.exe",
    args: ["C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js"],
  });
});

test("does not reinstall skills after a failed npm upgrade", async () => {
  let calls = 0;
  await assert.rejects(
    upgradeCli({
      runner: async () => {
        calls += 1;
        return 7;
      },
      globalRoot: async () => "/unused",
    }),
    /npm upgrade failed with exit code 7/,
  );
  assert.equal(calls, 1);
});

test("reports an upgraded package with a failed skill refresh as partial failure", async () => {
  let calls = 0;
  await assert.rejects(
    upgradeCli({
      runner: async () => {
        calls += 1;
        return calls === 1 ? 0 : 9;
      },
      globalRoot: async () => "/global/node_modules",
    }),
    /CLI was upgraded, but skill reinstallation failed with exit code 9/,
  );
});
