import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { stringify } from "yaml";
import type { StoragePaths } from "./storage.js";
import type { BuildChannel } from "./version.js";
import { parseStrictYaml, rejectUnknownKeys, requireObject } from "./yaml.js";

export type UpdateChannel = "stable" | "canary";

export type Settings = {
  version: 1;
  updateChannel?: UpdateChannel;
};

export function parseUpdateChannel(value: unknown, field = "Update channel"): UpdateChannel | undefined {
  if (value === undefined) return undefined;
  if (value !== "stable" && value !== "canary") throw new Error(`${field} must be stable or canary`);
  return value;
}

export function parseSettings(value: unknown): Settings {
  const root = requireObject(value, "Settings");
  rejectUnknownKeys(root, ["version", "updateChannel"], "Settings");
  if (root.version !== 1) throw new Error("Settings version must be 1");
  const updateChannel = parseUpdateChannel(root.updateChannel, "settings.updateChannel");
  return { version: 1, ...(updateChannel ? { updateChannel } : {}) };
}

export async function loadSettings(paths: StoragePaths): Promise<Settings> {
  try {
    return parseSettings(parseStrictYaml(await readFile(paths.settingsFile, "utf8"), paths.settingsFile));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1 };
    throw error;
  }
}

export async function saveUpdateChannel(paths: StoragePaths, updateChannel: UpdateChannel): Promise<void> {
  const settings: Settings = { ...await loadSettings(paths), version: 1, updateChannel };
  await mkdir(dirname(paths.settingsFile), { recursive: true, mode: 0o700 });
  await chmod(dirname(paths.settingsFile), 0o700);
  const temporary = `${paths.settingsFile}.${randomUUID()}.tmp`;
  await writeFile(temporary, stringify(settings), { mode: 0o600 });
  await rename(temporary, paths.settingsFile);
  await chmod(paths.settingsFile, 0o600);
}

export async function resolveUpdateChannel(options: {
  paths: StoragePaths;
  explicit?: UpdateChannel;
  environment?: NodeJS.ProcessEnv;
  installedChannel?: BuildChannel;
}): Promise<UpdateChannel> {
  if (options.explicit) return options.explicit;
  const environment = options.environment ?? process.env;
  const fromEnvironment = parseUpdateChannel(environment.TEAMS_CLI_UPDATE_CHANNEL, "TEAMS_CLI_UPDATE_CHANNEL");
  if (fromEnvironment) return fromEnvironment;
  const configured = (await loadSettings(options.paths)).updateChannel;
  if (configured) return configured;
  return options.installedChannel === "canary" ? "canary" : "stable";
}
