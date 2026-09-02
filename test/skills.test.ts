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
  assert.deepEqual(skills.map(({ name }) => name), ["teams-cli"]);
  assert.equal(skills[0]?.description.includes("\n"), false);
  assert.ok((skills[0]?.description.length ?? Number.POSITIVE_INFINITY) < 140);
  const firstUse = skills[0]?.content.indexOf("teams-cli auth login") ?? -1;
  const verification = skills[0]?.content.indexOf("teams-cli auth whoami") ?? -1;
  assert.ok(firstUse >= 0 && verification > firstUse);
  assert.match(skills[0]?.content ?? "", /ordinary flow does not need a named profile, tenant ID, or user ID/);
  assert.match(skills[0]?.content ?? "", /message send --person alice@example\.com/);
  assert.match(skills[0]?.content ?? "", /policy preflight is optional/);
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

test("migrates recorded legacy skills to the consolidated managed copy", async () => {
  const root = await mkdtemp(join(tmpdir(), "teams-skills-migration-"));
  const firstDestination = join(root, "first");
  const secondDestination = join(root, "second");
  const manifestFile = join(root, "state", "installations.json");
  const legacyNames = ["teams-authentication", "teams-messaging-policies", "teams-reading"];

  for (const name of legacyNames) {
    await mkdir(join(firstDestination, name), { recursive: true });
    await writeFile(join(firstDestination, name, "SKILL.md"), `${name}\n`);
  }
  await writeFile(join(firstDestination, "teams-reading", "notes.md"), "preserve me\n");
  await mkdir(join(secondDestination, "teams-reading"), { recursive: true });
  await writeFile(join(secondDestination, "teams-reading", "SKILL.md"), "teams-reading\n");
  await mkdir(join(root, "state"), { recursive: true });
  await writeFile(manifestFile, `${JSON.stringify({
    version: 1,
    installations: [
      { destination: firstDestination, skillNames: legacyNames },
      { destination: secondDestination, skillNames: ["teams-reading"] },
    ],
  }, null, 2)}\n`);

  assert.deepEqual(await reinstallSkills(manifestFile), { filesWritten: 2, installations: 2 });
  assert.deepEqual((await loadSkillManifest(manifestFile)).installations, [
    { destination: firstDestination, skillNames: ["teams-cli"] },
    { destination: secondDestination, skillNames: ["teams-cli"] },
  ]);
  assert.match(await readFile(join(firstDestination, "teams-cli", "SKILL.md"), "utf8"), /name: teams-cli/);
  assert.match(await readFile(join(secondDestination, "teams-cli", "SKILL.md"), "utf8"), /name: teams-cli/);
  for (const name of legacyNames) {
    await assert.rejects(readFile(join(firstDestination, name, "SKILL.md"), "utf8"), { code: "ENOENT" });
  }
  await assert.rejects(readFile(join(secondDestination, "teams-reading", "SKILL.md"), "utf8"), { code: "ENOENT" });
  assert.equal(await readFile(join(firstDestination, "teams-reading", "notes.md"), "utf8"), "preserve me\n");

  assert.deepEqual(await reinstallSkills(manifestFile), { filesWritten: 2, installations: 2 });
  assert.equal(await readFile(join(firstDestination, "teams-reading", "notes.md"), "utf8"), "preserve me\n");
});

test("rejects unknown skill names", async () => {
  const root = await mkdtemp(join(tmpdir(), "teams-skills-"));
  await assert.rejects(
    installSkills({ destinations: [root], names: ["missing"], manifestFile: join(root, "manifest.json") }),
    /Unknown skill: missing/,
  );
});
