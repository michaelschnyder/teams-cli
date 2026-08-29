import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PACKAGE_NAME } from "./version.js";

export const UPDATE_INTERVAL_MS = 60 * 60 * 1000;
const UPDATE_TIMEOUT_MS = 3_000;

export type UpdateState = {
  version: 1;
  checkedAt: string;
  latestVersion?: string;
  pendingVersion?: string;
};

export function updateStateFile(storageRoot = join(homedir(), ".teams-cli")): string {
  return join(storageRoot, "update-check.json");
}

export function updateChecksDisabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  const enabled = (value: string | undefined) => value === "1" || value?.toLowerCase() === "true";
  return enabled(environment.NO_UPDATE_NOTIFIER) || enabled(environment.TEAMS_CLI_DISABLE_UPDATE_CHECK) ||
    enabled(environment.CI) || enabled(environment.TEAMS_CLI_UPDATE_WORKER);
}

export async function loadUpdateState(file = updateStateFile()): Promise<UpdateState | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    const candidate = parsed as Partial<UpdateState>;
    if (candidate.version !== 1 || typeof candidate.checkedAt !== "string") return null;
    if (candidate.latestVersion !== undefined && typeof candidate.latestVersion !== "string") return null;
    if (candidate.pendingVersion !== undefined && typeof candidate.pendingVersion !== "string") return null;
    return candidate as UpdateState;
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

type ParsedVersion = { core: [number, number, number]; prerelease: string | null };

export function parseVersion(value: string): ParsedVersion | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value);
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ?? null,
  };
}

export function isNewerVersion(current: string, candidate: string): boolean {
  const left = parseVersion(current);
  const right = parseVersion(candidate);
  if (!left || !right) return false;
  if (right.prerelease && !left.prerelease) return false;
  for (let index = 0; index < left.core.length; index += 1) {
    const currentPart = left.core[index] ?? 0;
    const candidatePart = right.core[index] ?? 0;
    if (candidatePart !== currentPart) return candidatePart > currentPart;
  }
  if (left.prerelease && !right.prerelease) return true;
  return Boolean(left.prerelease && right.prerelease && right.prerelease !== left.prerelease &&
    right.prerelease.localeCompare(left.prerelease, undefined, { numeric: true }) > 0);
}

export async function runUpdateWorker(
  currentVersion: string,
  file = updateStateFile(),
  fetcher: typeof fetch = fetch,
  now = new Date(),
): Promise<void> {
  const previous = await loadUpdateState(file);
  const next: UpdateState = {
    version: 1,
    checkedAt: now.toISOString(),
    ...(previous?.latestVersion ? { latestVersion: previous.latestVersion } : {}),
    ...(previous?.pendingVersion ? { pendingVersion: previous.pendingVersion } : {}),
  };
  try {
    const encodedName = encodeURIComponent(PACKAGE_NAME);
    const response = await fetcher(`https://registry.npmjs.org/${encodedName}/latest`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(UPDATE_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`npm registry returned ${response.status}`);
    const payload: unknown = await response.json();
    const latest = payload && typeof payload === "object" ? (payload as { version?: unknown }).version : undefined;
    if (typeof latest !== "string") throw new Error("npm registry returned no version");
    next.latestVersion = latest;
    if (isNewerVersion(currentVersion, latest)) next.pendingVersion = latest;
    else delete next.pendingVersion;
  } catch {
    // Update checks are advisory and must never make a CLI command fail.
  }
  await saveUpdateState(next, file);
}

export async function prepareUpdateNotification(options: {
  currentVersion: string;
  stateFile?: string;
  environment?: NodeJS.ProcessEnv;
  now?: Date;
  stderr?: Pick<NodeJS.WriteStream, "write">;
  spawnWorker?: (file: string) => void;
}): Promise<void> {
  const environment = options.environment ?? process.env;
  if (updateChecksDisabled(environment)) return;
  const file = options.stateFile ?? updateStateFile();
  const state = await loadUpdateState(file);
  if (state?.pendingVersion && isNewerVersion(options.currentVersion, state.pendingVersion)) {
    (options.stderr ?? process.stderr).write(
      `A new teams-cli version is available: ${options.currentVersion} → ${state.pendingVersion}. ` +
      "Run `teams-cli version --upgrade`.\n",
    );
    const consumed = { ...state };
    delete consumed.pendingVersion;
    try {
      await saveUpdateState(consumed, file);
    } catch {
      // A read-only or damaged cache must not prevent the requested CLI command.
    }
  }
  const now = options.now ?? new Date();
  const checkedAt = state ? Date.parse(state.checkedAt) : Number.NaN;
  if (Number.isFinite(checkedAt) && now.getTime() - checkedAt < UPDATE_INTERVAL_MS) return;
  if (options.spawnWorker) {
    options.spawnWorker(file);
    return;
  }
  const entrypoint = fileURLToPath(new URL("./cli.js", import.meta.url));
  const child = spawn(process.execPath, [entrypoint, "--internal-update-check", options.currentVersion, file], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...environment, TEAMS_CLI_UPDATE_WORKER: "1" },
  });
  child.on("error", () => undefined);
  child.unref();
}
