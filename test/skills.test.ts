import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { strFromU8, unzipSync } from "fflate";
import { runSkillsInstall } from "../src/commands/skills.js";
import { CLI_VERSION } from "../src/version.js";
import {
  createCoworkSkillPackage,
  detectClaudeDesktop,
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
  const firstUse = skills[0]?.content.indexOf("teams-cli login") ?? -1;
  const verification = skills[0]?.content.indexOf("teams-cli auth whoami") ?? -1;
  assert.ok(firstUse >= 0 && verification > firstUse);
  assert.match(skills[0]?.content ?? "", /ordinary flow does not need a named profile, tenant ID, or user ID/);
  assert.match(skills[0]?.content ?? "", /message send --person alice@example\.com/);
  assert.match(skills[0]?.content ?? "", /policy preflight is optional/);
  assert.match(skills[0]?.content ?? "", /Always try `chat search <query>` before enumerating chats/);
  assert.match(skills[0]?.content ?? "", /chat list --all --json/);
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
  assert.equal(protectedInstall.files[0]?.status, "conflict");
  assert.equal(await readFile(skillFile, "utf8"), "local change\n");

  const refreshed = await reinstallSkills(manifestFile);
  assert.deepEqual(refreshed, { filesWritten: 1, installations: 1 });
  assert.match(await readFile(skillFile, "utf8"), /name: teams-cli/);
});

test("treats an identical existing skill as installed and begins managing it", async () => {
  const root = await mkdtemp(join(tmpdir(), "teams-skills-identical-"));
  const destination = join(root, "destination");
  const manifestFile = join(root, "state", "installations.json");
  const canonical = (await loadBundledSkills())[0]?.content;
  assert.ok(canonical);
  await mkdir(join(destination, "teams-cli"), { recursive: true });
  await writeFile(join(destination, "teams-cli", "SKILL.md"), canonical.replaceAll("\n", "\r\n"));

  const result = await installSkills({ destinations: [destination], manifestFile });

  assert.equal(result.filesWritten, 0);
  assert.equal(result.files[0]?.status, "already-installed");
  assert.deepEqual((await loadSkillManifest(manifestFile)).installations, [{ destination, skillNames: ["teams-cli"] }]);

  const forced = await installSkills({ destinations: [destination], manifestFile, force: true });
  assert.equal(forced.filesWritten, 1);
  assert.equal(forced.files[0]?.status, "installed");
  assert.equal(await readFile(join(destination, "teams-cli", "SKILL.md"), "utf8"), canonical);
});

test("detects Claude Desktop without depending on the host operating system", async () => {
  const commands: Array<{ command: string; args: readonly string[] }> = [];
  assert.equal(await detectClaudeDesktop({
    platform: "win32",
    run: async (command, args) => {
      commands.push({ command, args });
      return "Claude\n";
    },
  }), true);
  assert.equal(commands[0]?.command, "powershell.exe");
  assert.match(commands[0]?.args.join(" ") ?? "", /Get-AppxPackage -Name Claude/);

  assert.equal(await detectClaudeDesktop({
    platform: "darwin",
    userHome: "/users/alice",
    exists: (path) => path === "/Applications/Claude.app",
  }), true);
  assert.equal(await detectClaudeDesktop({
    platform: "linux",
    userHome: "/home/alice",
    environment: { PATH: "/usr/local/bin:/usr/bin" },
    exists: (path) => path === "/usr/local/bin/claude-desktop",
  }), true);
  assert.equal(await detectClaudeDesktop({ platform: "aix", exists: () => true }), false);
});

test("creates a Cowork ZIP with a thin adapter and the unchanged canonical skill", async () => {
  const root = await mkdtemp(join(tmpdir(), "teams-cowork-skill-"));
  const file = await createCoworkSkillPackage(root);
  const archive = unzipSync(await readFile(file));
  assert.deepEqual(Object.keys(archive).sort(), ["SKILL.md", "instructions.md"]);
  const canonical = (await loadBundledSkills())[0]?.content;
  assert.ok(canonical);
  assert.equal(strFromU8(archive["instructions.md"] as Uint8Array), canonical);
  const adapter = strFromU8(archive["SKILL.md"] as Uint8Array);
  assert.match(adapter, /name: teams-cli/);
  assert.match(adapter, new RegExp(`version: "${CLI_VERSION.replaceAll(".", "\\.")}"`));
  assert.match(adapter, /\[complete teams-cli instructions\]\(instructions\.md\)/);
  assert.doesNotMatch(adapter, /header\.|signature|bearer token value/);
});

test("installs detected local skills and prepares Cowork without recording Cowork state", async () => {
  const root = await mkdtemp(join(tmpdir(), "teams-cowork-install-"));
  const storageRoot = join(root, ".teams-cli");
  await mkdir(join(root, ".claude"));
  let output = "";
  await runSkillsInstall(undefined, {}, {
    storageRoot,
    projectRoot: root,
    userHome: root,
    detectCowork: async () => true,
    stdout: { write: (chunk) => { output += chunk.toString(); return true; } },
  });

  assert.match(output, /^Installed claude-code:/m);
  assert.match(output, /^Claude Cowork requires one final step\.$/m);
  assert.match(output, /cannot verify Cowork's account-level installation or permissions/);
  assert.equal((await loadSkillManifest(join(storageRoot, "skill-installations.json"))).installations.length, 1);
  assert.ok((await readFile(join(root, "Downloads", `teams-cli-cowork-skill-${CLI_VERSION}.zip`))).length > 0);

  output = "";
  const explicitOutput = join(root, "exports");
  await runSkillsInstall("claude-cowork", { dir: explicitOutput }, {
    storageRoot,
    projectRoot: root,
    userHome: root,
    detectCowork: async () => false,
    stdout: { write: (chunk) => { output += chunk.toString(); return true; } },
  });
  assert.match(output, /^Claude Cowork requires one final step\.$/m);
  assert.ok((await readFile(join(explicitOutput, `teams-cli-cowork-skill-${CLI_VERSION}.zip`))).length > 0);
  assert.equal((await loadSkillManifest(join(storageRoot, "skill-installations.json"))).installations.length, 1);
});

test("reports simple installation states while preserving a modified copy", async () => {
  const root = await mkdtemp(join(tmpdir(), "teams-skills-output-"));
  const destination = join(root, "skills");
  const options = {
    storageRoot: join(root, ".teams-cli"),
    projectRoot: root,
    userHome: root,
    detectCowork: async () => false,
  };
  let output = "";
  const stdout = { write: (chunk: string | Uint8Array) => { output += chunk.toString(); return true; } };

  await runSkillsInstall("codex", { dir: destination }, { ...options, stdout });
  assert.match(output, /^Installed custom agent directory:/);
  output = "";
  await runSkillsInstall("codex", { dir: destination }, { ...options, stdout });
  assert.match(output, /^Already installed custom agent directory:/);

  const skillFile = join(destination, "teams-cli", "SKILL.md");
  await writeFile(skillFile, "modified\n");
  output = "";
  await runSkillsInstall("codex", { dir: destination }, { ...options, stdout });
  assert.match(output, /^Already installed custom agent directory:.*left unchanged/);
  assert.equal(await readFile(skillFile, "utf8"), "modified\n");
  output = "";
  await runSkillsInstall("codex", { dir: destination, force: true }, { ...options, stdout });
  assert.match(output, /^Installed custom agent directory:/);
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
