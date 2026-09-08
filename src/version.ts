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
  teamsCli?: { distribution?: unknown };
};

export type Distribution = {
  schemaVersion: 1;
  registry: string;
  upstream: { name: string; version: string; integrity: string };
  transformationRevision: string;
};

export function parseDistribution(value: unknown): Distribution | undefined {
  if (value === undefined) return undefined;
  const d = value as Distribution;
  if (
    !d ||
    d.schemaVersion !== 1 ||
    typeof d.registry !== "string" ||
    !d.upstream ||
    typeof d.upstream.name !== "string" ||
    typeof d.upstream.version !== "string" ||
    typeof d.upstream.integrity !== "string" ||
    typeof d.transformationRevision !== "string"
  ) {
    throw new Error("Installed distribution metadata is invalid");
  }
  let registry: URL;
  try {
    registry = new URL(d.registry);
  } catch {
    throw new Error("Installed distribution registry is invalid");
  }
  if (
    registry.protocol !== "https:" ||
    registry.username ||
    registry.password ||
    registry.search ||
    registry.hash ||
    !/^@[a-z0-9._-]+\/[a-z0-9._-]+$/.test(d.upstream.name) ||
    !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(d.upstream.integrity)
  ) {
    throw new Error("Installed distribution metadata is invalid");
  }
  return { ...d, registry: `${registry.href.replace(/\/+$/, "")}/` };
}

const metadata = createRequire(import.meta.url)("../package.json") as PackageMetadata;

if (typeof metadata.name !== "string" || typeof metadata.version !== "string") {
  throw new Error("Installed package metadata is invalid");
}
const packageName = metadata.name;
const cliVersion = metadata.version;
function repositoryUrl(value: unknown): string {
  const raw = typeof value === "string"
    ? value
    : value && typeof value === "object" && typeof (value as { url?: unknown }).url === "string"
      ? (value as { url: string }).url
      : undefined;
  if (!raw) throw new Error("Installed package repository metadata is invalid");
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
export const DISTRIBUTION = parseDistribution(metadata.teamsCli?.distribution);
export const CLI_VERSION = cliVersion;
export const PACKAGE_REPOSITORY_URL = repositoryUrl(metadata.repository);
export const BUILD_INFO = loadBuildInfo();
