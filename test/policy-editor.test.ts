import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { inspectPolicyStore, startPolicyEditor } from "../src/policy-editor.js";
import { parsePolicy } from "../src/policy.js";
import { storagePaths } from "../src/storage.js";
import { parseStrictYaml } from "../src/yaml.js";

function readySignal(): { ready: Promise<string>; onReady: (value: { url: string }) => void } {
  let resolveReady!: (url: string) => void;
  return {
    ready: new Promise<string>((resolve) => { resolveReady = resolve; }),
    onReady: ({ url }) => resolveReady(url),
  };
}

test("secures the editor session and atomically saves a draft", async () => {
  const root = await mkdtemp(join(tmpdir(), "teams-cli-editor-"));
  const subject = await mkdtemp(join(tmpdir(), "teams-cli-editor-subject-"));
  const paths = storagePaths(root);
  try {
    const signal = readySignal();
    const running = startPolicyEditor({
      paths,
      context: { profileName: "default", tenantId: "tenant", userId: "user", browser: "edge" },
      subjectStart: subject,
      port: 0,
      version: "test",
      isContainer: false,
      connectTimeoutMs: 10_000,
      onReady: signal.onReady,
    });
    const url = await signal.ready;
    const origin = new URL(url).origin;
    const token = decodeURIComponent(new URL(url).pathname.slice("/claim/".length));

    const page = await fetch(url);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'none'/);
    const pageHtml = await page.text();
    assert.match(pageHtml, /<script type="module" nonce=/);
    assert.match(pageHtml, /Policy Editor for workspace/);
    assert.match(pageHtml, /Workspace policies/);
    assert.match(pageHtml, /Allowed identities/);
    assert.match(pageHtml, /Select another identity/);
    assert.match(pageHtml, /Group chats/);
    assert.match(pageHtml, /For anyone not in the list, or when set to default/);
    assert.match(pageHtml, /Save and activate/);
    assert.match(pageHtml, /Close without saving/);
    assert.match(pageHtml, /data-copy-path/);
    assert.match(pageHtml, /\/api\/people\?q=/);
    assert.match(pageHtml, /\/api\/delete/);
    assert.match(pageHtml, /id="closeEditor"/);
    assert.doesNotMatch(pageHtml, /skypetoken|accessToken/);

    const claim = await fetch(`${origin}/api/claim`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    assert.equal(claim.status, 200);
    const cookie = claim.headers.get("set-cookie")?.split(";", 1)[0];
    assert.ok(cookie);
    const { csrf } = await claim.json() as { csrf: string };

    const replay = await fetch(`${origin}/api/claim`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    assert.equal(replay.status, 401);

    const denied = await fetch(`${origin}/api/render`, {
      method: "POST",
      headers: { origin: "http://evil.invalid", cookie, "x-csrf-token": csrf, "content-type": "application/json" },
      body: JSON.stringify({ policy: {} }),
    });
    assert.equal(denied.status, 403);

    const policy = {
      version: 1,
      name: "editor-draft",
      active: false,
      subject: { paths: [subject, join(subject, "**")] },
      identity: { allowed: [{ tenantId: "tenant", userId: "user" }] },
      allow: { people: { "person-1": ["read"] }, chats: { "chat-1": ["read"] }, channels: { "channel-1": ["post"] }, rawTokenExport: false },
    };
    const saved = await fetch(`${origin}/api/save`, {
      method: "POST",
      headers: { origin, cookie, "x-csrf-token": csrf, "content-type": "application/json" },
      body: JSON.stringify({ policy, originalName: null, expectedHash: null, mode: "draft" }),
    });
    assert.equal(saved.status, 200, await saved.text());
    const stored = parsePolicy(parseStrictYaml(await readFile(join(paths.policiesDirectory, "editor-draft.yaml"), "utf8"), "stored"));
    assert.deepEqual(stored.allow?.chats?.["chat-1"], ["read"]);

    const conflict = await fetch(`${origin}/api/save`, {
      method: "POST",
      headers: { origin, cookie, "x-csrf-token": csrf, "content-type": "application/json" },
      body: JSON.stringify({ policy, originalName: "editor-draft", expectedHash: "stale", mode: "draft" }),
    });
    assert.equal(conflict.status, 409);

    const deletePolicy = { ...policy, name: "delete-me" };
    const deleteSaved = await fetch(`${origin}/api/save`, {
      method: "POST",
      headers: { origin, cookie, "x-csrf-token": csrf, "content-type": "application/json" },
      body: JSON.stringify({ policy: deletePolicy, originalName: null, expectedHash: null, mode: "draft" }),
    });
    assert.equal(deleteSaved.status, 200, await deleteSaved.text());
    const stateBeforeDelete = await fetch(`${origin}/api/state`, { headers: { cookie } });
    const deleteRecord = ((await stateBeforeDelete.json()) as { policies: Array<{ name: string; hash: string }> }).policies.find((record) => record.name === "delete-me");
    assert.ok(deleteRecord);
    const deleted = await fetch(`${origin}/api/delete`, {
      method: "POST",
      headers: { origin, cookie, "x-csrf-token": csrf, "content-type": "application/json" },
      body: JSON.stringify({ name: "delete-me", expectedHash: deleteRecord.hash }),
    });
    assert.equal(deleted.status, 200, await deleted.text());
    assert.equal((await inspectPolicyStore(paths, subject)).some((record) => record.name === "delete-me"), false);

    const missingCsrf = await fetch(`${origin}/api/done`, {
      method: "POST",
      headers: { origin, cookie, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(missingCsrf.status, 403);

    const currentState = await fetch(`${origin}/api/state`, { headers: { cookie } });
    const editorRecord = ((await currentState.json()) as { policies: Array<{ name: string; hash: string }> }).policies.find((record) => record.name === "editor-draft");
    assert.ok(editorRecord);
    const activated = await fetch(`${origin}/api/save`, {
      method: "POST",
      headers: { origin, cookie, "x-csrf-token": csrf, "content-type": "application/json" },
      body: JSON.stringify({ policy, originalName: "editor-draft", expectedHash: editorRecord.hash, mode: "activate" }),
    });
    assert.equal(activated.status, 200, await activated.text());
    assert.equal((await running).reason, "activated");
    const [record] = await inspectPolicyStore(paths, subject);
    assert.equal(record?.policy?.active, true);
    assert.equal(record?.locked, true);

    const exportSignal = readySignal();
    const exporting = startPolicyEditor({
      paths,
      context: { profileName: "default", tenantId: "tenant", userId: "user", browser: "edge" },
      subjectStart: subject,
      port: 0,
      version: "test",
      isContainer: false,
      connectTimeoutMs: 10_000,
      onReady: exportSignal.onReady,
    });
    const exportUrl = await exportSignal.ready;
    const exportOrigin = new URL(exportUrl).origin;
    const exportClaim = await fetch(`${exportOrigin}/api/claim`, {
      method: "POST",
      headers: { origin: exportOrigin, "content-type": "application/json" },
      body: JSON.stringify({ token: decodeURIComponent(new URL(exportUrl).pathname.slice("/claim/".length)) }),
    });
    const exportCookie = exportClaim.headers.get("set-cookie")?.split(";", 1)[0];
    assert.ok(exportCookie);
    const { csrf: exportCsrf } = await exportClaim.json() as { csrf: string };
    const exportState = await fetch(`${exportOrigin}/api/state`, { headers: { cookie: exportCookie } });
    const lockedRecord = ((await exportState.json()) as { policies: Array<{ name: string; hash: string; locked: boolean }> }).policies.find((entry) => entry.name === "editor-draft");
    assert.equal(lockedRecord?.locked, true);
    const revised = { ...policy, active: true, allow: { ...policy.allow, chats: { "chat-1": ["read", "post"] } } };
    const blockedSave = await fetch(`${exportOrigin}/api/save`, {
      method: "POST",
      headers: { origin: exportOrigin, cookie: exportCookie, "x-csrf-token": exportCsrf, "content-type": "application/json" },
      body: JSON.stringify({ policy: revised, originalName: "editor-draft", expectedHash: lockedRecord?.hash, mode: "draft" }),
    });
    assert.equal(blockedSave.status, 409);
    const blockedDelete = await fetch(`${exportOrigin}/api/delete`, {
      method: "POST",
      headers: { origin: exportOrigin, cookie: exportCookie, "x-csrf-token": exportCsrf, "content-type": "application/json" },
      body: JSON.stringify({ name: "editor-draft", expectedHash: lockedRecord?.hash }),
    });
    assert.equal(blockedDelete.status, 409);
    const exported = await fetch(`${exportOrigin}/api/export`, {
      method: "POST",
      headers: { origin: exportOrigin, cookie: exportCookie, "x-csrf-token": exportCsrf, "content-type": "application/json" },
      body: JSON.stringify({ policy: revised, originalName: "editor-draft" }),
    });
    assert.equal(exported.status, 200);
    const exportResult = await exported.json() as { yaml: string; command: string };
    assert.match(exportResult.yaml, /active: true/);
    assert.match(exportResult.yaml, /- post/);
    assert.match(exportResult.command, /sudo sh -c/);
    const exportDone = await fetch(`${exportOrigin}/api/done`, {
      method: "POST",
      headers: { origin: exportOrigin, cookie: exportCookie, "x-csrf-token": exportCsrf, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(exportDone.status, 200);
    assert.equal((await exporting).reason, "done");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(subject, { recursive: true, force: true });
  }
});

async function claimAndDone(url: string): Promise<void> {
  const parsed = new URL(url);
  const origin = parsed.origin;
  const claim = await fetch(`${origin}/api/claim`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ token: decodeURIComponent(parsed.pathname.slice("/claim/".length)) }),
  });
  assert.equal(claim.status, 200);
  const cookie = claim.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);
  const { csrf } = await claim.json() as { csrf: string };
  const done = await fetch(`${origin}/api/done`, {
    method: "POST",
    headers: { origin, cookie, "x-csrf-token": csrf, "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(done.status, 200);
}

test("scans default ports, supports container binding, injects browser opening, and times out", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "teams-cli-editor-network-"));
  const subject = await mkdtemp(join(tmpdir(), "teams-cli-editor-network-subject-"));
  const occupied = createServer();
  try {
    try {
      await new Promise<void>((resolve, reject) => { occupied.once("error", reject); occupied.listen(58_326, "127.0.0.1", resolve); });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
        t.skip("Port 58326 was already occupied by another process");
        return;
      }
      throw error;
    }
    const paths = storagePaths(root);
    const context = { profileName: "default", browser: "edge" } as const;
    const localSignal = readySignal();
    let opened = "";
    const localRunning = startPolicyEditor({
      paths,
      context,
      subjectStart: subject,
      version: "test",
      isContainer: false,
      open: true,
      openUrl: async (url) => { opened = url; },
      onReady: localSignal.onReady,
    });
    const localUrl = await localSignal.ready;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(opened, localUrl);
    assert.notEqual(new URL(localUrl).port, "58326");
    await claimAndDone(localUrl);
    assert.equal((await localRunning).bindAddress, "127.0.0.1");

    const containerSignal = readySignal();
    const containerRunning = startPolicyEditor({
      paths,
      context,
      subjectStart: subject,
      port: 0,
      version: "test",
      isContainer: true,
      onReady: containerSignal.onReady,
    });
    const containerUrl = await containerSignal.ready;
    await claimAndDone(containerUrl);
    assert.equal((await containerRunning).bindAddress, "0.0.0.0");

    const timeoutSignal = readySignal();
    const timeoutRunning = startPolicyEditor({
      paths,
      context,
      subjectStart: subject,
      port: 0,
      version: "test",
      isContainer: false,
      connectTimeoutMs: 10,
      onReady: timeoutSignal.onReady,
    });
    await timeoutSignal.ready;
    assert.equal((await timeoutRunning).reason, "timeout");
  } finally {
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
    await rm(subject, { recursive: true, force: true });
  }
});

test("ends after the final WebSocket disconnect grace period", async () => {
  const root = await mkdtemp(join(tmpdir(), "teams-cli-editor-socket-"));
  const subject = await mkdtemp(join(tmpdir(), "teams-cli-editor-socket-subject-"));
  try {
    const signal = readySignal();
    const running = startPolicyEditor({
      paths: storagePaths(root),
      context: { profileName: "default", tenantId: "tenant", userId: "user", browser: "edge" },
      subjectStart: subject,
      port: 0,
      version: "test",
      isContainer: false,
      connectTimeoutMs: 10_000,
      disconnectGraceMs: 20,
      onReady: signal.onReady,
    });
    const url = await signal.ready;
    const parsed = new URL(url);
    const origin = parsed.origin;
    const claim = await fetch(`${origin}/api/claim`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ token: decodeURIComponent(parsed.pathname.slice("/claim/".length)) }),
    });
    const cookie = claim.headers.get("set-cookie")?.split(";", 1)[0];
    assert.ok(cookie);
    const socket = new WebSocket(`${origin.replace("http", "ws")}/ws`, { headers: { cookie, origin } });
    await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    socket.close();
    assert.equal((await running).reason, "disconnected");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(subject, { recursive: true, force: true });
  }
});

