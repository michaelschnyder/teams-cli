import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";

export function nextPrereleaseBase(packageVersion, latestVersion) {
  if (!semver.valid(packageVersion) || semver.prerelease(packageVersion)) {
    throw new Error(`package.json version must be stable semver, received ${packageVersion}`);
  }
  if (!semver.valid(latestVersion) || semver.prerelease(latestVersion)) {
    throw new Error(`npm latest version must be stable semver, received ${latestVersion}`);
  }
  return semver.gt(packageVersion, latestVersion) ? packageVersion : semver.inc(latestVersion, "patch");
}

export function snapshotTag(branch) {
  const slug = branch.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 38) || "branch";
  const digest = createHash("sha256").update(branch).digest("hex").slice(0, 8);
  return `snapshot-${slug}-${digest}`;
}

export function prereleaseVersion(base, mode, runNumber, runAttempt, commit) {
  if (!semver.valid(base) || semver.prerelease(base)) throw new Error(`Prerelease base must be stable semver, received ${base}`);
  if (mode !== "canary" && mode !== "snapshot") throw new Error(`Prerelease mode must be canary or snapshot, received ${mode}`);
  if (!/^[1-9]\d*$/.test(String(runNumber)) || !/^[1-9]\d*$/.test(String(runAttempt))) {
    throw new Error("GitHub run number and attempt must be positive integers");
  }
  if (!/^[a-f\d]{7,}$/i.test(commit)) throw new Error("Commit must be a Git object ID");
  return `${base}-${mode}.${runNumber}.${runAttempt}.g${commit.slice(0, 8).toLowerCase()}`;
}

function cleanText(value, maximum = Number.POSITIVE_INFINITY) {
  return String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, maximum);
}

function shortSummary(body) {
  return cleanText(body).split(/\n\s*\n/, 1)[0]?.replace(/\s+/g, " ").trim().slice(0, 500) ?? "";
}

async function github(path) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is required");
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response.ok) throw new Error(`GitHub API returned ${response.status} for ${path}`);
  return response.json();
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

async function latestStable(name) {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`npm registry returned ${response.status}`);
  const value = await response.json();
  if (typeof value.version !== "string") throw new Error("npm registry returned no latest version");
  return value.version;
}

function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  else process.stdout.write(`${name}=${value}\n`);
}

