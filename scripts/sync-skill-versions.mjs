import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const skillsRoot = join(root, "dist", "skills");

for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const file = join(skillsRoot, entry.name, "SKILL.md");
  const content = readFileSync(file, "utf8");
  if (!/^(\s*version:\s*")[^"]+("\s*)$/m.test(content)) {
    throw new Error(`Skill ${entry.name} has no version metadata`);
  }
  const updated = content.replace(/^(\s*version:\s*")[^"]+("\s*)$/m, `$1${version}$2`);
  writeFileSync(file, updated, "utf8");
}
