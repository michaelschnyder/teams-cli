import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  detectSkillPlatforms,
  installSkills,
  loadBundledSkills,
  loadSkillManifest,
  lookupSkillPlatform,
  reinstallSkills,
  skillDestination,
} from "../src/skills.js";

test("loads packaged skills and resolves broad platform aliases", async () => {
  const skills = await loadBundledSkills();
  assert.deepEqual(skills.map(({ name }) => name), [
    "teams-authentication",
    "teams-cli",
    "teams-messaging-policies",
    "teams-reading",
  ]);
  assert.equal(lookupSkillPlatform("copilot")?.name, "github-copilot");
  assert.equal(lookupSkillPlatform("gemini")?.name, "gemini-cli");
});

test("detects multiple project and personal agent environments", async () => {
  const project = await mkdtemp(join(tmpdir(), "teams-skills-project-"));
  const home = await mkdtemp(join(tmpdir(), "teams-skills-home-"));
  await mkdir(join(project, ".codex"));
  await mkdir(join(home, ".copilot"));
  assert.deepEqual(detectSkillPlatforms(project, home).map(({ name }) => name), ["codex", "github-copilot"]);
  const copilot = lookupSkillPlatform("copilot");
  assert.ok(copilot);
  assert.equal(skillDestination(copilot, false, project, home), join(home, ".copilot", "skills"));
});

test("records successful installs, protects existing files, and reinstalls managed copies", async () => {
  const root = await mkdtemp(join(tmpdir(), "teams-skills-"));
  const destination = join(root, "destination");
  const manifestFile = join(root, "state", "installations.json");
  const first = await installSkills({ destinations: [destination], names: ["teams-cli"], manifestFile });
  assert.equal(first.filesWritten, 1);
  assert.deepEqual((await loadSkillManifest(manifestFile)).installations, [{
    destination,
    skillNames: ["teams-cli"],
  }]);

  const skillFile = join(destination, "teams-cli", "SKILL.md");
  await writeFile(skillFile, "local change\n");
  const protectedInstall = await installSkills({ destinations: [destination], names: ["teams-cli"], manifestFile });
  assert.equal(protectedInstall.filesWritten, 0);
  assert.equal(await readFile(skillFile, "utf8"), "local change\n");

  const refreshed = await reinstallSkills(manifestFile);
  assert.deepEqual(refreshed, { filesWritten: 1, installations: 1 });
  assert.match(await readFile(skillFile, "utf8"), /name: teams-cli/);
});

test("rejects unknown skill names", async () => {
  const root = await mkdtemp(join(tmpdir(), "teams-skills-"));
  await assert.rejects(
    installSkills({ destinations: [root], names: ["missing"], manifestFile: join(root, "manifest.json") }),
    /Unknown skill: missing/,
  );
});
