import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";
import type { UpdateChannel } from "./settings.js";
import { PACKAGE_NAME, type BuildChannel } from "./version.js";

export const UPDATE_INTERVAL_MS = 60 * 60 * 1000;
const UPDATE_TIMEOUT_MS = 3_000;

export type ReleaseSummary = { title: string; summary?: string; url?: string };
export type UpdateCandidate = { version: string; summary?: ReleaseSummary };

export type UpdateState = {
  version: 2;
  channel: UpdateChannel;
  checkedAt: string;
  latestVersion?: string;
  pendingVersion?: string;
  pendingSummary?: ReleaseSummary;
};

type RegistryManifest = {
  version?: unknown;
  teamsCli?: { releaseSummary?: unknown };
};

export function updateStateFile(storageRoot = join(homedir(), ".teams-cli")): string {
  return join(storageRoot, "update-check.json");
}

export function isNpxExecution(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.npm_command === "exec" || environment.npm_lifecycle_event === "npx";
}

export function updateChecksDisabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  const enabled = (value: string | undefined) => value === "1" || value?.toLowerCase() === "true";
  return enabled(environment.NO_UPDATE_NOTIFIER) || enabled(environment.TEAMS_CLI_DISABLE_UPDATE_CHECK) ||
    enabled(environment.CI) || enabled(environment.TEAMS_CLI_UPDATE_WORKER) || isNpxExecution(environment);
}

function parseReleaseSummary(value: unknown): ReleaseSummary | undefined {
  if (!value || typeof value !== "object") return undefined;
  const summary = value as Record<string, unknown>;
  if (typeof summary.title !== "string") return undefined;
  return {
    title: summary.title,
    ...(typeof summary.summary === "string" && summary.summary ? { summary: summary.summary } : {}),
    ...(typeof summary.url === "string" && summary.url ? { url: summary.url } : {}),
  };
}

export async function loadUpdateState(file = updateStateFile()): Promise<UpdateState | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    const candidate = parsed as {
      version?: unknown;
      channel?: unknown;
      checkedAt?: unknown;
      latestVersion?: unknown;
      pendingVersion?: unknown;
      pendingSummary?: unknown;
    };
    if (typeof candidate.checkedAt !== "string") return null;
    if (candidate.latestVersion !== undefined && typeof candidate.latestVersion !== "string") return null;
    if (candidate.pendingVersion !== undefined && typeof candidate.pendingVersion !== "string") return null;
    if (candidate.version === 1) {
      return {
        version: 2,
        channel: "stable",
        checkedAt: candidate.checkedAt,
        ...(candidate.latestVersion ? { latestVersion: candidate.latestVersion } : {}),
        ...(candidate.pendingVersion ? { pendingVersion: candidate.pendingVersion } : {}),
      };
    }
    if (candidate.version !== 2 || (candidate.channel !== "stable" && candidate.channel !== "canary")) return null;
    const pendingSummary = parseReleaseSummary(candidate.pendingSummary);
    return { ...candidate, ...(pendingSummary ? { pendingSummary } : {}) } as UpdateState;
  } catch {
    return null;
  }
}

async function saveUpdateState(state: UpdateState, file: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await chmod(dirname(file), 0o700);
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
  await chmod(file, 0o600);
}

export function isNewerVersion(current: string, candidate: string): boolean {
  return Boolean(semver.valid(current) && semver.valid(candidate) && semver.gt(candidate, current));
}

