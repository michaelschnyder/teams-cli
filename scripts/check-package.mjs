import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";

const output = execFileSync("npm", ["pack", "--json", "--ignore-scripts"], {
  encoding: "utf8",
  env: { ...process.env, npm_config_cache: join(tmpdir(), "teams-cli-package-check-cache") },
});
const parsed = JSON.parse(output);
const { filename, files } = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
try {
  const paths = files.map(({ path }) => path);
  const rootFiles = new Set(["package.json", "README.md", "SECURITY.md", "CHANGELOG.md", "LICENSE"]);
  const unexpected = paths.filter((path) => !rootFiles.has(path) && !path.startsWith("dist/") &&
    !path.startsWith("docs/use/") && path !== "docs/releasing.md");
  if (unexpected.length) throw new Error(`Unexpected package files: ${unexpected.join(", ")}`);
  for (const required of [
    "package.json",
    "README.md",
    "LICENSE",
    "dist/cli.js",
    "dist/skills/teams-cli/SKILL.md",
    "docs/releasing.md",
  ]) {
    if (!paths.includes(required)) throw new Error(`Package is missing ${required}`);
  }
  const cli = files.find(({ path }) => path === "dist/cli.js");
  if (!cli || (process.platform !== "win32" && (cli.mode & 0o111) === 0)) {
    throw new Error("dist/cli.js is not executable");
  }
  const firstLine = readFileSync(join(process.cwd(), "dist", "cli.js"), "utf8").split("\n", 1)[0];
  if (firstLine !== "#!/usr/bin/env node") throw new Error("dist/cli.js has no Node shebang");
  process.stdout.write(`Validated ${basename(filename)} with ${files.length} files.\n`);
} finally {
  rmSync(join(process.cwd(), filename), { force: true });
}
