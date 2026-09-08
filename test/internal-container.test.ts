import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join, delimiter } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
for (const fails of [false, true]) {
  test(
    `container smoke ${fails ? "cleans up failed preparation" : "runs CLI only without network"}`,
    { skip: process.platform === "win32" },
    async (t) => {
      const root = await mkdtemp(join(tmpdir(), "teams-docker-test-"));
      t.after(() => rm(root, { recursive: true, force: true }));
      const log = join(root, "calls.jsonl");
      await writeFile(
        join(root, "docker"),
        `#!${process.execPath}\nconst fs=require('node:fs');const a=process.argv.slice(2);fs.appendFileSync(process.env.TEST_DOCKER_LOG,JSON.stringify(a)+'\\n');if(a[0]==='start'){process.stdin.resume();process.stdin.on('end',()=>process.exit(process.env.TEST_DOCKER_FAIL==='1'?1:0));}else if(a[0]==='inspect')console.log('0');else if(a[0]==='commit')console.log('sha256:test-image');\n`,
        { mode: 0o755 },
      );
      const artifact = join(root, "input.tgz");
      await writeFile(artifact, "placeholder");
      const operation = execute(
        process.execPath,
        ["scripts/internal/smoke-container.mjs", artifact, "node:24-bookworm"],
        {
          env: {
            ...process.env,
            PATH: `${root}${delimiter}${process.env.PATH}`,
            TEST_DOCKER_LOG: log,
            TEST_DOCKER_FAIL: fails ? "1" : "0",
          },
        },
      );
      if (fails) await assert.rejects(operation);
      else await operation;
      const calls = (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      const prepare = calls.find((args) => args[0] === "create")!;
      assert.match(prepare.at(-1)!, /--ignore-scripts/);
      assert.doesNotMatch(prepare.at(-1)!, /node.*smoke\.mjs/);
      const run = calls.find((args) => args[0] === "run");
      if (fails) assert.equal(run, undefined);
      else {
        assert.ok(run?.includes("--network=none"));
        assert.ok(run?.includes("--installed"));
      }
      assert.ok(calls.some((args) => args[0] === "rm"));
      assert.ok(
        calls.every((args) => !args.includes("--privileged") && !args.includes("--volume") && !args.includes("--env")),
      );
    },
  );
}
