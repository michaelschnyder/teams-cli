import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  activatePolicy,
  initializePolicy,
  parsePolicy,
  policyStatusWarnings,
  requireMessageSend,
  requireRawTokenExport,
  resolvePolicies,
  type Policy,
  type PolicyRecord,
  type ResolvedPolicies,
} from "../src/policy.js";
import { storagePaths } from "../src/storage.js";
import { parseStrictYaml } from "../src/yaml.js";

const identity = { tenantId: "tenant", userId: "user" };

function policy(name: string, active = true): Policy {
  return parsePolicy({
    version: 1,
    name,
    active,
    subject: { paths: ["/workspace", "/projects/*"] },
    identity,
    allow: {
      messageSend: { chats: ["chat-1"], channels: ["channel-1"] },
      rawTokenExport: false,
    },
  });
}

function record(value: Policy): PolicyRecord {
  return {
    file: `/policies/${value.name}.yaml`,
    policy: value,
    canonicalSubjectPatterns: value.subject.paths,
    permissionWarnings: [],
  };
}

function resolved(...policies: Policy[]): ResolvedPolicies {
  return { subjectPath: "/workspace", policies: policies.map(record) };
}

test("allows only exact message IDs under the selected target type", () => {
  const policies = resolved(policy("exact"));
  assert.deepEqual(requireMessageSend(policies, identity, { kind: "chat", id: "chat-1" }), []);
  assert.deepEqual(requireMessageSend(policies, identity, { kind: "channel", id: "channel-1" }), []);
  assert.throws(() => requireMessageSend(policies, identity, { kind: "chat", id: "channel-1" }), /denied/);
  assert.throws(() => requireMessageSend(policies, identity, { kind: "chat", id: "CHAT-1" }), /denied/);
});

test("intersects active policies and audits inactive policies", () => {
  const restrictive = {
    ...policy("restrictive"),
    allow: { messageSend: { chats: [], channels: [] }, rawTokenExport: false },
  } satisfies Policy;
  assert.throws(
    () => requireMessageSend(resolved(policy("base"), restrictive), identity, { kind: "chat", id: "chat-1" }),
    /Policy restrictive denied operation/,
  );

  const inactive = { ...restrictive, active: false } satisfies Policy;
  assert.deepEqual(
    requireMessageSend(resolved(policy("base"), inactive), identity, { kind: "chat", id: "chat-1" }),
    ["Inactive policy restrictive would deny operation: chat chat-1 is not allowlisted"],
  );
  assert.match(policyStatusWarnings(resolved(inactive))[0] ?? "", /inactive and not enforcing/);
});

test("rejects policy fields beyond the versioned schema", () => {
  assert.throws(
    () => parsePolicy({
      version: 1,
      name: "example",
      active: false,
      subject: { paths: ["/workspace"] },
      command: "allow",
    }),
    /unknown field command/,
  );
  assert.throws(
    () => parsePolicy({ version: 2, name: "unsupported", active: false, subject: { paths: ["/workspace"] } }),
    /version must be 1/,
  );
});

test("rejects duplicate YAML keys and aliases", () => {
  assert.throws(() => parseStrictYaml("version: 1\nversion: 1\n", "Policy"), /unique/);
  assert.throws(() => parseStrictYaml("value: &shared [one]\ncopy: *shared\n", "Policy"), /Alias resolution is disabled/);
});

test("is unrestricted when no active policy applies", () => {
  const none = resolved();
  assert.deepEqual(requireMessageSend(none, identity, { kind: "chat", id: "anything" }), []);
  assert.deepEqual(requireRawTokenExport(none, identity), []);
  assert.throws(() => requireRawTokenExport(resolved(policy("tokens")), identity), /denied/);

  const tokenAllowed = {
    ...policy("tokens-allowed"),
    allow: { rawTokenExport: true },
  } satisfies Policy;
  assert.deepEqual(requireRawTokenExport(resolved(tokenAllowed), identity), []);
});

