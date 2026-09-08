// Standalone: also executed in a credential-free container with only the tarball.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function smokeInstalled(tarball, installedPrefix) {
  const temporary = mkdtempSync(join(tmpdir(), "teams-cli-smoke-"));
  const environment = { ...process.env, npm_config_cache: join(temporary, "cache"), NO_UPDATE_NOTIFIER: "1", npm_config_update_notifier: "false" };
  const npm = process.env.npm_execpath
    ? [process.execPath, process.env.npm_execpath]
    : process.platform === "win32"
      ? [process.execPath, join(process.execPath, "..", "node_modules/npm/bin/npm-cli.js")]
      : ["npm"];
  const run = (args) =>
    execFileSync(npm[0], [...npm.slice(1), ...args], {
      encoding: "utf8",
      env: environment,
      timeout: 180000,
      maxBuffer: 4 * 1024 * 1024,
    });
  try {
    const prefix = installedPrefix ?? join(temporary, "prefix");
    if (!installedPrefix)
      run(["install", "--global", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund", tarball]);
    const installed = JSON.parse(run(["ls", "--global", "--prefix", prefix, "--depth=0", "--json"]));
    const names = Object.keys(installed.dependencies ?? {});
    if (names.length !== 1 || !/^@[a-z0-9._-]+\/[a-z0-9._-]+$/.test(names[0]))
      throw new Error("Unexpected installed package inventory");
    const root = run(["root", "--global", "--prefix", prefix]).trim();
    const cli = join(root, ...names[0].split("/"), "dist/cli.js");
    const invoke = (args) =>
      execFileSync(process.execPath, [cli, ...args], { encoding: "utf8", env: environment, timeout: 30000 });
    const version = installed.dependencies[names[0]].version;
    if (invoke(["--version"]).trim() !== version) throw new Error("Installed version mismatch");
    const details = JSON.parse(invoke(["version", "--json"]));
    if (
      details.installed?.version !== version ||
      details.installed?.schemaVersion !== 1 ||
      details.package?.name !== names[0]
    )
      throw new Error("Installed build/distribution metadata mismatch");
    invoke(["--help"]);
    const cowork = join(temporary, "cowork");
    invoke(["skills", "install", "claude-cowork", "--dir", cowork]);
    if (
      readFileSync(join(cowork, `teams-cli-cowork-skill-${version}.zip`))
        .subarray(0, 2)
        .toString() !== "PK"
    )
      throw new Error("Invalid Cowork skill archive");
    process.stdout.write(`Installed package smoke test passed for ${names[0]}@${version}.\n`);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  if (process.argv[2] === "--installed") smokeInstalled(undefined, resolve(process.argv[3]));
  else smokeInstalled(resolve(process.argv[2]));
