import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const temporary = mkdtempSync(join(tmpdir(), "teams-cli-smoke-"));
const cache = join(temporary, "npm-cache");
const environment = {
  ...process.env,
  npm_config_cache: cache,
  NO_UPDATE_NOTIFIER: "1",
};
const expectedVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
if (!process.env.npm_execpath) throw new Error("Run the package smoke test through npm");
const npm = [process.execPath, process.env.npm_execpath];
let tarball;

try {
  const parsed = JSON.parse(execFileSync(npm[0], [npm[1], "pack", "--json", "--ignore-scripts"], {
    cwd: root,
    encoding: "utf8",
    env: environment,
  }));
  const { filename } = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
  tarball = join(root, filename);
  const prefix = join(temporary, "prefix");
  execFileSync(npm[0], [npm[1], "install", "--global", "--prefix", prefix, tarball], {
    stdio: "inherit",
    env: environment,
  });
  const modules = process.platform === "win32" ? join(prefix, "node_modules") : join(prefix, "lib", "node_modules");
  const cli = join(modules, "@michaelschnyder", "teams-cli", "dist", "cli.js");
  const version = execFileSync(process.execPath, [cli, "--version"], { encoding: "utf8", env: environment }).trim();
  if (version !== expectedVersion) throw new Error(`Installed CLI returned unexpected version ${version}`);
  const details = JSON.parse(execFileSync(process.execPath, [cli, "version", "--json"], { encoding: "utf8", env: environment }));
  if (details.installed?.version !== expectedVersion || details.installed?.schemaVersion !== 1) {
    throw new Error("Installed CLI returned invalid build metadata");
  }
  execFileSync(process.execPath, [cli, "--help"], { stdio: "ignore", env: environment });
  process.stdout.write(`Installed package smoke test passed for ${version}.\n`);
} finally {
  if (tarball) rmSync(tarball, { force: true });
  rmSync(temporary, { recursive: true, force: true });
}
