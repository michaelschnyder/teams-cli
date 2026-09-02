import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseStrictYaml, requireObject } from "./yaml.js";

export type SkillPlatform = {
  name: string;
  aliases: readonly string[];
  projectDirectory: string;
  userDirectory: string;
  markers: readonly string[];
};

export type BundledSkill = { name: string; description: string; content: string };
export type SkillInstallation = { destination: string; skillNames: string[] };
export type SkillManifest = { version: 1; installations: SkillInstallation[] };

const LEGACY_SKILL_NAMES = [
  "teams-authentication",
  "teams-messaging-policies",
  "teams-reading",
] as const;
const LEGACY_SKILLS = new Set<string>(LEGACY_SKILL_NAMES);
const CONSOLIDATED_SKILL = "teams-cli";

export const SKILL_PLATFORMS: readonly SkillPlatform[] = [
  { name: "codex", aliases: [], projectDirectory: ".codex/skills", userDirectory: ".codex/skills", markers: [".codex"] },
  { name: "claude-code", aliases: ["claude"], projectDirectory: ".claude/skills", userDirectory: ".claude/skills", markers: [".claude"] },
  { name: "cursor", aliases: [], projectDirectory: ".cursor/skills", userDirectory: ".cursor/skills", markers: [".cursor"] },
  { name: "github-copilot", aliases: ["copilot"], projectDirectory: ".github/skills", userDirectory: ".copilot/skills", markers: [".github/skills", ".copilot"] },
  { name: "opencode", aliases: [], projectDirectory: ".opencode/skills", userDirectory: ".config/opencode/skills", markers: [".opencode", ".config/opencode"] },
  { name: "windsurf", aliases: [], projectDirectory: ".windsurf/skills", userDirectory: ".windsurf/skills", markers: [".windsurf"] },
  { name: "gemini-cli", aliases: ["gemini"], projectDirectory: ".gemini/skills", userDirectory: ".gemini/skills", markers: [".gemini"] },
  { name: "pi", aliases: ["pi-dev"], projectDirectory: ".pi/skills", userDirectory: ".pi/agent/skills", markers: [".pi"] },
  { name: "agents", aliases: ["agent-skills"], projectDirectory: ".agents/skills", userDirectory: ".agents/skills", markers: [".agents"] },
];

export function skillManifestFile(storageRoot = join(homedir(), ".teams-cli")): string {
  return join(storageRoot, "skill-installations.json");
}

export function findProjectRoot(start = process.cwd()): string {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(start);
    current = parent;
  }
}

export function lookupSkillPlatform(input: string): SkillPlatform | undefined {
  const normalized = input.trim().toLowerCase();
  return SKILL_PLATFORMS.find(({ name, aliases }) => name === normalized || aliases.includes(normalized));
}

export function detectSkillPlatforms(
  projectRoot = findProjectRoot(),
  userHome = homedir(),
): SkillPlatform[] {
  return SKILL_PLATFORMS.filter(({ markers }) => markers.some((marker) =>
    existsSync(join(projectRoot, ...marker.split("/"))) || existsSync(join(userHome, ...marker.split("/")))));
}

export function skillDestination(
  platform: SkillPlatform,
  project: boolean,
  projectRoot = findProjectRoot(),
  userHome = homedir(),
): string {
  const relative = project ? platform.projectDirectory : platform.userDirectory;
  return join(project ? projectRoot : userHome, ...relative.split("/"));
}

function skillsResourceRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "skills");
}

function skillFrontmatter(content: string, file: string): Record<string, unknown> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match?.[1]) throw new Error(`Skill ${file} has no YAML frontmatter`);
  return requireObject(parseStrictYaml(match[1], `Skill ${file} frontmatter`), `Skill ${file} frontmatter`);
}

export async function loadBundledSkills(): Promise<BundledSkill[]> {
  const root = skillsResourceRoot();
  const entries = await readdir(root, { withFileTypes: true });
  const skills: BundledSkill[] = [];
  for (const entry of entries.filter((candidate) => candidate.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = join(root, entry.name, "SKILL.md");
    const content = await readFile(file, "utf8");
    const frontmatter = skillFrontmatter(content, file);
    if (frontmatter.name !== entry.name) {
      throw new Error(`Skill ${entry.name} frontmatter name must match its directory`);
    }
    const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
    if (!description) throw new Error(`Skill ${entry.name} has no description`);
    if (description.includes("\n")) throw new Error(`Skill ${entry.name} description must be one line`);
    skills.push({ name: entry.name, description, content });
  }
  return skills;
}

export async function loadSkillManifest(file = skillManifestFile()): Promise<SkillManifest> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || (parsed as { version?: unknown }).version !== 1) {
      throw new Error("Skill installation manifest is invalid");
    }
    const installations = (parsed as { installations?: unknown }).installations;
    if (!Array.isArray(installations) || !installations.every((item) => {
      if (!item || typeof item !== "object") return false;
      const candidate = item as Partial<SkillInstallation>;
      return typeof candidate.destination === "string" && Array.isArray(candidate.skillNames) &&
        candidate.skillNames.every((name) => typeof name === "string");
    })) throw new Error("Skill installation manifest is invalid");
    return { version: 1, installations: installations as SkillInstallation[] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, installations: [] };
    throw error;
  }
}

