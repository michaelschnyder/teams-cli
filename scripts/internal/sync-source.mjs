import { PromotionError } from "./errors.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import semver from "semver";

const execute = promisify(execFile);
export async function git(args, { cwd, env = process.env } = {}) {
  try {
    return (
      await execute("git", args, {
        cwd,
        env: { ...env, GIT_TERMINAL_PROMPT: "0" },
        encoding: "utf8",
        timeout: 120000,
        maxBuffer: 8 * 1024 * 1024,
      })
    ).stdout.trim();
  } catch {
    throw new PromotionError("Git synchronization command failed");
  }
}
export function selectedRefs(output) {
  return new Map(
    output
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split(/\s+/))
      .filter(
        ([, ref]) =>
          ref === "refs/heads/main" ||
          (ref?.startsWith("refs/tags/v") &&
            semver.valid(ref.slice(11)) === ref.slice(11) &&
            !semver.prerelease(ref.slice(11))),
      )
      .map(([sha, ref]) => [ref, sha]),
  );
}
export async function syncSource({ upstream, destination, directory, env = process.env }) {
  // Remotes never contain credentials. Authentication is supplied through askpass.
  for (const remote of [upstream, destination]) {
    if (remote.startsWith("-") || /[\r\n]/.test(remote)) throw new PromotionError("Invalid Git remote");
    if (/^https?:/.test(remote)) {
      const u = new URL(remote);
      if (u.username || u.password) throw new PromotionError("Git remote contains credentials");
    }
  }
  await mkdir(directory, { recursive: true });
  await git(["init", "--bare", directory], { env });
  const options = { cwd: directory, env };
  await git(["fetch", "--no-tags", upstream, "refs/heads/main:refs/heads/main"], options);
  const wanted = selectedRefs(await git(["ls-remote", "--refs", upstream], options));
  if (!wanted.has("refs/heads/main")) throw new PromotionError("Upstream main is missing");
  // Fetch exact selected tags only; lightweight and annotated tags keep their object identities.
  const tags = [...wanted.keys()].filter((ref) => ref.startsWith("refs/tags/"));
  if (tags.length) await git(["fetch", "--no-tags", upstream, ...tags.map((ref) => `${ref}:${ref}`)], options);
  const fetchedMain = await git(["rev-parse", "refs/heads/main"], options);
  if (fetchedMain !== wanted.get("refs/heads/main"))
    throw new PromotionError("Upstream changed during source discovery; retry");
  const existing = selectedRefs(await git(["ls-remote", "--refs", destination], options));
  const changes = [];
  for (const [ref, sha] of wanted) {
    if ((await git(["rev-parse", ref], options)) !== sha) throw new PromotionError("Upstream tag changed during fetch");
    const previous = existing.get(ref);
    if (previous === sha) continue;
    if (previous) {
      if (ref.startsWith("refs/tags/")) throw new PromotionError("Internal release tag differs from upstream");
      await git(["fetch", "--no-tags", destination, `${ref}:refs/internal/main`], options);
      await git(["merge-base", "--is-ancestor", previous, sha], options);
    }
    changes.push(`${ref}:${ref}`);
  }
  if (changes.length) await git(["push", "--atomic", destination, ...changes], options);
  const actual = selectedRefs(await git(["ls-remote", "--refs", destination], options));
  for (const [ref, sha] of wanted)
    if (actual.get(ref) !== sha) throw new PromotionError("Internal source verification failed");
  return { directory, refs: wanted, changed: changes.length > 0 };
}
export async function askpass(directory) {
  const file = join(directory, "git-askpass.sh");
  await writeFile(
    file,
    '#!/bin/sh\ncase "$1" in *"$SYNC_HOST"*) ;; *) exit 1 ;; esac\ncase "$1" in\n  *Username*) printf "%s\\n" "oauth2" ;;\n  *) printf "%s\\n" "$SYNC_TOKEN" ;;\nesac\n',
    { mode: 0o700 },
  );
  return file;
}
