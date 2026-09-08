import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdtemp, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as tar from "tar";

const execute = promisify(execFile);
const docker = async (args) =>
  (await execute("docker", args, { encoding: "utf8", timeout: 60000, maxBuffer: 1024 * 1024 })).stdout.trim();
const temporary = await mkdtemp(join(tmpdir(), "teams-container-input-"));
const container = `teams-smoke-${randomUUID()}`;
let image;
try {
  await copyFile(process.argv[2], join(temporary, "package.tgz"));
  await copyFile(fileURLToPath(new URL("../smoke-installed.mjs", import.meta.url)), join(temporary, "smoke.mjs"));
  // Preparation has network access for dependencies, but runs no package scripts or CLI code.
  await docker([
    "create",
    "--name",
    container,
    "-i",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    process.argv[3],
    "sh",
    "-c",
    "mkdir -p /tmp/smoke && tar -x -C /tmp/smoke && npm install --global --prefix /opt/teams-smoke --ignore-scripts --no-audit --no-fund /tmp/smoke/package.tgz >/dev/null",
  ]);
  const child = spawn("docker", ["start", "--attach", "--interactive", container], {
    stdio: ["pipe", "ignore", "ignore"],
    shell: false,
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 180000);
  const archive = tar.c({ cwd: temporary, portable: true }, ["package.tgz", "smoke.mjs"]);
  archive.on("error", () => child.kill());
  child.stdin.on("error", () => {});
  archive.pipe(child.stdin);
  try {
    await new Promise((done, reject) => {
      child.on("error", reject);
      child.on("exit", (code) => (code === 0 ? done() : reject(new Error("Container dependency preparation failed"))));
    });
  } finally {
    clearTimeout(timer);
  }
  if ((await docker(["inspect", "--format", "{{.State.ExitCode}}", container])) !== "0")
    throw new Error("Container dependency installation failed");
  image = await docker(["commit", container]);
  // The CLI runs with no network, so it cannot reach the CI service network or Docker daemon.
  await docker([
    "run",
    "--rm",
    "--network=none",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    image,
    "node",
    "/tmp/smoke/smoke.mjs",
    "--installed",
    "/opt/teams-smoke",
  ]);
} finally {
  await docker(["rm", "--force", container]).catch(() => {});
  if (image) await docker(["image", "rm", "--force", image]).catch(() => {});
  await rm(temporary, { recursive: true, force: true });
}
