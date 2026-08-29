import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  matchesGlob,
  parse,
  resolve,
} from "node:path";
import { stringify } from "yaml";
import type { RuntimeContext } from "./config.js";
import type { StoragePaths } from "./storage.js";
import { parseStrictYaml, rejectUnknownKeys, requireObject } from "./yaml.js";

export type MessageTarget = { kind: "chat" | "channel"; id: string };

export type Policy = {
  version: 2;
  name: string;
  active: boolean;
  subject: { paths: string[] };
  identity?: { tenantId?: string; userId?: string };
  allow?: {
    messageSend?: { chats: string[]; channels: string[] };
    rawTokenExport?: boolean;
  };
};

export type PolicyRecord = {
  file: string;
  policy: Policy;
  canonicalSubjectPatterns: string[];
  permissionWarnings: string[];
};

export type ResolvedPolicies = {
  subjectPath: string;
  policies: PolicyRecord[];
};

const POLICY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.length > 0)) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function validatePolicyName(name: string): string {
  if (!POLICY_NAME.test(name)) {
    throw new Error("Policy name must use 1-64 letters, numbers, dots, underscores, or hyphens");
  }
  return name;
}

function validateSubjectPaths(value: unknown): string[] {
  const paths = stringArray(value, "Policy.subject.paths");
  if (paths.length === 0) throw new Error("Policy.subject.paths must contain at least one path glob");
  for (const pattern of paths) {
    if (!isAbsolute(pattern)) throw new Error(`Policy subject path must be absolute: ${pattern}`);
    try {
      matchesGlob(resolve(pattern), pattern);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid policy subject path glob ${pattern}: ${detail}`);
    }
  }
  return paths;
}

export function parsePolicy(value: unknown): Policy {
  const root = requireObject(value, "Policy");
  rejectUnknownKeys(root, ["version", "name", "active", "subject", "identity", "allow"], "Policy");
  if (root.version !== 2) throw new Error("Policy version must be 2");
  if (typeof root.name !== "string") throw new Error("Policy.name must be a string");
  const name = validatePolicyName(root.name);
  if (typeof root.active !== "boolean") throw new Error("Policy.active must be a boolean");

  const rawSubject = requireObject(root.subject, "Policy.subject");
  rejectUnknownKeys(rawSubject, ["paths"], "Policy.subject");
  const subject = { paths: validateSubjectPaths(rawSubject.paths) };

  let identity: Policy["identity"];
  if (root.identity !== undefined) {
    const raw = requireObject(root.identity, "Policy.identity");
    rejectUnknownKeys(raw, ["tenantId", "userId"], "Policy.identity");
    const tenantId = optionalString(raw.tenantId, "Policy.identity.tenantId");
    const userId = optionalString(raw.userId, "Policy.identity.userId");
    identity = { ...(tenantId ? { tenantId } : {}), ...(userId ? { userId } : {}) };
  }

  let allow: Policy["allow"];
  if (root.allow !== undefined) {
    const raw = requireObject(root.allow, "Policy.allow");
    rejectUnknownKeys(raw, ["messageSend", "rawTokenExport"], "Policy.allow");
    let messageSend: { chats: string[]; channels: string[] } | undefined;
    if (raw.messageSend !== undefined) {
      const message = requireObject(raw.messageSend, "Policy.allow.messageSend");
      rejectUnknownKeys(message, ["chats", "channels"], "Policy.allow.messageSend");
      messageSend = {
        chats: stringArray(message.chats, "Policy.allow.messageSend.chats"),
        channels: stringArray(message.channels, "Policy.allow.messageSend.channels"),
      };
    }
    if (raw.rawTokenExport !== undefined && typeof raw.rawTokenExport !== "boolean") {
      throw new Error("Policy.allow.rawTokenExport must be a boolean");
    }
    allow = {
      ...(messageSend ? { messageSend } : {}),
      ...(typeof raw.rawTokenExport === "boolean" ? { rawTokenExport: raw.rawTokenExport } : {}),
    };
  }

  return {
    version: 2,
    name,
    active: root.active,
    subject,
    ...(identity ? { identity } : {}),
    ...(allow ? { allow } : {}),
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function canonicalSubjectPath(start = process.cwd()): Promise<string> {
  return realpath(resolve(start));
}

export function policyFile(paths: StoragePaths, name: string): string {
  return join(paths.policiesDirectory, `${validatePolicyName(name)}.yaml`);
}

function containsGlob(value: string): boolean {
  return /[*?\[\]{}()!]/.test(value);
}

async function canonicalSubjectPattern(pattern: string): Promise<string> {
  const root = parse(pattern).root;
  const segments = pattern.slice(root.length).split(process.platform === "win32" ? /[\\/]/ : "/");
  const firstGlob = segments.findIndex(containsGlob);
  if (firstGlob === -1) {
    try {
      return await realpath(pattern);
    } catch {
      return resolve(pattern);
    }
  }
  const prefix = join(root, ...segments.slice(0, firstGlob));
  const suffix = segments.slice(firstGlob);
  let canonicalPrefix: string;
  try {
    canonicalPrefix = await realpath(prefix);
  } catch {
    canonicalPrefix = resolve(prefix);
  }
  return suffix.length > 0 ? join(canonicalPrefix, ...suffix) : canonicalPrefix;
}

function ownerCanWrite(fileStats: Stats): boolean {
  const getuid = process.getuid;
  return process.platform !== "win32" && typeof getuid === "function" &&
    fileStats.uid === getuid() && (fileStats.mode & 0o200) !== 0;
}

async function loadPolicyFile(file: string, filename: string): Promise<PolicyRecord> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    throw new Error(`Policy denied operation: cannot read ${file}`);
  }

  let policy: Policy;
  try {
    policy = parsePolicy(parseStrictYaml(raw, file));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Policy denied operation: ${detail}`);
  }
  if (filename !== `${policy.name}.yaml`) {
    throw new Error(`Policy denied operation: ${file} does not match policy name ${policy.name}`);
  }

  const permissionWarnings: string[] = [];
  if (policy.active && process.platform !== "win32") {
    let fileStats;
    try {
      fileStats = await stat(file);
    } catch {
      throw new Error(`Policy denied operation: cannot inspect permissions for ${file}`);
    }
    if ((fileStats.mode & 0o022) !== 0) {
      throw new Error(`Policy denied operation: active policy ${file} is writable by group or other users`);
    }
    if (ownerCanWrite(fileStats)) {
      permissionWarnings.push(
        `Active policy ${policy.name} is owner-writable at ${file}; make it read-only outside the CLI`,
      );
    }
  }
  const canonicalSubjectPatterns = await Promise.all(policy.subject.paths.map(canonicalSubjectPattern));
  return { file, policy, canonicalSubjectPatterns, permissionWarnings };
}

