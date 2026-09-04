import assert from "node:assert/strict";
import test from "node:test";
import { npmInvocation, upgradeCli } from "../src/upgrade.js";

test("invokes npm through Node on Windows without a command shell", () => {
  assert.deepEqual(npmInvocation("win32", "C:\\Program Files\\nodejs\\node.exe", null), {
    command: "C:\\Program Files\\nodejs\\node.exe",
    args: ["C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js"],
  });
});

test("disables automatic self-upgrades", async () => {
  await assert.rejects(
    upgradeCli(),
    /Automatic self-upgrade is disabled/,
  );
});
