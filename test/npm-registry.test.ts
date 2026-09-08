import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveRegistry, registryArgs, configurationKey, type NpmExecutor } from "../src/npm.js";
import { upgradeCli } from "../src/upgrade.js";
import { PACKAGE_NAME } from "../src/version.js";

test("npm uses authenticated user scope settings and the same explicit registry for upgrade", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "teams-registry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let requests = 0;
  const server = createServer((req, res) => {
    requests++;
    assert.equal(req.headers.authorization, "Bearer test-token");
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        name: PACKAGE_NAME,
        "dist-tags": { latest: "1.0.0" },
        versions: { "1.0.0": { name: PACKAGE_NAME, version: "1.0.0" } },
      }),
    );
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise<void>((done) => server.close(() => done())));
  const registry = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  const npmrc = join(root, "npmrc");
  const global = join(root, "global");
  await writeFile(
    npmrc,
    `@michaelschnyder:registry=${registry}\n${registry.replace("http:", "")}:_authToken=test-token\n`,
  );
  await writeFile(global, "");
  const environment = {
    ...process.env,
    npm_config_userconfig: npmrc,
    npm_config_globalconfig: global,
    npm_config_cache: join(root, "cache"),
  };
  const client = await resolveRegistry({ environment });
  assert.equal(client.registry, registry);
  assert.equal(((await client.manifest("latest")) as { version: string }).version, "1.0.0");
  assert.ok(requests > 0);
  assert.equal(await client.manifest("canary"), null);
  const calls: readonly string[][] = [];
  await upgradeCli({
    destination: client,
    globalRoot: async () => root,
    packageRoot: join(root, ...PACKAGE_NAME.split("/")),
    canonicalize: (p) => p,
    targetVersion: "1.0.0",
    pathExists: () => true,
    runner: async (_cmd, args) => {
      (calls as string[][]).push([...args]);
      return 0;
    },
  });
  assert.ok(calls[0]?.includes(`${PACKAGE_NAME}@1.0.0`));
  for (const arg of registryArgs(PACKAGE_NAME, registry)) assert.ok(calls[0]?.includes(arg));
  const previous = client.configurationKey;
  await writeFile(npmrc, "registry=https://elsewhere.example/");
  assert.notEqual(await configurationKey(client.configFiles, environment), previous);
});

test("conflicting internal scope is denied before any network or installation request", async (t) => {
  let requests = 0;
  const server = createServer((_req, res) => {
    requests++;
    res.end("{}");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise<void>((done) => server.close(() => done())));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  const root = await mkdtemp(join(tmpdir(), "teams-scope-conflict-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const user = join(root, "user");
  const global = join(root, "global");
  await writeFile(user, `@zuehlkelabs:registry=${url}\n`);
  await writeFile(global, "");
  await assert.rejects(resolveRegistry({
    packageName: "@zuehlkelabs/teams-cli",
    registry: "https://internal.example/npm/",
    environment: { ...process.env, npm_config_userconfig: user, npm_config_globalconfig: global, npm_config_cache: join(root, "cache") },
  }), /conflicts/);
  assert.equal(requests, 0);
});

test("pinned internal registry is used when a scope is not configured; malformed URLs are denied", async () => {
  const calls: string[][] = [];
  const execute: NpmExecutor = async (_npm, args) => {
    calls.push([...args]);
    if (args[0] === "view") return '{"version":"1.0.0"}';
    return "undefined";
  };
  const client = await resolveRegistry({
    packageName: "@zuehlkelabs/teams-cli",
    registry: "https://internal.example/npm/",
    execute,
  });
  await client.manifest("latest");
  assert.ok(calls.at(-1)?.includes("--@zuehlkelabs:registry=https://internal.example/npm/"));
  await assert.rejects(resolveRegistry({ registry: "https://token@internal.example/", execute }), /credentials/);
});

test("internal authentication failure never falls back to the configured default registry", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "teams-no-fallback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let internalRequests = 0;
  let publicRequests = 0;
  const internal = createServer((_req, res) => {
    internalRequests++;
    res.writeHead(401, { "content-type": "application/json" });
    res.end('{"error":"secret-response-must-not-escape"}');
  });
  const publicServer = createServer((_req, res) => {
    publicRequests++;
    res.end("{}");
  });
  for (const server of [internal, publicServer]) {
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    t.after(() => new Promise<void>((done) => server.close(() => done())));
  }
  const endpoint = (server: typeof internal) => `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  const user = join(root, "user");
  const global = join(root, "global");
  await writeFile(user, `registry=${endpoint(publicServer)}\n`);
  await writeFile(global, "");
  const client = await resolveRegistry({
    packageName: "@zuehlkelabs/teams-cli",
    registry: endpoint(internal),
    environment: {
      ...process.env,
      npm_config_userconfig: user,
      npm_config_globalconfig: global,
      npm_config_cache: join(root, "cache"),
    },
  });
  await assert.rejects(client.manifest("latest"), (error: Error) => {
    assert.match(error.message, /npm operation failed/);
    assert.doesNotMatch(error.message, /secret-response/);
    return true;
  });
  assert.equal(internalRequests, 1);
  assert.equal(publicRequests, 0);
});
