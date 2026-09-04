import assert from "node:assert/strict";
import test from "node:test";
import semver from "semver";
import { nextPrereleaseBase, prereleaseVersion, snapshotTag } from "../scripts/prepare-publication.mjs";

test("infers the next patch unless package.json already targets a later release", () => {
  assert.equal(nextPrereleaseBase("0.1.0", "0.1.0"), "0.1.1");
  assert.equal(nextPrereleaseBase("0.2.0", "0.1.0"), "0.2.0");
  assert.equal(nextPrereleaseBase("1.0.0", "0.9.9"), "1.0.0");
  assert.throws(() => nextPrereleaseBase("0.2.0-canary.1", "0.1.0"), /stable semver/);
});

test("creates deterministic safe snapshot tags without branch collisions", () => {
  const tag = snapshotTag("feature/Useful Change");
  assert.match(tag, /^snapshot-feature-useful-change-[a-f0-9]{8}$/);
  assert.equal(snapshotTag("feature/Useful Change"), tag);
  assert.notEqual(snapshotTag("feature/useful-change"), tag);
  assert.ok(tag.length < 64);
});

test("creates unique valid prereleases from workflow, attempt, and commit metadata", () => {
  const canary = prereleaseVersion("0.2.0", "canary", "81", "1", "1234567890abcdef");
  assert.equal(canary, "0.2.0-canary.81.1.g12345678");
  assert.ok(semver.valid(canary));
  assert.notEqual(prereleaseVersion("0.2.0", "canary", "81", "2", "1234567890abcdef"), canary);
  assert.notEqual(prereleaseVersion("0.2.0", "canary", "82", "1", "1234567890abcdef"), canary);
  assert.notEqual(prereleaseVersion("0.2.0", "snapshot", "81", "1", "abcdef1234567890"), canary);
  assert.throws(() => prereleaseVersion("0.2.0", "canary", "0", "1", "abcdef1234567890"), /positive integers/);
});
