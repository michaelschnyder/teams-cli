import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("SIGINT closes the invocation log and exits instead of leaving a running spinner", { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "teams-interrupt-"));
  const file = join(root, "run.jsonl");
  const runner = new URL("../src/command-runner.ts", import.meta.url).href;
  const terminal = new URL("../src/terminal.ts", import.meta.url).href;
  const source = `
    import { ResultCommand } from ${JSON.stringify(runner)};
    import { withStatus } from ${JSON.stringify(terminal)};
    process.on("message", () => process.emit("SIGINT"));
    const program = new ResultCommand("test", { stdout: { isTTY: true, write: () => true }, stderr: { isTTY: true, write: chunk => process.stderr.write(chunk) }, environment: { NO_COLOR: "1" } });
    program.option("--log-file <path>");
    program.command("work").action(() => withStatus("Working", async () => {
      process.send("ready");
      await new Promise(() => {});
    }));
    await program.parseAsync(["node", "test", "--log-file", ${JSON.stringify(file)}, "work"]);
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let errors = "";
  child.stderr?.on("data", chunk => { errors += String(chunk); });
  child.on("message", () => child.send("interrupt"));
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
    assert.equal(code, 130, errors);
    assert.match(errors, /Working/);
    const log = await readFile(file, "utf8");
    assert.match(log, /"outcome":"interrupted"/);
    assert.doesNotMatch(log, /"outcome":"success"/);
  } finally { child.kill(); await rm(root, { recursive: true, force: true }); }
});
