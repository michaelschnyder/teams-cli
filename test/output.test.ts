import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { createProgram } from "../src/cli.js";
import { commandResult, resolveOutput, writeResult } from "../src/output.js";
import { renderView } from "../src/presentation.js";
import { safeRefresh, safeSession } from "../src/results.js";
import { ResultCommand } from "../src/command-runner.js";
import { Terminal, withStatus, withTerminal } from "../src/terminal.js";
import type { StoredSession } from "../src/storage.js";

function capture(isTTY = false, columns = 100) {
  let output = "";
  return { isTTY, columns, write: (value: string | Uint8Array) => { output += String(value); return true; }, output: () => output };
}
function session(): StoredSession {
  const token = { value: `header.${Buffer.from(JSON.stringify({ tid: "tenant", oid: "user", aud: "audience", name: "Ada" })).toString("base64url")}.secret-signature`, expiresAt: "2030-01-01T00:00:00.000Z" };
  return { version: 3, browser: "edge", tenantId: "tenant", userId: "user", savedAt: "2026-09-06T00:00:00.000Z", region: "emea", endpoints: { chatService: "https://example.test" }, accessToken: token, skypeToken: token, chatToken: token, searchToken: token };
}

test("output defaults and explicit formats are consistent", () => {
  assert.equal(resolveOutput({}, true), "text"); assert.equal(resolveOutput({}, false), "json");
  assert.equal(resolveOutput({ output: "text" }, false), "text");
  assert.equal(resolveOutput({ json: true }, true), "json");
  assert.throws(() => resolveOutput({ output: "yaml", json: true }, false), /conflicts/);
});

test("JSON and YAML retain full data, empty collections, pagination, and acknowledgements", () => {
  for (const result of [commandResult("chats", { chats: [], page: { nextCursor: "opaque-cursor" } }), commandResult("ack", { action: "Saved profile", name: "default" })]) {
    const json = capture(), yaml = capture();
    writeResult(result, "json", json); writeResult(result, "yaml", yaml);
    assert.deepEqual(JSON.parse(json.output()), parse(yaml.output()));
    assert.deepEqual(JSON.parse(json.output()), result.data);
  }
});

test("Unicode and multiline cells align while narrow layouts preserve full identifiers", () => {
  const view = { kind: "table" as const, title: "People", headers: ["Name", "ID"], rows: [["李雷", "full-id-one"], ["A\n👩‍💻", "full-id-two"]] };
  const wide = renderView(view, capture(true, 100), { NO_COLOR: "1" });
  assert.match(wide, /李雷\s+full-id-one/); assert.match(wide, /👩‍💻/); assert.doesNotMatch(wide, /\x1b/);
  const narrow = renderView(view, capture(true, 15), {});
  assert.match(narrow, /full-id-one/); assert.match(narrow, /full-id-two/);
  const plain = renderView(view, capture(false), {}); assert.doesNotMatch(plain, /\x1b/);
  const messages = renderView({ kind: "messages", title: "Messages", messages: [{ heading: "Ada [id]", content: "First\nSecond\u001b[31m" }] }, capture(), {});
  assert.match(messages, /  First\n  Second/); assert.doesNotMatch(messages, /\x1b/);
});

test("auth result models never serialize stored credentials in any format", () => {
  const stored = session();
  for (const result of [commandResult("session", safeSession(stored)), commandResult("refresh", safeRefresh({ target: "all", before: stored, after: stored }))]) {
    for (const format of ["text", "json", "yaml"] as const) {
      const stream = capture(); writeResult(result, format, stream);
      assert.doesNotMatch(stream.output(), /secret-signature|header\.|"value"|savedAt|chatService/);
      assert.match(stream.output(), /audience/);
    }
  }
});