async function registryManifest(tag: string, fetcher: typeof fetch): Promise<UpdateCandidate | null> {
  const response = await fetcher(`https://registry.npmjs.org/${encodeURIComponent(PACKAGE_NAME)}/${tag}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(UPDATE_TIMEOUT_MS),
  });
  if (response.status === 404 && tag === "canary") return null;
  if (!response.ok) throw new Error(`npm registry returned ${response.status}`);
  const manifest = await response.json() as RegistryManifest;
  if (typeof manifest.version !== "string" || !semver.valid(manifest.version)) {
    throw new Error("npm registry returned no valid version");
  }
  const summary = parseReleaseSummary(manifest.teamsCli?.releaseSummary);
  return { version: manifest.version, ...(summary ? { summary } : {}) };
}

export async function latestForChannel(channel: UpdateChannel, fetcher: typeof fetch = fetch): Promise<UpdateCandidate> {
  const stablePromise = registryManifest("latest", fetcher);
  if (channel === "stable") {
    const stable = await stablePromise;
    if (!stable) throw new Error("npm registry has no stable release");
    return stable;
  }
  const [stable, canary] = await Promise.all([stablePromise, registryManifest("canary", fetcher)]);
  if (!stable && !canary) throw new Error("npm registry has no release for the canary channel");
  if (!stable) return canary as UpdateCandidate;
  if (!canary) return stable;
  return semver.gt(canary.version, stable.version) ? canary : stable;
}

export async function checkForUpdate(
  currentVersion: string,
  channel: UpdateChannel,
  fetcher: typeof fetch = fetch,
): Promise<UpdateCandidate | null> {
  const candidate = await latestForChannel(channel, fetcher);
  return isNewerVersion(currentVersion, candidate.version) ? candidate : null;
}

export async function runUpdateWorker(
  currentVersion: string,
  file = updateStateFile(),
  fetcher: typeof fetch = fetch,
  now = new Date(),
  channel: UpdateChannel = "stable",
): Promise<void> {
  const next: UpdateState = { version: 2, channel, checkedAt: now.toISOString() };
  try {
    const candidate = await latestForChannel(channel, fetcher);
    next.latestVersion = candidate.version;
    if (isNewerVersion(currentVersion, candidate.version)) {
      next.pendingVersion = candidate.version;
      if (candidate.summary) next.pendingSummary = candidate.summary;
    }
  } catch {
    // Update checks are advisory and must never make a CLI command fail.
  }
  await saveUpdateState(next, file);
}

export async function prepareUpdateNotification(options: {
  currentVersion: string;
  channel?: UpdateChannel;
  installedChannel?: BuildChannel;
  stateFile?: string;
  environment?: NodeJS.ProcessEnv;
  now?: Date;
  stderr?: Pick<NodeJS.WriteStream, "write">;
  spawnWorker?: (file: string, channel: UpdateChannel) => void;
}): Promise<void> {
  const environment = options.environment ?? process.env;
  if (options.installedChannel === "snapshot" || updateChecksDisabled(environment)) return;
  const channel = options.channel ?? "stable";
  const file = options.stateFile ?? updateStateFile();
  const state = await loadUpdateState(file);
  if (state && state.channel === channel && state.pendingVersion && isNewerVersion(options.currentVersion, state.pendingVersion)) {
    const description = state.pendingSummary?.title ? ` ${state.pendingSummary.title}.` : "";
    (options.stderr ?? process.stderr).write(
      `A new teams-cli ${channel} version is available: ${options.currentVersion} → ${state.pendingVersion}.${description} ` +
      `Upgrade ${PACKAGE_NAME} with your package manager in the same installation scope.\n`,
    );
    const consumed = { ...state };
    delete consumed.pendingVersion;
    delete consumed.pendingSummary;
    try {
      await saveUpdateState(consumed, file);
    } catch {
      // A read-only or damaged cache must not prevent the requested CLI command.
    }
  }
  const now = options.now ?? new Date();
  const checkedAt = state?.channel === channel ? Date.parse(state.checkedAt) : Number.NaN;
  if (Number.isFinite(checkedAt) && now.getTime() - checkedAt < UPDATE_INTERVAL_MS) return;
  if (options.spawnWorker) {
    options.spawnWorker(file, channel);
    return;
  }
  const entrypoint = fileURLToPath(new URL("./cli.js", import.meta.url));
  const child = spawn(process.execPath, [entrypoint, "--internal-update-check", options.currentVersion, file, channel], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...environment, TEAMS_CLI_UPDATE_WORKER: "1" },
  });
  child.on("error", () => undefined);
  child.unref();
}