test("matches multiple absolute subject path globs", async () => {
  const root = await mkdtemp(join(tmpdir(), "teams-cli-policy-glob-"));
  const parent = await mkdtemp(join(tmpdir(), "teams-cli-subjects-"));
  const matching = await mkdtemp(join(parent, "project-alpha-"));
  const other = await mkdtemp(join(tmpdir(), "teams-cli-other-subject-"));
  try {
    const paths = storagePaths(root);
    await initializePolicy(paths, "globbed", {
      profileName: "default",
      ...identity,
      browser: "edge",
    }, [join(parent, "project-*")], parent);
    assert.deepEqual((await resolvePolicies(paths, matching)).policies.map(({ policy }) => policy.name), ["globbed"]);
    assert.equal((await resolvePolicies(paths, other)).policies.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
    await rm(other, { recursive: true, force: true });
  }
});

test("default initialization covers the selected path and its descendants", async () => {
  const root = await mkdtemp(join(tmpdir(), "teams-cli-policy-descendants-"));
  const subjectPath = await mkdtemp(join(tmpdir(), "teams-cli-policy-root-"));
  const child = join(subjectPath, "nested", "child");
  await mkdir(child, { recursive: true });
  try {
    const paths = storagePaths(root);
    await initializePolicy(paths, "tree", {
      profileName: "default",
      ...identity,
      browser: "edge",
    }, [], subjectPath);
    assert.deepEqual((await resolvePolicies(paths, subjectPath)).policies.map(({ policy }) => policy.name), ["tree"]);
    assert.deepEqual((await resolvePolicies(paths, child)).policies.map(({ policy }) => policy.name), ["tree"]);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(subjectPath, { recursive: true, force: true });
  }
});

test("fails closed when a different subject has a malformed policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "teams-cli-policy-store-"));
  const governedPath = await mkdtemp(join(tmpdir(), "teams-cli-policy-governed-"));
  const currentPath = await mkdtemp(join(tmpdir(), "teams-cli-policy-current-"));
  try {
    const paths = storagePaths(root);
    const stored = await initializePolicy(paths, "governed", {
      profileName: "default",
      ...identity,
      browser: "edge",
    }, [], governedPath);
    assert.equal((await resolvePolicies(paths, currentPath)).policies.length, 0);

    await writeFile(stored.file, "version: [invalid\n", "utf8");
    await assert.rejects(resolvePolicies(paths, currentPath), /Policy denied operation/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(governedPath, { recursive: true, force: true });
    await rm(currentPath, { recursive: true, force: true });
  }
});

test("fails closed when a policy filename does not match its name", async () => {
  const root = await mkdtemp(join(tmpdir(), "teams-cli-policy-name-"));
  const subjectPath = await mkdtemp(join(tmpdir(), "teams-cli-policy-name-subject-"));
  try {
    const paths = storagePaths(root);
    const stored = await initializePolicy(paths, "correct", {
      profileName: "default",
      ...identity,
      browser: "edge",
    }, [], subjectPath);
    await rename(stored.file, join(paths.policiesDirectory, "misnamed.yaml"));
    await assert.rejects(resolvePolicies(paths, subjectPath), /does not match policy name/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(subjectPath, { recursive: true, force: true });
  }
});

test("warns for owner-writable active policies and rejects broader write permissions", {
  skip: process.platform === "win32",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "teams-cli-policy-mode-"));
  const subjectPath = await mkdtemp(join(tmpdir(), "teams-cli-policy-mode-subject-"));
  try {
    const paths = storagePaths(root);
    const inactive = await initializePolicy(paths, "permissions", {
      profileName: "default",
      ...identity,
      browser: "edge",
    }, [], subjectPath);
    await activatePolicy(inactive);
    const applicable = await resolvePolicies(paths, subjectPath);
    assert.match(policyStatusWarnings(applicable)[0] ?? "", /owner-writable/);

    const file = applicable.policies[0]?.file;
    assert.ok(file);
    await chmod(file, 0o620);
    await assert.rejects(resolvePolicies(paths, subjectPath), /writable by group or other users/);

    await chmod(file, 0o600);
    await chmod(paths.policiesDirectory, 0o720);
    await assert.rejects(resolvePolicies(paths, subjectPath), /policy directory .* writable by group or other users/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(subjectPath, { recursive: true, force: true });
  }
});