async function main() {
  const mode = process.argv[2];
  if (!new Set(["stable", "canary", "snapshot"]).has(mode)) throw new Error("Expected stable, canary, or snapshot mode");
  const root = process.cwd();
  const packageFile = join(root, "package.json");
  const packageMetadata = JSON.parse(readFileSync(packageFile, "utf8"));
  const event = process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")) : {};
  const repository = process.env.GITHUB_REPOSITORY ?? "michaelschnyder/teams-cli";
  const repositoryUrl = `https://github.com/${repository}`;
  const runId = process.env.GITHUB_RUN_ID ?? "0";
  const runNumber = process.env.GITHUB_RUN_NUMBER ?? "0";
  const runAttempt = process.env.GITHUB_RUN_ATTEMPT ?? "1";
  const actor = process.env.GITHUB_ACTOR ?? "unknown";
  let version = packageMetadata.version;
  let tag = "latest";
  let branch = process.env.GITHUB_REF_NAME ?? git("rev-parse", "--abbrev-ref", "HEAD");
  let commit = process.env.GITHUB_SHA ?? git("rev-parse", "HEAD");
  let author = cleanText(git("show", "-s", "--format=%an <%ae>", commit), 300);
  let triggerKind = "release";
  let releaseNotes;
  let associatedPullRequest;

  if (mode === "stable") {
    const release = event.release;
    const tagName = release?.tag_name ?? process.env.GITHUB_REF_NAME;
    if (tagName !== `v${version}`) throw new Error(`Release tag must equal v${version}`);
    branch = release?.target_commitish ?? branch;
    releaseNotes = release ? {
      title: cleanText(release.name || release.tag_name, 300),
      body: cleanText(release.body),
      url: release.html_url,
    } : undefined;
  } else {
    const base = nextPrereleaseBase(packageMetadata.version, await latestStable(packageMetadata.name));
    if (mode === "canary") {
      const pull = event.pull_request;
      if (!pull?.merged || !pull.merge_commit_sha) throw new Error("Canaries require a merged pull request event");
      commit = pull.merge_commit_sha;
      branch = pull.head.ref;
      author = pull.user?.login ?? author;
      associatedPullRequest = pull;
      triggerKind = "merged-pull-request";
      tag = "canary";
      releaseNotes = {
        title: cleanText(pull.title, 300),
        body: cleanText(pull.body),
        url: pull.html_url,
      };
    } else {
      if (process.env.GITHUB_REF_TYPE && process.env.GITHUB_REF_TYPE !== "branch") {
        throw new Error("Snapshots can only be published from repository branches");
      }
      const permission = await github(`/repos/${repository}/collaborators/${encodeURIComponent(actor)}/permission`);
      if (!["admin", "maintain", "write"].includes(permission.permission)) {
        throw new Error(`${actor} does not have permission to publish snapshots`);
      }
      triggerKind = "manual-snapshot";
      tag = snapshotTag(branch);
      const owner = repository.split("/")[0];
      const pulls = await github(`/repos/${repository}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`);
      const pull = Array.isArray(pulls) ? pulls[0] : undefined;
      associatedPullRequest = pull;
      releaseNotes = pull ? {
        title: cleanText(pull.title, 300),
        body: cleanText(pull.body),
        url: pull.html_url,
      } : {
        title: cleanText(git("show", "-s", "--format=%s", commit), 300),
        body: cleanText(process.env.SNAPSHOT_NOTES || git("show", "-s", "--format=%b", commit)),
        url: `${repositoryUrl}/commit/${commit}`,
      };
    }
    version = prereleaseVersion(base, mode, runNumber, runAttempt, commit);
  }

  const pullRequest = associatedPullRequest?.number ?? undefined;
  const buildInfo = {
    schemaVersion: 1,
    version,
    channel: mode,
    builtAt: new Date().toISOString(),
    source: {
      branch,
      commit,
      commitUrl: `${repositoryUrl}/commit/${commit}`,
      ...(pullRequest ? { pullRequest, pullRequestUrl: `${repositoryUrl}/pull/${pullRequest}` } : {}),
      author,
    },
    trigger: { kind: triggerKind, actor },
    runner: {
      name: process.env.RUNNER_NAME,
      os: process.env.RUNNER_OS,
      architecture: process.env.RUNNER_ARCH,
    },
    workflow: {
      runId,
      runNumber,
      runAttempt,
      url: `${repositoryUrl}/actions/runs/${runId}`,
    },
    ...(releaseNotes ? { releaseNotes } : {}),
  };
  const summary = releaseNotes ? {
    title: releaseNotes.title,
    summary: shortSummary(releaseNotes.body),
    ...(releaseNotes.url ? { url: releaseNotes.url } : {}),
  } : undefined;
  packageMetadata.version = version;
  packageMetadata.teamsCli = { channel: mode, ...(summary ? { releaseSummary: summary } : {}) };
  writeFileSync(packageFile, `${JSON.stringify(packageMetadata, null, 2)}\n`);
  const buildInfoFile = join(process.env.RUNNER_TEMP ?? root, `teams-cli-build-info-${runId}.json`);
  writeFileSync(buildInfoFile, `${JSON.stringify(buildInfo, null, 2)}\n`);
  if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, `TEAMS_CLI_BUILD_INFO_FILE=${buildInfoFile}\n`);
  setOutput("mode", mode);
  setOutput("version", version);
  setOutput("tag", tag);
  setOutput("install", `npm install --global ${packageMetadata.name}@${mode === "stable" ? "latest" : mode === "canary" ? "canary" : version}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