async function saveSkillManifest(manifest: SkillManifest, file: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await chmod(dirname(file), 0o700);
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
  await chmod(file, 0o600);
}

export async function installSkills(options: {
  destinations: readonly string[];
  names?: readonly string[];
  force?: boolean;
  manifestFile?: string;
}): Promise<{ filesWritten: number; destinations: string[] }> {
  const bundled = await loadBundledSkills();
  const selected = options.names?.length
    ? bundled.filter(({ name }) => options.names?.includes(name))
    : bundled;
  if (options.names?.length && selected.length !== new Set(options.names).size) {
    const known = new Set(bundled.map(({ name }) => name));
    const missing = options.names.filter((name) => !known.has(name));
    throw new Error(`Unknown skill${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`);
  }
  const destinations = [...new Set(options.destinations.map((destination) => resolve(destination)))];
  let filesWritten = 0;
  const managed = new Map<string, Set<string>>();
  for (const destination of destinations) {
    for (const skill of selected) {
      const directory = join(destination, skill.name);
      const file = join(directory, "SKILL.md");
      await mkdir(directory, { recursive: true });
      let exists = false;
      try {
        await stat(file);
        exists = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (exists && !options.force) continue;
      await writeFile(file, skill.content, "utf8");
      filesWritten += 1;
      const names = managed.get(destination) ?? new Set<string>();
      names.add(skill.name);
      managed.set(destination, names);
    }
  }
  if (managed.size) {
    const file = options.manifestFile ?? skillManifestFile();
    const manifest = await loadSkillManifest(file);
    const records = new Map(manifest.installations.map((entry) => [entry.destination, new Set(entry.skillNames)]));
    for (const [destination, names] of managed) {
      const existing = records.get(destination) ?? new Set<string>();
      for (const name of names) existing.add(name);
      records.set(destination, existing);
    }
    await saveSkillManifest({
      version: 1,
      installations: [...records.entries()].sort(([a], [b]) => a.localeCompare(b)).map(
        ([destination, names]) => ({ destination, skillNames: [...names].sort() }),
      ),
    }, file);
  }
  return { filesWritten, destinations };
}

function consolidatedSkillNames(names: readonly string[]): { names: string[]; legacyNames: string[] } {
  const normalized = new Set<string>();
  const legacyNames: string[] = [];
  for (const name of names) {
    if (LEGACY_SKILLS.has(name)) {
      legacyNames.push(name);
      normalized.add(CONSOLIDATED_SKILL);
    } else {
      normalized.add(name);
    }
  }
  return { names: [...normalized].sort(), legacyNames };
}

async function removeLegacySkill(destination: string, name: string): Promise<void> {
  const directory = join(destination, name);
  try {
    await unlink(join(directory, "SKILL.md"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    await rmdir(directory);
  } catch (error) {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
}

export async function reinstallSkills(manifestFile = skillManifestFile()): Promise<{
  filesWritten: number;
  installations: number;
}> {
  const manifest = await loadSkillManifest(manifestFile);
  const migrations = manifest.installations.map((installation) => ({
    installation,
    ...consolidatedSkillNames(installation.skillNames),
  }));
  let filesWritten = 0;
  for (const { installation, names } of migrations) {
    const result = await installSkills({
      destinations: [installation.destination],
      names,
      force: true,
      manifestFile,
    });
    filesWritten += result.filesWritten;
  }
  if (migrations.some(({ legacyNames }) => legacyNames.length > 0)) {
    for (const { installation, legacyNames } of migrations) {
      for (const name of legacyNames) await removeLegacySkill(installation.destination, name);
    }
    await saveSkillManifest({
      version: 1,
      installations: migrations.map(({ installation, names }) => ({
        destination: installation.destination,
        skillNames: names,
      })),
    }, manifestFile);
  }
  return { filesWritten, installations: manifest.installations.length };
}
