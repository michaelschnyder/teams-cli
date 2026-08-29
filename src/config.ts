import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { stringify } from "yaml";
import type { BrowserName } from "./oauth.js";
import type { StoragePaths } from "./storage.js";
import { parseStrictYaml, rejectUnknownKeys, requireObject } from "./yaml.js";

export type Profile = {
  tenantId?: string;
  userId?: string;
  username?: string;
  browser?: BrowserName;
};

export type ProfilesConfig = {
  version: 1;
  profiles: Record<string, Profile>;
};

export type RuntimeOverrides = {
  profile?: string;
  tenant?: string;
  user?: string;
  browser?: BrowserName;
};

export type RuntimeContext = {
  profileName: string;
  tenantId?: string;
  userId?: string;
  username?: string;
  browser: BrowserName;
};

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) throw new Error(`${field} must be a non-empty string`);
  return value;
}

function parseBrowser(value: unknown, field: string): BrowserName | undefined {
  if (value === undefined) return undefined;
  if (value !== "edge" && value !== "chrome") throw new Error(`${field} must be edge or chrome`);
  return value;
}

export function parseProfilesConfig(value: unknown): ProfilesConfig {
  const root = requireObject(value, "Profiles configuration");
  rejectUnknownKeys(root, ["version", "profiles"], "Profiles configuration");
  if (root.version !== 1) throw new Error("Profiles configuration version must be 1");
  const rawProfiles = requireObject(root.profiles, "profiles");
  const profiles: Record<string, Profile> = {};
  for (const [name, raw] of Object.entries(rawProfiles)) {
    if (!name.length) throw new Error("Profile names must not be empty");
    const profile = requireObject(raw, `Profile ${name}`);
    rejectUnknownKeys(profile, ["tenantId", "userId", "username", "browser"], `Profile ${name}`);
    const tenantId = optionalString(profile.tenantId, `Profile ${name}.tenantId`);
    const userId = optionalString(profile.userId, `Profile ${name}.userId`);
    const username = optionalString(profile.username, `Profile ${name}.username`);
    const browser = parseBrowser(profile.browser, `Profile ${name}.browser`);
    profiles[name] = {
      ...(tenantId ? { tenantId } : {}),
      ...(userId ? { userId } : {}),
      ...(username ? { username } : {}),
      ...(browser ? { browser } : {}),
    };
  }
  return { version: 1, profiles };
}

export async function loadProfiles(paths: StoragePaths): Promise<ProfilesConfig> {
  let raw: string;
  try {
    raw = await readFile(paths.configFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, profiles: {} };
    throw error;
  }
  return parseProfilesConfig(parseStrictYaml(raw, paths.configFile));
}

export async function saveProfiles(paths: StoragePaths, config: ProfilesConfig): Promise<void> {
  await mkdir(dirname(paths.configFile), { recursive: true, mode: 0o700 });
  await chmod(dirname(paths.configFile), 0o700);
  const temporary = `${paths.configFile}.${randomUUID()}.tmp`;
  await writeFile(temporary, stringify(config), { mode: 0o600 });
  await rename(temporary, paths.configFile);
  await chmod(paths.configFile, 0o600);
}

export async function resolveRuntimeContext(
  paths: StoragePaths,
  overrides: RuntimeOverrides,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<RuntimeContext> {
  const config = await loadProfiles(paths);
  const profileName = overrides.profile ?? environment.TEAMS_CLI_PROFILE ?? "default";
  const profile = config.profiles[profileName] ?? {};
  const browserValue = overrides.browser ?? environment.TEAMS_CLI_BROWSER ?? profile.browser ?? "edge";
  const browser = parseBrowser(browserValue, "Browser") ?? "edge";
  const tenantId = overrides.tenant ?? environment.TEAMS_CLI_TENANT ?? profile.tenantId;
  const userId = overrides.user ?? environment.TEAMS_CLI_USER ?? profile.userId;
  return {
    profileName,
    ...(tenantId ? { tenantId } : {}),
    ...(userId ? { userId } : {}),
    ...(profile.username ? { username: profile.username } : {}),
    browser,
  };
}

export function requireRuntimeIdentity(context: RuntimeContext): { tenantId: string; userId: string } {
  if (!context.tenantId || !context.userId) {
    throw new Error("Select a tenant and user with --tenant and --user, or configure a profile");
  }
  return { tenantId: context.tenantId, userId: context.userId };
}

export async function saveProfile(
  paths: StoragePaths,
  name: string,
  profile: Profile,
): Promise<void> {
  if (!name.length) throw new Error("Profile name must not be empty");
  const config = await loadProfiles(paths);
  config.profiles[name] = profile;
  await saveProfiles(paths, config);
}

export async function removeProfile(paths: StoragePaths, name: string): Promise<boolean> {
  const config = await loadProfiles(paths);
  if (!(name in config.profiles)) return false;
  delete config.profiles[name];
  if (Object.keys(config.profiles).length === 0) {
    await rm(paths.configFile, { force: true });
  } else {
    await saveProfiles(paths, config);
  }
  return true;
}
