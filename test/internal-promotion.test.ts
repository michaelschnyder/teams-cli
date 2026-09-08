import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as tar from "tar";
import { integrity, inspectArtifact, extractArtifact, transformArtifact, compareArtifact } from "../scripts/package-artifact.mjs";
import { reconcile, eligibleVersions, type Manifest, type Receipt, type PromotionIO } from "../scripts/internal/promote.mjs";
import { verifyProvenance, UPSTREAM_PACKAGE, UPSTREAM_REPOSITORY, WORKFLOW } from "../scripts/internal/provenance.mjs";
import { configuration } from "../scripts/internal/run.mjs";

const commit = "a".repeat(40);
const executable = (entry: tar.WriteEntry) => {
  if (entry.path.replaceAll("\\", "/") === "package/dist/cli.js") entry.stat!.mode |= 0o111;
};
async function fixture(root: string, version = "1.0.0") {
  const dir = join(root, `up-${version}`, "package");
  const files = {
    "package.json": JSON.stringify({
      name: UPSTREAM_PACKAGE,
      version,
      bin: { "teams-cli": "dist/cli.js" },
      dependencies: { example: "^1.0.0" },
      teamsCli: { channel: "stable" },
      publishConfig: { access: "public", provenance: true },
    }),
    "dist/cli.js": '#!/usr/bin/env node\nconsole.log("unchanged");\n',
    "dist/npm.js": "export {};",
    "dist/build-info.json": JSON.stringify({ version, channel: "stable", source: { commit } }),
    "dist/skills/teams-cli/SKILL.md": "skill",
    "dist/skills/teams-cli/claude-cowork.md": "cowork",
    "docs/use/assets/policy-editor.png": "image",
    "docs/releasing.md": "release",
    "README.md": `npm install ${UPSTREAM_PACKAGE}`,
    LICENSE: "original license",
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  await chmod(join(dir, "dist/cli.js"), 0o755);
  const file = join(root, `up-${version}.tgz`);
  await tar.c({ file, cwd: join(dir, ".."), gzip: true, onWriteEntry: executable }, ["package"]);
  return { file, bytes: await readFile(file) };
}
function options(bytes: Buffer) {
  return {
    name: "@zuehlkelabs/teams-cli",
    registry: "https://internal.example/npm/",
    publishRegistry: "https://internal.example/api/npm/",
    upstreamIntegrity: integrity(bytes),
  };
}

function signedPayload(version: string, bytes: Buffer) {
  return {
    predicateType: "https://slsa.dev/provenance/v1",
    subject: [
      {
        name: `pkg:npm/%40michaelschnyder/teams-cli@${version}`,
        digest: { sha512: Buffer.from(integrity(bytes).slice(7), "base64").toString("hex") },
      },
    ],
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: { repository: UPSTREAM_REPOSITORY, path: WORKFLOW, ref: `refs/tags/v${version}` },
        },
        internalParameters: { github: { event_name: "release" } },
        resolvedDependencies: [
          { uri: `git+${UPSTREAM_REPOSITORY}@refs/tags/v${version}`, digest: { gitCommit: commit } },
        ],
      },
    },
  };
}
const bundle = (value: unknown) => ({
  attestations: [
    {
      predicateType: "https://slsa.dev/provenance/v1",
      bundle: { dsseEnvelope: { payload: Buffer.from(JSON.stringify(value)).toString("base64") } },
    },
  ],
});

