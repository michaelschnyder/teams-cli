import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { git, syncSource } from "../scripts/internal/sync-source.mjs";

test("explicit synchronization imports main and stable tags, advances safely, and preserves unrelated refs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "teams-sync-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const upstream = join(root, "upstream");
  const destination = join(root, "internal.git");
  await git(["init", "-b", "main", upstream]);
  await git(["init", "--bare", destination]);
  const options = { cwd: upstream };
  await git(["config", "user.email", "tests@example.com"], options);
  await git(["config", "user.name", "Test"], options);
  const commit = async (text: string) => {
    await writeFile(join(upstream, "source"), text);
    await git(["add", "source"], options);
    await git(["commit", "-m", text], options);
  };
  await commit("first");
  await git(["tag", "-a", "v1.0.0", "-m", "release"], options);
  await git(["tag", "v1.1.0-canary.1"], options);
  await git(["branch", "feature"], options);
  let run = 0;
  const sync = () => syncSource({ upstream, destination, directory: join(root, `run-${run++}`) });
  await sync();
  let refs = await git(["show-ref"], { cwd: destination });
  assert.match(refs, /refs\/heads\/main/);
  assert.match(refs, /refs\/tags\/v1.0.0/);
  assert.doesNotMatch(refs, /canary|feature/);
  await git(["branch", "internal-only", "main"], { cwd: destination });
  assert.equal((await sync()).changed, false);
  await commit("second");
  await git(["tag", "v1.1.0"], options);
  await sync();
  refs = await git(["show-ref"], { cwd: destination });
  assert.match(refs, /internal-only/);
  assert.match(refs, /v1.1.0/);
  const before = refs;
  await git(["tag", "-f", "v1.0.0"], options);
  await assert.rejects(sync(), /tag differs/);
  assert.equal(await git(["show-ref"], { cwd: destination }), before);
});

test("divergent internal main is rejected without changing refs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "teams-diverged-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const upstream = join(root, "up");
  const destination = join(root, "down");
  for (const dir of [upstream, destination]) {
    await git(["init", "-b", "main", dir]);
    await git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", dir], {
      cwd: dir,
    });
  }
  const before = await git(["rev-parse", "main"], { cwd: destination });
  await assert.rejects(syncSource({ upstream, destination, directory: join(root, "sync") }));
  assert.equal(await git(["rev-parse", "main"], { cwd: destination }), before);
});