test("tolerant inspection reports invalid policies and locks active policies", async () => {
  const root = await mkdtemp(join(tmpdir(), "teams-cli-editor-inspect-"));
  const subject = await mkdtemp(join(tmpdir(), "teams-cli-editor-inspect-subject-"));
  const paths = storagePaths(root);
  try {
    await import("node:fs/promises").then(({ mkdir, writeFile }) => mkdir(paths.policiesDirectory, { recursive: true }).then(() => Promise.all([
      writeFile(join(paths.policiesDirectory, "invalid.yaml"), "version: [broken\n"),
      writeFile(join(paths.policiesDirectory, "active.yaml"), `version: 1\nname: active\nactive: true\nsubject:\n  paths:\n    - ${subject}\nallow:\n  chats: {}\n  channels: {}\n  rawTokenExport: false\n`),
    ])));
    if (process.platform !== "win32") await chmod(join(paths.policiesDirectory, "active.yaml"), 0o600);
    const records = await inspectPolicyStore(paths, subject);
    assert.match(records.find((record) => record.name === "invalid")?.error ?? "", /unexpected|flow|end/i);
    const active = records.find((record) => record.name === "active");
    assert.equal(active?.locked, true);
    assert.match(active?.lockReason ?? "", /Active policy/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(subject, { recursive: true, force: true });
  }
});