test("transformation preserves compiled bytes, dependencies, license, and exact version", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "teams-artifact-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = await fixture(root);
  const extracted = await extractArtifact(source.file, join(root, "verified"));
  await rm(source.file); // Transformation must use the verified source, not unpack the input again.
  const result = await transformArtifact(extracted, join(root, "transform"), options(source.bytes));
  assert.equal(await readFile(join(extracted.root, "README.md"), "utf8"), `npm install ${UPSTREAM_PACKAGE}`);
  assert.equal(result.metadata.name, "@zuehlkelabs/teams-cli");
  assert.equal(result.metadata.version, "1.0.0");
  assert.deepEqual(result.metadata.dependencies, { example: "^1.0.0" });
  assert.equal(result.metadata.publishConfig.provenance, false);
  await compareArtifact(extracted, result.file, join(root, "compare"), options(source.bytes));
  await writeFile(join(root, "transform/staged/package/dist/cli.js"), "#!/usr/bin/env node\nchanged");
  const bad = join(root, "bad.tgz");
  await tar.c({ file: bad, cwd: join(root, "transform/staged"), gzip: true, onWriteEntry: executable }, ["package"]);
  await assert.rejects(
    compareArtifact(extracted, bad, join(root, "bad-compare"), options(source.bytes)),
    /payload differs/,
  );
});

test("archive validation rejects links before extraction and digest mismatches before transformation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "teams-archive-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = await fixture(root);
  await assert.rejects(
    transformArtifact(await extractArtifact(source.file, join(root, "verified")), join(root, "bad"), {
      ...options(source.bytes),
      upstreamIntegrity: "sha512-invalid",
    }),
    /integrity/,
  );
  // A link is rejected even if it points inside the archive.
  const { symlink } = await import("node:fs/promises");
  await symlink("README.md", join(root, "up-1.0.0/package/link"));
  const file = join(root, "linked.tgz");
  await tar.c({ file, cwd: join(root, "up-1.0.0"), gzip: true, onWriteEntry: executable }, ["package"]);
  await assert.rejects(inspectArtifact(file), /Unsafe/);
});

test("provenance binds verified signature to expected workflow, source, version, and digest", async () => {
  const bytes = Buffer.from("artifact");
  const value = signedPayload("1.0.0", bytes);
  let verified = false;
  const verifier = async (_bundle: unknown, options: import("sigstore").VerifyOptions) => {
    verified = true;
    assert.equal(options.certificateIssuer, "https://token.actions.githubusercontent.com");
    assert.ok(String(options.certificateIdentityURI).endsWith("v1\\.0\\.0$"));
  };
  await verifyProvenance(bundle(value), bytes, "1.0.0", commit, verifier);
  assert.equal(verified, true);
  await assert.rejects(verifyProvenance(bundle(value), Buffer.from("tampered"), "1.0.0", commit, verifier), /mismatch/);
  await assert.rejects(verifyProvenance(bundle(value), bytes, "1.0.0", "b".repeat(40), verifier), /mismatch/);
  await assert.rejects(
    verifyProvenance(bundle(value), bytes, "1.0.0", commit, async () => {
      throw new Error("invalid signature");
    }),
    /signature/,
  );
  await assert.rejects(verifyProvenance({}, bytes, "1.0.0", commit, verifier), /missing/);
});

test("inventory selection fills gaps and excludes prereleases, deprecated, and pre-bootstrap versions", () => {
  assert.deepEqual(
    eligibleVersions(
      {
        versions: {
          "0.9.0": {},
          "1.0.1": {},
          "1.0.0": {},
          "1.0.2": { deprecated: "bad" },
          "1.1.0-canary.1": {},
          invalid: {},
        },
      },
      "1.0.0",
    ),
    ["1.0.0", "1.0.1"],
  );
});

