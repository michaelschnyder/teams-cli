import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

export type BuildChannel = "stable" | "canary" | "snapshot" | "local";

export type ReleaseNotes = {
  title: string;
  body: string;
  url?: string;
};

export type BuildInfo = {
  schemaVersion: 1;
  version: string;
  channel: BuildChannel;
  builtAt?: string;
  source?: {
    branch?: string;
    commit?: string;
    commitUrl?: string;
    pullRequest?: number;
    pullRequestUrl?: string;
    author?: string;
  };
  trigger?: {
    kind: "release" | "merged-pull-request" | "manual-snapshot" | "local";
    actor?: string;
  };
  runner?: {
    name?: string;
    os?: string;
    architecture?: string;
  };
  workflow?: {
    runId?: string;
    runNumber?: string;
    runAttempt?: string;
    url?: string;
  };
  releaseNotes?: ReleaseNotes;
};

type PackageMetadata = {
  name?: unknown;
  version?: unknown;
  repository?: unknown;
};

const metadata = createRequire(import.meta.url)("../package.json") as PackageMetadata;

if (typeof metadata.name !== "string" || typeof metadata.version !== "string") {
  throw new Error("Installed package metadata is invalid");
}
const packageName = metadata.name;
const cliVersion = metadata.version;
const defaultRepositoryUrl = `https://github.com/${packageName.startsWith("@") ? packageName.slice(1) : packageName}`;

function repositoryUrl(value: unknown): string {
  const raw = typeof value === "string"
    ? value
    : value && typeof value === "object" && typeof (value as { url?: unknown }).url === "string"
      ? (value as { url: string }).url
      : defaultRepositoryUrl;
  return raw.replace(/^git\+/, "").replace(/\.git$/, "");
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function optionalStrings(value: unknown, fields: readonly string[]): boolean {
  const candidate = record(value);
  return Boolean(candidate && fields.every((field) => candidate[field] === undefined || typeof candidate[field] === "string"));
}

export function parseBuildInfo(value: unknown, expectedVersion = cliVersion): BuildInfo | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.schemaVersion !== 1 || candidate.version !== expectedVersion) return null;
  if (!["stable", "canary", "snapshot", "local"].includes(String(candidate.channel))) return null;
  const trigger = record(candidate.trigger);
  if (!trigger || !["release", "merged-pull-request", "manual-snapshot", "local"].includes(String(trigger.kind)) ||
    (trigger.actor !== undefined && typeof trigger.actor !== "string")) return null;
  if (candidate.builtAt !== undefined && typeof candidate.builtAt !== "string") return null;
  if (candidate.source !== undefined) {
    if (!optionalStrings(candidate.source, ["branch", "commit", "commitUrl", "pullRequestUrl", "author"])) return null;
    const source = candidate.source as Record<string, unknown>;
    if (source.pullRequest !== undefined && (!Number.isInteger(source.pullRequest) || Number(source.pullRequest) < 1)) return null;
  }
  if (candidate.runner !== undefined && !optionalStrings(candidate.runner, ["name", "os", "architecture"])) return null;
  if (candidate.workflow !== undefined && !optionalStrings(candidate.workflow, ["runId", "runNumber", "runAttempt", "url"])) return null;
  if (candidate.releaseNotes !== undefined) {
    const notes = record(candidate.releaseNotes);
    if (!notes || typeof notes.title !== "string" || typeof notes.body !== "string" ||
      (notes.url !== undefined && typeof notes.url !== "string")) return null;
  }
  if (candidate.channel !== "local" &&
    (typeof candidate.builtAt !== "string" || !candidate.source || !candidate.runner || !candidate.workflow)) return null;
  return candidate as unknown as BuildInfo;
}

function loadBuildInfo(): BuildInfo {
  try {
    const parsed = parseBuildInfo(JSON.parse(readFileSync(new URL("./build-info.json", import.meta.url), "utf8")));
    if (parsed) return parsed;
  } catch {
    // Source checkouts do not contain generated build metadata.
  }
  const prerelease = cliVersion.match(/-(canary|snapshot)(?:\.|$)/)?.[1];
  return {
    schemaVersion: 1,
    version: cliVersion,
    channel: prerelease === "canary" || prerelease === "snapshot" ? prerelease : "local",
    trigger: { kind: "local" },
  };
}

export const PACKAGE_NAME = packageName;
export const CLI_VERSION = cliVersion;
export const PACKAGE_REPOSITORY_URL = repositoryUrl(metadata.repository);
export const BUILD_INFO = loadBuildInfo();