export async function loadPolicyStore(paths: StoragePaths): Promise<PolicyRecord[]> {
  let entries;
  try {
    entries = await readdir(paths.policiesDirectory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(`Policy denied operation: cannot inspect ${paths.policiesDirectory}`);
  }
  if (process.platform !== "win32") {
    let directoryStats: Stats;
    try {
      directoryStats = await stat(paths.policiesDirectory);
    } catch {
      throw new Error(`Policy denied operation: cannot inspect permissions for ${paths.policiesDirectory}`);
    }
    if ((directoryStats.mode & 0o022) !== 0) {
      throw new Error(`Policy denied operation: policy directory ${paths.policiesDirectory} is writable by group or other users`);
    }
  }

  const policies: PolicyRecord[] = [];
  if (entries.some((entry) => entry.name === "workspaces" && entry.isDirectory())) {
    throw new Error(
      `Policy denied operation: legacy policy directory ${join(paths.policiesDirectory, "workspaces")} must be migrated or removed`,
    );
  }
  for (const entry of entries.filter(({ name }) => name.endsWith(".yaml")).sort((a, b) =>
    a.name.localeCompare(b.name))) {
    const file = join(paths.policiesDirectory, entry.name);
    if (!entry.isFile()) {
      throw new Error(`Policy denied operation: ${file} is not a regular policy file`);
    }
    policies.push(await loadPolicyFile(file, entry.name));
  }
  return policies;
}

function appliesToPath(record: PolicyRecord, subjectPath: string): boolean {
  return record.canonicalSubjectPatterns.some((pattern) => matchesGlob(subjectPath, pattern));
}

export async function resolvePolicies(
  paths: StoragePaths,
  start = process.cwd(),
): Promise<ResolvedPolicies> {
  const subjectPath = await canonicalSubjectPath(start);
  const policies = (await loadPolicyStore(paths)).filter((record) => appliesToPath(record, subjectPath));
  return { subjectPath, policies };
}

export async function resolvePolicyByName(paths: StoragePaths, name: string): Promise<PolicyRecord> {
  const file = policyFile(paths, name);
  const policy = (await loadPolicyStore(paths)).find((record) => record.file === file);
  if (!policy) throw new Error(`Policy ${name} does not exist at ${file}`);
  return policy;
}

export function policyStatusWarnings(resolved: ResolvedPolicies): string[] {
  return resolved.policies.flatMap((record) => [
    ...(!record.policy.active
      ? [`Policy ${record.policy.name} applies to ${resolved.subjectPath} but is inactive and not enforcing restrictions`]
      : []),
    ...record.permissionWarnings,
  ]);
}

function identityDenial(policy: Policy, identity: { tenantId: string; userId: string }): string | undefined {
  if (policy.identity?.tenantId && policy.identity.tenantId !== identity.tenantId) {
    return `tenant ${identity.tenantId} is not allowed`;
  }
  if (policy.identity?.userId && policy.identity.userId !== identity.userId) {
    return `user ${identity.userId} is not allowed`;
  }
  return undefined;
}

function evaluate(
  resolved: ResolvedPolicies,
  denial: (policy: Policy) => string | undefined,
): string[] {
  const warnings: string[] = [];
  for (const { policy } of resolved.policies) {
    const reason = denial(policy);
    if (!reason) continue;
    if (policy.active) throw new Error(`Policy ${policy.name} denied operation: ${reason}`);
    warnings.push(`Inactive policy ${policy.name} would deny operation: ${reason}`);
  }
  return warnings;
}

export function requirePolicyIdentity(
  resolved: ResolvedPolicies,
  identity: { tenantId: string; userId: string },
): string[] {
  return evaluate(resolved, (policy) => identityDenial(policy, identity));
}

export function requireMessageSend(
  resolved: ResolvedPolicies,
  identity: { tenantId: string; userId: string },
  target: MessageTarget,
): string[] {
  return evaluate(resolved, (policy) => {
    const identityReason = identityDenial(policy, identity);
    if (identityReason) return identityReason;
    const allowed = policy.allow?.messageSend;
    const identifiers = target.kind === "chat" ? allowed?.chats : allowed?.channels;
    return identifiers?.includes(target.id)
      ? undefined
      : `${target.kind} ${target.id} is not allowlisted`;
  });
}

export function requireRawTokenExport(
  resolved: ResolvedPolicies,
  identity: { tenantId: string; userId: string },
): string[] {
  return evaluate(resolved, (policy) => {
    const identityReason = identityDenial(policy, identity);
    if (identityReason) return identityReason;
    return policy.allow?.rawTokenExport === true ? undefined : "raw token export is not allowed";
  });
}

export async function initializePolicy(
  paths: StoragePaths,
  name: string,
  context: RuntimeContext,
  subjectPaths: readonly string[] = [],
  start = process.cwd(),
): Promise<PolicyRecord> {
  await loadPolicyStore(paths);
  if (!context.tenantId || !context.userId) {
    throw new Error("Policy initialization requires an effective tenant and user");
  }
  const file = policyFile(paths, name);
  if (await exists(file)) throw new Error(`Policy ${name} already exists at ${file}`);
  const subjectPath = await canonicalSubjectPath(start);
  const pathsToStore = subjectPaths.length > 0
    ? validateSubjectPaths([...subjectPaths])
    : [subjectPath, join(subjectPath, "**")];
  const policy: Policy = {
    version: 2,
    name,
    active: false,
    subject: { paths: pathsToStore },
    identity: { tenantId: context.tenantId, userId: context.userId },
    allow: { messageSend: { chats: [], channels: [] }, rawTokenExport: false },
  };
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await chmod(dirname(file), 0o700);
  await writeFile(file, stringify(policy), { mode: 0o600 });
  await chmod(file, 0o600);
  return {
    file,
    policy,
    canonicalSubjectPatterns: await Promise.all(pathsToStore.map(canonicalSubjectPattern)),
    permissionWarnings: [],
  };
}

export async function activatePolicy(record: PolicyRecord): Promise<PolicyRecord> {
  if (!record.policy.active) {
    const policy: Policy = { ...record.policy, active: true };
    const temporary = `${record.file}.${randomUUID()}.tmp`;
    await writeFile(temporary, stringify(policy), { mode: 0o600 });
    await rename(temporary, record.file);
    await chmod(record.file, 0o600);
    record = { ...record, policy };
  }
  return record;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function policyProtectionInstruction(file: string): string | null {
  if (process.platform === "win32") return null;
  return `chmod 400 -- ${shellQuote(file)}`;
}