async function harness(root: string) {
  const source = await fixture(root);
  const manifest = { name: UPSTREAM_PACKAGE, version: "1.0.0", dist: { integrity: integrity(source.bytes), tarball: "https://registry.npmjs.org/example.tgz" } };
  const inventory = { versions: { "1.0.0": manifest }, "dist-tags": { latest: "1.0.0" } };
  const config = {
    ...options(source.bytes),
    workspace: root,
    minimum: "1.0.0",
    pipelineUrl: "https://internal.example/pipelines/1",
  };
  let internal: Manifest | undefined;
  let receipt: Receipt | null = null;
  let bytes = Buffer.alloc(0);
  let publications = 0;
  const tags: Record<string, string> = {};
  const io: PromotionIO = {
    publicInventory: async () => inventory,
    internalInventory: async () => ({ versions: Object.fromEntries(internal ? [["1.0.0", internal]] : []), "dist-tags": { ...tags } }),
    receipt: async () => receipt,
    sourceCommit: async () => commit,
    release: async () => ({ draft: false, prerelease: false, published_at: "2026-09-08", tag_name: "v1.0.0" }),
    publicArtifact: async () => source.bytes,
    attestations: async () => bundle(signedPayload("1.0.0", source.bytes)),
    verifyProvenance: async (attestations, bytes, version, commit) => verifyProvenance(attestations, bytes, version, commit, async () => {}),
    smoke: async () => {},
    publish: async (file: string, tag: string) => {
      publications++;
      bytes = await readFile(file);
      internal = { ...manifest, name: config.name, dist: { integrity: integrity(bytes), tarball: "https://internal.example/package.tgz" } };
      tags[tag] = "1.0.0";
    },
    internalArtifact: async () => bytes,
    record: async (_version, value) => {
      receipt = value;
    },
    setLatest: async (version: string) => {
      tags.latest = version;
    },
    removeTag: async (tag: string) => {
      delete tags[tag];
    },
  };
  return { config, io, publications: () => publications, tags, source };
}

for (const boundary of ["record", "setLatest", "removeTag"] as const)
  test(`retry recovers failure at ${boundary} without republishing`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "teams-retry-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const h = await harness(root);
    let first = true;
    const interrupt = () => {
      if (first) { first = false; throw new Error("interrupted"); }
    };
    if (boundary === "record") {
      const original = h.io.record;
      h.io.record = async (version, receipt) => { interrupt(); return original(version, receipt); };
    } else {
      const original = h.io[boundary];
      h.io[boundary] = async (value) => { interrupt(); return original(value); };
    }
    await assert.rejects(reconcile(h.config, h.io), /interrupted/);
    await reconcile(h.config, h.io);
    assert.equal(h.publications(), 1);
    assert.deepEqual(h.tags, { latest: "1.0.0" });
    assert.equal((await reconcile(h.config, h.io)).writes, 0);
  });

test("failed verification causes zero publication, receipt, or tag network requests", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "teams-denied-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let requests = 0;
  const server = createServer((_req, res) => {
    requests++;
    res.end("{}");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise<void>((done) => server.close(() => done())));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  for (const failure of ["signature", "source", "digest", "release"]) {
    const h = await harness(join(root, failure));
    const write = async () => {
      await fetch(url, { method: "POST" });
    };
    Object.assign(h.io, { publish: write, record: write, setLatest: write, removeTag: write });
    if (failure === "signature")
      h.io.verifyProvenance = async () => {
        throw new Error("bad signature");
      };
    if (failure === "source")
      h.io.sourceCommit = async () => {
        throw new Error("missing source");
      };
    if (failure === "digest") h.io.publicArtifact = async () => Buffer.from("bad");
    if (failure === "release")
      h.io.release = async () => ({ draft: true, prerelease: false, published_at: "", tag_name: "v1.0.0" });
    await assert.rejects(reconcile(h.config, h.io));
  }
  assert.equal(requests, 0);
});

test("overlapping package appearance is rejected instead of overwritten", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "teams-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const h = await harness(root);
  let reads = 0;
  h.io.internalInventory = async () => ({
    versions: Object.fromEntries(++reads === 1 ? [] : [["1.0.0", { name: UPSTREAM_PACKAGE, version: "1.0.0", dist: { integrity: "different", tarball: "https://internal.example/conflict.tgz" } }]]),
    "dist-tags": {},
  });
  await assert.rejects(reconcile(h.config, h.io), /appeared/);
  assert.equal(h.publications(), 0);
});

