import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";

test("shared GitLab pipeline gates writes to protected scheduled/manual main and serializes reconciliation", async () => {
  const config = parse(await readFile(new URL("../.gitlab-ci.yml", import.meta.url), "utf8"));
  const allowed = config.workflow.rules[0].if;
  assert.match(allowed, /CI_COMMIT_BRANCH == "main"/);
  assert.match(allowed, /CI_COMMIT_REF_PROTECTED == "true"/);
  assert.match(allowed, /CI_PIPELINE_SOURCE == "schedule"/);
  assert.match(allowed, /CI_PIPELINE_SOURCE == "web"/);
  assert.equal(config.workflow.rules[1].when, "never");
  assert.equal(config["internal-distribution"].resource_group, "teams-cli-internal-distribution");
  assert.equal(config["internal-distribution"].interruptible, false);
  assert.deepEqual(config["internal-distribution"].script, ["node scripts/internal/run.mjs"]);
});
