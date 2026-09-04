import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Command } from "commander";
import { registerDoctorCommand, renderDoctor, runDoctor } from "../src/commands/doctor.js";
import { saveProfile } from "../src/config.js";
import { installSkills } from "../src/skills.js";
import { saveSession, storagePaths, type StoredSession } from "../src/storage.js";

const token = { value: "secret-token-value", expiresAt: "2027-01-01T00:00:00.000Z" };
const session: StoredSession = {
  version: 3,
  browser: "edge",
  tenantId: "tenant",
  userId: "user",
  savedAt: "2026-09-01T00:00:00.000Z",
  region: "emea",
  accessToken: token,
  skypeToken: token,
  chatToken: token,
  searchToken: token,
  endpoints: { chatService: "https://example.invalid" },
};

test("doctor reports local readiness without exposing secrets or verifying Cowork", async () => {
  const root = await mkdtemp(join(tmpdir(), "teams-doctor-"));
  const paths = storagePaths(join(root, ".teams-cli"));
  const skills = join(root, ".codex", "skills");
  await saveSession(paths, session);
  await saveProfile(paths, "default", { tenantId: "tenant", userId: "user", browser: "edge" });
  await installSkills({ destinations: [skills], manifestFile: join(paths.root, "skill-installations.json") });

  const report = await runDoctor({
    paths,
    context: { profileName: "default", tenantId: "tenant", userId: "user", browser: "edge" },
    projectRoot: root,
    userHome: root,
    platform: "win32",
    environment: { ProgramFiles: "C:\\Program Files" },
    exists: (path) => path.endsWith(join("Microsoft", "Edge", "Application", "msedge.exe")) || path === join(root, ".codex"),
    detectCowork: async () => true,
    nodeVersion: "24.0.0",
    now: new Date("2026-09-04T00:00:00.000Z"),
  });

  assert.equal(report.ok, true);
  assert.equal(report.checks.find(({ name }) => name === "skills")?.status, "ok");
  assert.match(report.checks.find(({ name }) => name === "cowork")?.message ?? "", /cannot be verified locally/);
  const output = JSON.stringify(report);
  assert.doesNotMatch(output, /secret-token-value|tenant|user-id/);
  assert.match(renderDoctor(report), /\[OK\] node:/);
});

test("doctor reports hard local prerequisites as errors and performs no repair", async () => {
  const root = await mkdtemp(join(tmpdir(), "teams-doctor-errors-"));
  const paths = storagePaths(join(root, ".teams-cli"));
  const report = await runDoctor({
    paths,
    context: { profileName: "default", browser: "edge" },
    projectRoot: root,
    userHome: root,
    platform: "linux",
    environment: { PATH: "" },
    exists: () => false,
    detectCowork: async () => false,
    nodeVersion: "20.0.0",
  });
  assert.equal(report.ok, false);
  assert.equal(report.checks.find(({ name }) => name === "node")?.status, "error");
  assert.equal(report.checks.find(({ name }) => name === "browser")?.status, "error");
  assert.equal(report.checks.find(({ name }) => name === "identity")?.status, "warning");
  assert.deepEqual(await readdir(root), []);
});

test("doctor command emits the documented JSON shape and sets a failing exit status", async () => {
  const root = await mkdtemp(join(tmpdir(), "teams-doctor-command-"));
  const paths = storagePaths(join(root, ".teams-cli"));
  let output = "";
  let exitCode = 0;
  const program = new Command();
  registerDoctorCommand(program, {
    paths,
    context: { profileName: "default", browser: "edge" },
    projectRoot: root,
    userHome: root,
    platform: "linux",
    environment: { PATH: "" },
    exists: () => false,
    detectCowork: async () => false,
    nodeVersion: "20.0.0",
    stdout: { write: (chunk) => { output += chunk.toString(); return true; } },
    setExitCode: (code) => { exitCode = code; },
  });

  await program.parseAsync(["node", "teams-cli", "doctor", "--json"]);
  const parsed = JSON.parse(output) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed), ["ok", "checks"]);
  assert.equal(parsed.ok, false);
  assert.ok(Array.isArray(parsed.checks));
  assert.deepEqual(Object.keys((parsed.checks as Array<Record<string, unknown>>)[0] ?? {}), ["name", "status", "message"]);
  assert.equal(exitCode, 1);
});