test("invalid CI context is denied before any synchronization or publication", () => {
  assert.throws(() => configuration({}), /Missing configuration/);
});

test("an existing conflicting receipt prevents all mutation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "teams-receipt-conflict-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const h = await harness(root);
  await reconcile(h.config, h.io);
  const count = h.publications();
  const original = h.io.receipt;
  h.io.receipt = async (version) => { const receipt = await original(version); assert.ok(receipt); return { ...receipt, upstreamIntegrity: "sha512-different" }; };
  await assert.rejects(reconcile(h.config, h.io), /conflicts/);
  assert.equal(h.publications(), count);
});

test("failed registry readback is retried without a second upload", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "teams-readback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const h = await harness(root);
  const original = h.io.internalArtifact;
  let first = true;
  h.io.internalArtifact = async (manifest) => {
    if (first) {
      first = false;
      throw new Error("readback unavailable");
    }
    return original(manifest);
  };
  await assert.rejects(reconcile(h.config, h.io), /unavailable/);
  await reconcile(h.config, h.io);
  assert.equal(h.publications(), 1);
});

test("published packages cannot run the pipeline from an unprotected or push context", () => {
  const env = {
    CI_API_V4_URL: "https://internal.example/api/v4",
    CI_PROJECT_ID: "1",
    CI_PROJECT_URL: "https://internal.example/zuehlkelabs/teams-cli",
    CI_PIPELINE_URL: "https://internal.example/pipeline/1",
    CI_JOB_TOKEN: "test",
    SYNC_TOKEN: "test",
    INTERNAL_NPM_REGISTRY: "https://internal.example/npm/",
    PROMOTION_MIN_VERSION: "1.0.0",
    PROMOTION_SMOKE_IMAGE: "node:24-bookworm",
    CI_COMMIT_BRANCH: "main",
    CI_COMMIT_REF_PROTECTED: "true",
    CI_PIPELINE_SOURCE: "push",
  };
  assert.throws(() => configuration(env), /protected main/);
  assert.throws(
    () => configuration({ ...env, CI_PIPELINE_SOURCE: "web", CI_COMMIT_REF_PROTECTED: "false" }),
    /protected main/,
  );
  assert.equal(
    configuration({ ...env, CI_PIPELINE_SOURCE: "schedule" }).publishRegistry,
    "https://internal.example/api/v4/projects/1/packages/npm/",
  );
});

test("unchanged multi-version reconciliation reads inventories independently of release count", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "teams-inventory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const h = await harness(root);
  await reconcile(h.config, h.io);
  const original = await h.io.publicInventory();
  const internal = (await h.io.internalInventory()).versions["1.0.0"];
  const receipt = await h.io.receipt("1.0.0");
  assert.ok(receipt);
  assert.ok(internal);
  const versions = ["1.0.0", "1.0.1", "1.0.2"];
  const publicInventory = { versions: Object.fromEntries(versions.map(version => [version, { ...original.versions["1.0.0"], version }])), "dist-tags": { latest: "1.0.2" } };
  let inventoryReads = 0;
  const io = {
    ...h.io,
    publicInventory: async () => publicInventory,
    internalInventory: async () => {
      inventoryReads++;
      return { versions: Object.fromEntries(versions.map(version => [version, internal])), "dist-tags": { latest: "1.0.2" } };
    },
    receipt: async (version: string) => ({ ...receipt, version }),
  };
  assert.equal((await reconcile(h.config, io)).writes, 0);
  assert.equal(inventoryReads, 2); // Discovery and the final channel reconciliation.
});

test("refreshes channel state after recording a release and never moves latest backward", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "teams-channel-refresh-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const h = await harness(root);
  const record = h.io.record;
  h.io.record = async (version, receipt) => {
    await record(version, receipt);
    h.tags.latest = "2.0.0";
  };
  await reconcile(h.config, h.io);
  assert.equal(h.publications(), 1);
  assert.deepEqual(h.tags, { latest: "2.0.0" });
});
