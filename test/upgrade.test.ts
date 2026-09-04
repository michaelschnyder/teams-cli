import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  canUpgradeCli,
  npmInvocation,
  resolveGlobalNpmInstallation,
  upgradeCli,
  type NpmInvocation,
  type UpgradeRunner,
} from "../src/upgrade.js";

const npm: NpmInvocation = { command: "npm-test", args: ["npm-cli.js"] };
const globalRoot = join(tmpdir(), "teams-cli-global", "node_modules");
const packageRoot = join(globalRoot, "@michaelschnyder", "teams-cli");
const scopeOptions = {
  npm,
  globalRoot: async () => globalRoot,
  packageRoot,
  canonicalize: resolve,
};

test("recognizes only the package managed by the active npm global root", async () => {
  const installation = await resolveGlobalNpmInstallation(scopeOptions);
  assert.equal(installation.packageRoot, resolve(packageRoot));
  assert.equal(installation.installedCli, join(packageRoot, "dist", "cli.js"));
  assert.equal(await canUpgradeCli(scopeOptions), true);

  const localPackage = join(tmpdir(), "project", "node_modules", "@michaelschnyder", "teams-cli");
  assert.equal(await canUpgradeCli({ ...scopeOptions, packageRoot: localPackage }), false);
  await assert.rejects(
    resolveGlobalNpmInstallation({ ...scopeOptions, packageRoot: localPackage }),
    /only for a global npm installation/,
  );
});

test("installs an exact version without a shell and invokes the newly installed skill reinstaller", async () => {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const runner: UpgradeRunner = async (command, args) => {
    calls.push({ command, args });
    return 0;
  };
  let installed = false;
  await upgradeCli({
    ...scopeOptions,
    targetVersion: "0.2.0-canary.12.1.gabcdef12",
    runner,
    pathExists: () => true,
    onInstalled: async () => { installed = true; },
  });
  assert.deepEqual(calls[0], {
    command: npm.command,
    args: [...npm.args, "install", "--global", "@michaelschnyder/teams-cli@0.2.0-canary.12.1.gabcdef12"],
  });
  assert.equal(installed, true);
  assert.equal(calls[1]?.command, process.execPath);
  assert.equal(calls[1]?.args[0], join(packageRoot, "dist", "cli.js"));
  assert.deepEqual(calls[1]?.args.slice(1), ["skills", "reinstall"]);
});

test("refuses a project-local package before invoking npm", async () => {
  let calls = 0;
  await assert.rejects(
    upgradeCli({
      ...scopeOptions,
      packageRoot: join(tmpdir(), "project", "node_modules", "@michaelschnyder", "teams-cli"),
      runner: async () => {
        calls += 1;
        return 0;
      },
    }),
    /only for a global npm installation/,
  );
  assert.equal(calls, 0);
});

test("invokes npm through Node on Windows without a command shell", () => {
  assert.deepEqual(npmInvocation("win32", "C:\\Program Files\\nodejs\\node.exe", null), {
    command: "C:\\Program Files\\nodejs\\node.exe",
    args: ["C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js"],
  });
});

test("does not persist or refresh skills after a failed npm upgrade", async () => {
  let calls = 0;
  let installed = false;
  await assert.rejects(
    upgradeCli({
      ...scopeOptions,
      runner: async () => {
        calls += 1;
        return 7;
      },
      pathExists: () => true,
      onInstalled: async () => { installed = true; },
    }),
    /npm upgrade failed with exit code 7/,
  );
  assert.equal(calls, 1);
  assert.equal(installed, false);
});

test("reports an upgraded package with a failed skill refresh as a partial failure", async () => {
  let calls = 0;
  await assert.rejects(
    upgradeCli({
      ...scopeOptions,
      runner: async () => {
        calls += 1;
        return calls === 1 ? 0 : 9;
      },
      pathExists: () => true,
    }),
    /CLI was upgraded, but skill reinstallation failed with exit code 9/,
  );
});