test("login emits one safe result, respects format overrides, and never prompts in structured mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "teams-output-login-"));
  try {
    for (const format of ["json", "yaml", "text"] as const) {
      const stdout = capture(), stderr = capture(); const file = join(root, `${format}.jsonl`);
      let prompts = 0;
      await createProgram({ storageRoot: root, stdout, stderr, environment: { CI: "1" }, confirm: async () => { prompts++; return false; }, loginImplementation: async () => session() })
        .parseAsync(["node", "teams-cli", "--log-file", file, "login", "--output", format]);
      assert.doesNotMatch(stdout.output() + stderr.output() + await readFile(file, "utf8"), /secret-signature/);
      if (format !== "text") { assert.equal(prompts, 0); assert.equal(parse(stdout.output()).authenticated, true); }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("runner validates output and log destination before executing commands", async () => {
  let calls = 0; const program = new ResultCommand("test", { stdout: capture(), stderr: capture() });
  program.option("--log-file <path>");
  program.command("work").action(async () => { calls++; return commandResult("ack", { action: "Saved profile", name: "default" }); });
  await assert.rejects(program.parseAsync(["node", "test", "work", "--json", "--output", "yaml"]), /conflicts/);
  assert.equal(calls, 0);
  const root = await mkdtemp(join(tmpdir(), "teams-invalid-log-"));
  try {
    const other = new ResultCommand("test", { stdout: capture(), stderr: capture() }); other.option("--log-file <path>");
    other.command("work").action(() => { calls++; return commandResult("ack", { action: "Saved profile", name: "default" }); });
    await assert.rejects(other.parseAsync(["node", "test", "--log-file", root, "work"]), /regular file/);
    assert.equal(calls, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("terminal suppresses animation and prompts in structured mode and restores nested status", async () => {
  const stderr = capture(); let prompts = 0;
  const terminal = new Terminal({ interactive: false, stderr, confirm: async () => { prompts++; return true; } });
  await withTerminal(terminal, () => withStatus("Loading", async () => {
    await withStatus("Refreshing", async () => { assert.equal(await terminal.confirm("Continue?"), false); });
  }));
  terminal.close(); assert.equal(prompts, 0); assert.equal(stderr.output(), "");
  const interactive = new Terminal({ interactive: true, stderr, environment: { TERM: "dumb" }, confirm: async () => true });
  await interactive.statusDuring("Working", async () => { assert.equal(await interactive.confirm("Continue?"), true); });
  interactive.close(); assert.doesNotMatch(stderr.output(), /\x1b/);
});

test("animated status resumes after nested phases and prompts and stops after cleanup", async () => {
  const stderr = capture(true);
  const terminal = new Terminal({ interactive: true, stderr, environment: { NO_COLOR: "1" }, confirm: async () => true });
  await terminal.statusDuring("Loading messages", async () => {
    await terminal.statusDuring("Refreshing access", async () => { });
    terminal.line("Warning: audit mode");
    assert.equal(await terminal.confirm("Continue?"), true);
  });
  terminal.close();
  const output = stderr.output();
  assert.match(output, /Refreshing access/);
  assert.ok((output.match(/Loading messages/g) ?? []).length >= 3);
  assert.match(output, /Warning: audit mode/);
  assert.doesNotMatch(output, /\x1b\[[0-9;]*m/);
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(stderr.output(), output);
});

test("command failure logs its outcome without persisting the thrown error", async () => {
  const root = await mkdtemp(join(tmpdir(), "teams-failure-log-"));
  try {
    const file = join(root, "run.jsonl");
    const program = new ResultCommand("test", { stdout: capture(), stderr: capture() });
    program.option("--log-file <path>");
    program.command("work").action(async () => { throw new Error("secret-token-from-error"); });
    await assert.rejects(program.parseAsync(["node", "test", "--log-file", file, "work"]), /secret-token-from-error/);
    const log = await readFile(file, "utf8");
    assert.match(log, /"outcome":"error"/);
    assert.doesNotMatch(log, /secret-token-from-error/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("explicit version format overrides its terse export exception", async () => {
  const stdout = capture();
  await createProgram({ stdout, stderr: capture(), environment: { NO_UPDATE_NOTIFIER: "1" } }).parseAsync(["node", "teams-cli", "--version", "--json"]);
  assert.equal(JSON.parse(stdout.output()).installed.version, "0.2.0");
});
