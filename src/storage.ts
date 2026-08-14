import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BrowserName } from "./oauth.js";

export type StoredToken = {
  value: string;
  expiresAt: string;
};

export type LegacyStoredSession = {
  version: 1;
  browser: BrowserName;
  tenantId: string;
  savedAt: string;
  accessToken: StoredToken;
  skypeToken: StoredToken;
};

export type StoredSession = {
  version: 2;
  browser: BrowserName;
  tenantId: string;
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
  authDirectory: string;
  sessionFile: string;
  browserProfilesDirectory: string;
  browserProfile: (browser: BrowserName) => string;
};

export function storagePaths(root = join(homedir(), ".teams-cli")): StoragePaths {
  const authDirectory = join(root, "auth");
  const browserProfilesDirectory = join(root, "browser-profiles");
  return {
    root,
    authDirectory,
    sessionFile: join(authDirectory, "session.json"),
    browserProfilesDirectory,
    browserProfile: (browser) => join(browserProfilesDirectory, browser),
  };
}

export async function prepareBrowserProfile(paths: StoragePaths, browser: BrowserName): Promise<string> {
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  await chmod(paths.root, 0o700);
  await mkdir(paths.browserProfilesDirectory, { recursive: true, mode: 0o700 });
  await chmod(paths.browserProfilesDirectory, 0o700);
  const profile = paths.browserProfile(browser);
  await mkdir(profile, { recursive: true, mode: 0o700 });
  await chmod(profile, 0o700);
  return profile;
}

export async function saveSession(paths: StoragePaths, session: StoredSession): Promise<void> {
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  await chmod(paths.root, 0o700);
  await mkdir(paths.authDirectory, { recursive: true, mode: 0o700 });
  await chmod(paths.authDirectory, 0o700);
  const temporary = join(paths.authDirectory, `.session-${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, paths.sessionFile);
  await chmod(paths.sessionFile, 0o600);
}

function isStoredToken(value: unknown): value is StoredToken {
  if (!value || typeof value !== "object") return false;
  const token = value as Partial<StoredToken>;
  return typeof token.value === "string" && typeof token.expiresAt === "string";
}

function isStoredSession(value: unknown): value is AnyStoredSession {
  if (!value || typeof value !== "object") return false;
  const session = value as Partial<AnyStoredSession>;
  const common =
    (session.browser === "edge" || session.browser === "chrome") &&
    typeof session.tenantId === "string" &&
    typeof session.savedAt === "string" &&
    isStoredToken(session.accessToken) &&
    isStoredToken(session.skypeToken);
  if (!common) return false;
  if (session.version === 1) return true;
  if (session.version !== 2) return false;
  const current = session as Partial<StoredSession>;
  return typeof current.region === "string" &&
    isStoredToken(current.chatToken) &&
    isStoredToken(current.searchToken) &&
    typeof current.endpoints?.chatService === "string";
}

export async function loadSession(paths: StoragePaths): Promise<AnyStoredSession> {
  let raw: string;
  try {
    raw = await readFile(paths.sessionFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("Not logged in. Run `teams-cli auth login`.");
    }
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!isStoredSession(parsed)) throw new Error("Stored Teams session is invalid. Log in again.");
  return parsed;
}

export function requireCurrentSession(session: AnyStoredSession): StoredSession {
  if (session.version !== 2) {
    throw new Error(
      "Stored Teams session is outdated. Run `teams-cli auth refresh all` to update it.",
    );
  }
  return session;
}

export async function clearAuthentication(paths: StoragePaths): Promise<void> {
  await rm(paths.sessionFile, { force: true });
  await rm(paths.browserProfilesDirectory, { recursive: true, force: true });
}
