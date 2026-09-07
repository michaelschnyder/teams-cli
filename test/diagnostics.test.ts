import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Diagnostics, MAX_LOG_BYTES, observedFetch, resolveLogLevel, withDiagnostics, withRequestAttempt } from "../src/diagnostics.js";
import { Terminal } from "../src/terminal.js";

function terminal() {
  let stderr = "";
  return { terminal: new Terminal({ interactive: false, stderr: { write: chunk => { stderr += String(chunk); return true; } } }), output: () => stderr };
}

test("diagnostics project safe HTTP fields before either reporter", async () => {
  const root = await mkdtemp(join(tmpdir(), "teams-diagnostics-"));
  const capture = terminal();
  const file = join(root, "debug.jsonl");
  const diagnostics = new Diagnostics(capture.terminal, "trace", file);
  try {
    await withDiagnostics(diagnostics, async () => {
      await observedFetch(async () => new Response("secret-response"), "https://secret-user:secret-pass@example.test/v1/users/ada%40example.com/conversations/secret-chat/messages/secret-message?token=secret-query", { headers: { authorization: "secret-header" }, body: "secret-body" });
      await assert.rejects(observedFetch(async () => { throw new Error("secret-error"); }, "http://localhost:9999/editor?token=secret-editor"), /secret-error/);
    });
    diagnostics.close();
    const fileOutput = await readFile(file, "utf8");
    for (const output of [capture.output(), fileOutput]) {
      assert.doesNotMatch(output, /secret-|ada|example\.test|9999/);
      assert.match(output, /conversations\/<redacted>\/messages\/<redacted>/);
      assert.match(output, /response/);
    }
    const entries = fileOutput.trim().split("\n").map(line => JSON.parse(line));
    assert.equal(entries[1].status, 200);
    assert.equal(entries[3].event, "http-error");
    if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);
  } finally { diagnostics.close(); await rm(root, { recursive: true, force: true }); }
});

test("concurrent attempts and separate invocations cannot overwrite diagnostic context", async () => {
  const a = terminal(), b = terminal();
  const first = new Diagnostics(a.terminal, "debug"), second = new Diagnostics(b.terminal, "debug");
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await Promise.all([
    withDiagnostics(first, () => withRequestAttempt(2, () => observedFetch(async () => { await gate; return new Response(null, { status: 201 }); }, "https://example.test/messages/a"))),
    withDiagnostics(second, () => withRequestAttempt(1, () => observedFetch(async () => { release(); return new Response(null, { status: 202 }); }, "https://example.test/messages/b"))),
  ]);
  assert.match(a.output(), /status=201/); assert.match(a.output(), /attempt=2/);
  assert.doesNotMatch(a.output(), /status=202|attempt=1/);
  assert.match(b.output(), /status=202/); assert.match(b.output(), /attempt=1/);
  assert.doesNotMatch(b.output(), /status=201|attempt=2/);
  const same = terminal(); const diagnostics = new Diagnostics(same.terminal, "debug");
  await withDiagnostics(diagnostics, () => Promise.all([1, 2].map(attempt => withRequestAttempt(attempt, () => observedFetch(async () => new Response(null, { status: 200 + attempt }), "https://example.test/messages/id")))));
  assert.match(same.output(), /attempt=1 status=201/);
  assert.match(same.output(), /attempt=2 status=202/);
});

test("file logging captures debug with a quiet terminal and stops once at the size limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "teams-log-limit-"));
  const capture = terminal(); const file = join(root, "log.jsonl");
  const diagnostics = new Diagnostics(capture.terminal, "error", file);
  try {
    diagnostics.emit({ event: "refresh", target: "access" });
    assert.equal(capture.output(), "");
    assert.match(await readFile(file, "utf8"), /refresh/);
    await truncate(file, MAX_LOG_BYTES);
    diagnostics.emit({ event: "refresh", target: "chat" });
    diagnostics.emit({ event: "refresh", target: "search" });
    assert.equal((capture.output().match(/10 MiB/g) ?? []).length, 1);
    assert.equal((await stat(file)).size, MAX_LOG_BYTES);
    assert.throws(() => new Diagnostics(capture.terminal, "debug", root), /regular file/);
    assert.throws(() => new Diagnostics(capture.terminal, "debug", join(root, "missing", "log")), /regular file/);
  } finally { diagnostics.close(); await rm(root, { recursive: true, force: true }); }
});

test("explicit log levels override debug and verbosity", () => {
  assert.equal(resolveLogLevel({ log: "error", debug: true, verbose: 3 }, true), "error");
  assert.equal(resolveLogLevel({ debug: true, verbose: 3 }, false), "debug");
  assert.deepEqual([1, 2, 3, 4].map(verbose => resolveLogLevel({ verbose }, false)), ["info", "debug", "trace", "trace"]);
  assert.equal(resolveLogLevel({}, false), "warn"); assert.equal(resolveLogLevel({}, true), "info");
});

test("runtime file failures disable logging without changing an operation's success", async () => {
  const root = await mkdtemp(join(tmpdir(), "teams-log-failure-"));
  const capture = terminal();
  const diagnostics = new Diagnostics(capture.terminal, "error", join(root, "log.jsonl"));
  try {
    // Simulate a storage failure after startup without replacing process streams or fs exports.
    const { closeSync } = await import("node:fs");
    const descriptor = (diagnostics as unknown as { file: number; }).file;
    closeSync(descriptor);
    const response = await withDiagnostics(diagnostics, () => observedFetch(async () => new Response(null, { status: 204 }), "https://example.test/messages/id"));
    assert.equal(response.status, 204);
    assert.equal((capture.output().match(/file logging stopped/g) ?? []).length, 1);
  } finally { diagnostics.close(); await rm(root, { recursive: true, force: true }); }
});
