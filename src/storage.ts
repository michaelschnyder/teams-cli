import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BrowserName } from "./oauth.js";

export type Identity = { tenantId: string; userId: string };
export type StoredToken = { value: string; expiresAt: string };

export type LegacyStoredSession = {
  version: 1 | 2;
  browser: BrowserName;
  tenantId: string;
  savedAt: string;
  accessToken: StoredToken;
  skypeToken: StoredToken;
  chatToken?: StoredToken;
  searchToken?: StoredToken;
  region?: string;
  endpoints?: { chatService?: string; chatServiceAggregator?: string; middleTier?: string };
};

export type StoredSession = {
  version: 3;
  browser: BrowserName;
  tenantId: string;
  userId: string;
  username?: string;
  savedAt: string;
  region: string;
  accessToken: StoredToken;
  skypeToken: StoredToken;
  chatToken: StoredToken;
  searchToken: StoredToken;
  endpoints: {
    chatService: string;
    chatServiceAggregator?: string;
    middleTier?: string;
  };
};

export type AnyStoredSession = LegacyStoredSession | StoredSession;

export type StoragePaths = {
  root: string;
  configFile: string;
  settingsFile: string;
  authDirectory: string;
  browserProfilesDirectory: string;
  browserStagingDirectory: string;
  policiesDirectory: string;
  sessionFile: (identity: Identity) => string;
  browserProfile: (identity: Identity, browser: BrowserName) => string;
  browserStagingProfile: (identifier: string, browser: BrowserName) => string;
};

export function identityKey(identity: Identity): string {
  return createHash("sha256")
    .update(identity.tenantId)
    .update("\0")
    .update(identity.userId)
    .digest("hex");
}

export function storagePaths(root = join(homedir(), ".teams-cli")): StoragePaths {
  const authDirectory = join(root, "auth");
  const browserProfilesDirectory = join(root, "browser-profiles");
  const browserStagingDirectory = join(browserProfilesDirectory, ".staging");
  return {
    root,
    configFile: join(root, "config.yaml"),
    settingsFile: join(root, "settings.yaml"),
    authDirectory,
    browserProfilesDirectory,
    browserStagingDirectory,
    policiesDirectory: join(root, "policies"),
    sessionFile: (identity) => join(authDirectory, `${identityKey(identity)}.json`),
    browserProfile: (identity, browser) => join(browserProfilesDirectory, identityKey(identity), browser),
    browserStagingProfile: (identifier, browser) => join(browserStagingDirectory, identifier, browser),
  };
}

async function preparePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

export async function prepareBrowserProfile(
  paths: StoragePaths,
  identity: Identity,
  browser: BrowserName,
): Promise<string> {
  await preparePrivateDirectory(paths.root);
  await preparePrivateDirectory(paths.browserProfilesDirectory);
  const profile = paths.browserProfile(identity, browser);
  await preparePrivateDirectory(profile);
  return profile;
}

export async function prepareStagingBrowserProfile(
  paths: StoragePaths,
  browser: BrowserName,
): Promise<{ identifier: string; directory: string }> {
  await preparePrivateDirectory(paths.root);
  await preparePrivateDirectory(paths.browserProfilesDirectory);
  await preparePrivateDirectory(paths.browserStagingDirectory);
  const identifier = randomUUID();
  const directory = paths.browserStagingProfile(identifier, browser);
  await preparePrivateDirectory(directory);
  return { identifier, directory };
}

export async function promoteStagingBrowserProfile(
  paths: StoragePaths,
  identifier: string,
  identity: Identity,
  browser: BrowserName,
): Promise<void> {
  const sourceRoot = join(paths.browserStagingDirectory, identifier);
  const source = paths.browserStagingProfile(identifier, browser);
  const destination = paths.browserProfile(identity, browser);
  const backup = `${destination}.backup-${randomUUID()}`;
  await preparePrivateDirectory(join(paths.browserProfilesDirectory, identityKey(identity)));
  let backedUp = false;
  try {
    try {
      await rename(destination, backup);
      backedUp = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await rename(source, destination);
    await chmod(destination, 0o700);
    if (backedUp) await rm(backup, { recursive: true, force: true });
    await rm(sourceRoot, { recursive: true, force: true });
  } catch (error) {
    if (backedUp) {
      await rm(destination, { recursive: true, force: true });
      await rename(backup, destination);
    }
    throw error;
  }
}

export async function discardStagingBrowserProfile(
  paths: StoragePaths,
  identifier: string,
): Promise<void> {
  await rm(join(paths.browserStagingDirectory, identifier), { recursive: true, force: true });
}

export async function saveSession(paths: StoragePaths, session: StoredSession): Promise<void> {
  await preparePrivateDirectory(paths.root);
  await preparePrivateDirectory(paths.authDirectory);
  const file = paths.sessionFile(session);
  const temporary = join(paths.authDirectory, `.session-${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
  await chmod(file, 0o600);
}

function isStoredToken(value: unknown): value is StoredToken {
  if (!value || typeof value !== "object") return false;
  const token = value as Partial<StoredToken>;
  return typeof token.value === "string" && typeof token.expiresAt === "string";
}

function isAnyStoredSession(value: unknown): value is AnyStoredSession {
  if (!value || typeof value !== "object") return false;
  const session = value as Partial<AnyStoredSession>;
  const common =
    (session.browser === "edge" || session.browser === "chrome") &&
    typeof session.tenantId === "string" &&
    typeof session.savedAt === "string" &&
    isStoredToken(session.accessToken) &&
    isStoredToken(session.skypeToken);
  if (!common) return false;
  if (session.version === 1 || session.version === 2) return true;
  if (session.version !== 3) return false;
  const current = session as Partial<StoredSession>;
  return typeof current.userId === "string" && current.userId.length > 0 &&
    typeof current.region === "string" &&
    isStoredToken(current.chatToken) &&
    isStoredToken(current.searchToken) &&
    typeof current.endpoints?.chatService === "string";
}

export async function loadSession(paths: StoragePaths, identity: Identity): Promise<StoredSession> {
  const file = paths.sessionFile(identity);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("Not logged in for the selected tenant and user. Run `teams-cli login`.");
    }
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!isAnyStoredSession(parsed)) throw new Error("Stored Teams session is invalid. Log in again.");
  if (parsed.tenantId !== identity.tenantId || parsed.version !== 3 || parsed.userId !== identity.userId) {
    throw new Error("Stored Teams session belongs to a different identity or is outdated. Log in again.");
  }
  return parsed;
}

export function requireCurrentSession(session: AnyStoredSession): StoredSession {
  if (session.version !== 3) {
    throw new Error("Stored Teams session is outdated. Run `teams-cli login` again.");
  }
  return session;
}

export async function clearAuthentication(paths: StoragePaths, identity: Identity): Promise<void> {
  await rm(paths.sessionFile(identity), { force: true });
  await rm(join(paths.browserProfilesDirectory, identityKey(identity)), { recursive: true, force: true });
}
