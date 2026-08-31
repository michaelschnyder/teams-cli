import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { access, chmod, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join, matchesGlob } from "node:path";
import { spawn } from "node:child_process";
import { WebSocketServer, type WebSocket } from "ws";
import { stringify } from "yaml";
import { withDataSession } from "./data.js";
import { loadProfiles, type RuntimeContext } from "./config.js";
import {
  canonicalSubjectPath,
  parsePolicy,
  policyFile,
  requirePolicyIdentity,
  resolvePolicies,
  type Policy,
} from "./policy.js";
import type { StoragePaths } from "./storage.js";
import { listChannels, listChats, searchPeople, type ChatSummary, type ChannelSummary } from "./teams-client.js";
import { parseStrictYaml } from "./yaml.js";

const DEFAULT_PORT_START = 58_326;
const DEFAULT_PORT_END = 58_335;
const DISCONNECT_GRACE_MS = 3_000;
const CONNECT_TIMEOUT_MS = 5 * 60_000;
const BODY_LIMIT = 512 * 1024;
const CLIENT_SCRIPT = await readFile(new URL("./policy-editor-client.js", import.meta.url), "utf8");

export type EditorPolicy = {
  name: string;
  file: string;
  raw: string;
  hash: string;
  policy?: Policy;
  error?: string;
  applies: boolean;
  matchingPaths?: string[];
  locked: boolean;
  lockReason?: string;
  warnings?: string[];
};

export type PolicyEditorOptions = {
  paths: StoragePaths;
  context: RuntimeContext;
  subjectStart?: string;
  requestedName?: string;
  port?: number;
  open?: boolean;
  version: string;
  isContainer?: boolean;
  connectTimeoutMs?: number;
  disconnectGraceMs?: number;
  openUrl?: (url: string) => Promise<void>;
  onReady?: (value: { url: string; port: number; bindAddress: string }) => void;
};

export type PolicyEditorResult = {
  reason: "activated" | "done" | "disconnected" | "timeout" | "interrupted";
  url: string;
  port: number;
  bindAddress: string;
};

type Resource = {
  kind: "person" | "chat" | "channel";
  category: "person" | "group" | "channel";
  id: string;
  label: string;
  detail: string;
  participantIds?: string[];
  chatId?: string;
  hidden?: boolean;
  disabled?: boolean;
};

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly detail?: Record<string, unknown>) {
    super(message);
  }
}

function hash(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function policyReplacementCommand(file: string, yaml: string): string {
  const encoded = Buffer.from(yaml).toString("base64");
  const script = 'target="$1"; encoded="$2"; temporary="${target}.policy-editor.$$"; umask 077; printf %s "$encoded" | base64 --decode > "$temporary" && mv "$temporary" "$target"';
  return `sudo sh -c ${shellQuote(script)} policy-editor ${shellQuote(file)} ${shellQuote(encoded)}`;
}

function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function writable(file: string): Promise<boolean> {
  try {
    await access(file, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function applies(policy: Policy, subjectPath: string): boolean {
  return matchingPaths(policy, subjectPath).length > 0;
}

function matchingPaths(policy: Policy, subjectPath: string): string[] {
  return policy.subject.paths.filter((pattern) => {
    try {
      return matchesGlob(subjectPath, pattern);
    } catch {
      return false;
    }
  });
}

export async function inspectPolicyStore(
  paths: StoragePaths,
  subjectPath: string,
): Promise<EditorPolicy[]> {
  let entries;
  try {
    entries = await readdir(paths.policiesDirectory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records: EditorPolicy[] = [];
  for (const entry of entries.filter(({ name }) => name.endsWith(".yaml")).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = join(paths.policiesDirectory, entry.name);
    if (!entry.isFile()) {
      records.push({ name: entry.name.slice(0, -5), file, raw: "", hash: "", error: "Not a regular file", applies: false, locked: true, lockReason: "Invalid policy entry" });
      continue;
    }
    let raw = "";
    try {
      raw = await readFile(file, "utf8");
      const policy = parsePolicy(parseStrictYaml(raw, file));
      if (entry.name !== `${policy.name}.yaml`) throw new Error(`Filename does not match policy name ${policy.name}`);
      const canWrite = await writable(file);
      const locked = policy.active || !canWrite;
      const fileStats = await stat(file);
      const warnings = policy.active && process.platform !== "win32" && (fileStats.mode & 0o022) !== 0
        ? ["Active policy is writable by group or other users and normal operations will fail closed"]
        : [];
      records.push({
        name: policy.name,
        file,
        raw,
        hash: hash(raw),
        policy,
        applies: applies(policy, subjectPath),
        matchingPaths: matchingPaths(policy, subjectPath),
        locked,
        ...(locked ? { lockReason: policy.active ? "Active policy: direct saves are blocked; edit and export instead" : "Policy file is not writable; edit and export instead" } : {}),
        ...(warnings.length ? { warnings } : {}),
      });
    } catch (error) {
      records.push({
        name: entry.name.slice(0, -5),
        file,
        raw,
        hash: hash(raw),
        error: error instanceof Error ? error.message : String(error),
        applies: false,
        locked: true,
        lockReason: "Invalid policies require external repair",
      });
    }
  }
  return records;
}

function chatResource(chat: ChatSummary, currentUserId: string): Resource {
  const participants = chat.participants
    .filter((participant) => participant.objectId !== currentUserId && participant.id !== currentUserId);
  const people = participants
    .map((participant) => participant.displayName ?? participant.id);
  const omitted = Math.max(0, chat.participantCount - chat.participants.length - 1);
  const fallback = chat.title || "Untitled chat";
  const label = chat.oneOnOne && people.length === 1 ? people[0] as string : fallback;
  const detailParts = chat.oneOnOne ? [] : people;
  if (omitted > 0) detailParts.push(`+${omitted} participant${omitted === 1 ? "" : "s"} not returned`);
  const participantIds = participants.flatMap((participant) => [participant.objectId, participant.id].filter((value): value is string => Boolean(value)));
  const personId = participantIds[0];
  return {
    kind: chat.oneOnOne && personId ? "person" : "chat",
    category: chat.oneOnOne ? "person" : "group",
    id: chat.oneOnOne && personId ? personId : chat.id,
    label,
    detail: detailParts.join(", ") || (chat.oneOnOne ? "One-to-one chat" : "Participants unavailable"),
    participantIds,
    ...(chat.oneOnOne ? { chatId: chat.id } : {}),
    hidden: chat.hidden,
    disabled: chat.disabled,
  };
}

function channelResource(channel: ChannelSummary): Resource {
  return { kind: "channel", category: "channel", id: channel.id, label: channel.name, detail: channel.team.name };
}

async function discoverResources(
  paths: StoragePaths,
  context: RuntimeContext,
  subjectPath: string,
): Promise<{ resources: Resource[]; error?: string }> {
  if (!context.tenantId || !context.userId) return { resources: [], error: "Select a tenant and user before loading Teams resources" };
  try {
    const resolved = await resolvePolicies(paths, subjectPath);
    requirePolicyIdentity(resolved, { tenantId: context.tenantId, userId: context.userId });
    return await withDataSession(paths, { tenantId: context.tenantId, userId: context.userId }, context.browser, ["chat", "skype"], async (session) => {
      const chats: ChatSummary[] = [];
      let cursor: string | undefined;
      do {
        const page = await listChats(session, cursor);
        chats.push(...page.chats);
        cursor = page.page.nextCursor ?? undefined;
      } while (cursor);
      const channels = await listChannels(session);
      return {
        resources: [
          ...chats.map((chat) => chatResource(chat, context.userId as string)),
          ...channels.channels.map(channelResource),
        ],
      };
    });
  } catch (error) {
    return { resources: [], error: error instanceof Error ? error.message : String(error) };
  }
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > BODY_LIMIT) throw new HttpError(413, "Request body is too large");
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new HttpError(400, "Request body must be valid JSON");
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, `${label} must be an object`);
  return value as Record<string, unknown>;
}

function cookies(request: IncomingMessage): Record<string, string> {
  return Object.fromEntries((request.headers.cookie ?? "").split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
    const index = part.indexOf("=");
    return index < 0 ? [part, ""] : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
  }));
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function allowedHost(host: string | undefined, port: number): boolean {
  if (!host) return false;
  try {
    const url = new URL(`http://${host}`);
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    return Number(url.port || 80) === port && ["localhost", "127.0.0.1", "::1"].includes(hostname);
  } catch {
    return false;
  }
}

function html(nonce: string, reconnectCommand: string): string {
  const escapedCommand = reconnectCommand.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  const reconnectJson = JSON.stringify(reconnectCommand).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Teams CLI Policy Editor</title>
<style nonce="${nonce}">
:root{color-scheme:light dark;font:14px/1.45 system-ui,sans-serif;--bg:light-dark(#f7f8fb,#161922);--panel:light-dark(#fff,#20252f);--subtle:light-dark(#f0f2f7,#1c202a);--text:light-dark(#172033,#edf0f8);--muted:light-dark(#657087,#a9b1c3);--line:light-dark(#d9dee7,#343947);--accent:light-dark(#4356b8,#6475dc);--danger:light-dark(#a42b25,#ffaaa6);--ok:light-dark(#216a42,#9ae4b8)}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text)}header{display:flex;align-items:center;gap:12px;padding:12px 16px;background:#252b4a;color:#fff;position:sticky;top:0;z-index:10}header h1{font-size:16px;margin:0 auto 0 0}button,input,select,textarea{font:inherit;font-size:13px}button{border:1px solid var(--line);border-radius:7px;padding:7px 11px;background:var(--panel);color:inherit;cursor:pointer}button:hover{border-color:var(--accent)}button:disabled{opacity:.42;cursor:not-allowed}.primary{background:var(--accent);border-color:transparent;color:#fff}.top-close{background:transparent;color:#fff;border-color:#7780a9}.status{white-space:nowrap}.offline,.banner{padding:10px 14px;margin:10px 20px;border-radius:8px;background:light-dark(#fff4ce,#4a3b17);color:light-dark(#5c4300,#ffe49a)}.banner.error,.offline{background:light-dark(#fee4e2,#4b2020);color:var(--danger)}.hidden{display:none!important}.policies{padding:14px 20px;border-bottom:1px solid var(--line);background:var(--subtle)}.policy-head{display:flex;align-items:center;gap:12px;margin-bottom:8px}.policy-head h2{font-size:16px;margin:0}.policy-actions{display:flex;align-items:center;gap:10px;margin-left:auto}.show-all{display:flex;align-items:center;gap:7px;color:var(--muted);font-size:13px}.table-wrap{overflow-x:auto}table{width:100%;min-width:560px;border-collapse:collapse}th,td{padding:8px;text-align:left;border-bottom:1px solid var(--line);font-size:13px}th{color:var(--muted);font-size:12px}.policy-table{min-width:760px;border-top:1px solid var(--line)}.policy-table tbody tr{cursor:pointer}.policy-table tr[aria-current=true]{background:light-dark(#e7eaf6,#292f43);box-shadow:inset 3px 0 var(--accent)}.policy-name{font-weight:600}.badge{display:inline-flex;padding:2px 7px;border-radius:999px;font-size:11px;background:light-dark(#e5e9fb,#353d67);color:light-dark(#354b9a,#c9d1ff)}.badge.active{background:light-dark(#dcefe5,#204733);color:var(--ok)}.badge.error{background:light-dark(#fee4e2,#4b2020);color:var(--danger)}.file{display:flex;align-items:center;gap:7px;white-space:nowrap}.file button{padding:3px 7px;border:0;background:transparent;color:var(--accent)}main{padding:0 20px 20px;max-width:1100px}.section{padding:17px 0;border-bottom:1px solid var(--line)}.section h3{font-size:16px;margin:0 0 4px}.section-lead{color:var(--muted);margin:0 0 12px}.tabs{display:flex;gap:4px;margin-top:14px;border-bottom:1px solid var(--line)}.tabs button{border-radius:7px 7px 0 0;border-bottom:0}.tabs button[aria-selected=true]{background:var(--accent);color:#fff;border-color:transparent}.search{margin:12px 0}.search input,input[type=text],textarea,select{width:100%;min-width:0;padding:8px 10px;border:1px solid var(--line);border-radius:7px;background:var(--panel);color:inherit}.suggestions{border:1px solid var(--line);border-radius:8px;margin-top:6px;background:var(--panel)}.suggestion{display:flex;align-items:center;gap:10px;padding:9px 10px;border-top:1px solid var(--line)}.suggestion:first-child{border-top:0}.suggestion span{margin-right:auto}.detail{display:block;margin-top:2px;color:var(--muted);font-size:12px;font-weight:400}.access{min-width:92px}.default-row td{background:var(--subtle);border-top:1px solid var(--line)}.identity-picker{width:100%}.paths{width:100%;min-height:calc(3 * 1.4em + 18px);max-height:calc(6 * 1.4em + 18px);line-height:1.4;resize:vertical}.token{display:flex;align-items:flex-start;gap:9px}.token input{margin-top:4px}.footer{display:flex;align-items:center;gap:9px;padding-top:16px}.footer .dirty{margin-right:auto;color:var(--muted);font-size:13px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#101526;color:#e8ecf5;padding:12px;border-radius:7px}@media(max-width:650px){header,.policy-head,.policy-actions,.footer{align-items:flex-start;flex-wrap:wrap}.policy-actions{margin-left:0}main{padding:0 12px 12px}.status{margin-left:auto}}
</style></head><body>
<header><h1 id="editorTitle">Policy Editor</h1><div id="connection" class="status">● connecting</div><button id="closeEditor" class="top-close">Close without saving</button></header>
<div id="offline" class="offline hidden">Editing has ended because the CLI server disconnected. Start it again with: <code>${escapedCommand}</code></div>
<section id="policySection" class="policies"><div class="policy-head"><h2>Workspace policies</h2><div class="policy-actions"><label id="showAllLabel" class="show-all"><input id="showAll" type="checkbox"> Show all policies on this system</label><button id="newPolicy" type="button">New policy</button></div></div><div id="policyTableWrap" class="table-wrap"><table class="policy-table"><thead><tr><th>Policy name</th><th>Status</th><th>Matching path</th><th>File</th><th></th></tr></thead><tbody id="policyRows"></tbody></table></div></section>
<main><div id="message"></div><div id="content">Loading policy context…</div></main>
<script type="module" nonce="${nonce}">
const reconnectCommand=${reconnectJson};
${CLIENT_SCRIPT}
</script></body></html>`;
}

export function detectContainer(): boolean {
  return Boolean(process.env.CONTAINER || process.env.DOCKER_CONTAINER || process.env.KUBERNETES_SERVICE_HOST || existsSync("/.dockerenv"));
}

export async function openSystemBrowser(url: string): Promise<void> {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

async function bindServer(server: ReturnType<typeof createServer>, address: string, requestedPort?: number): Promise<number> {
  const candidates = requestedPort === undefined
    ? [...Array.from({ length: DEFAULT_PORT_END - DEFAULT_PORT_START + 1 }, (_, index) => DEFAULT_PORT_START + index), 0]
    : [requestedPort];
  for (const port of candidates) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => { server.off("listening", onListening); reject(error); };
        const onListening = () => { server.off("error", onError); resolve(); };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, address);
      });
      const bound = server.address();
      if (!bound || typeof bound === "string") throw new Error("Editor server did not expose a TCP port");
      return bound.port;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || requestedPort !== undefined || port === 0) throw error;
    }
  }
  throw new Error("Could not find an available policy editor port");
}

export async function startPolicyEditor(options: PolicyEditorOptions): Promise<PolicyEditorResult> {
  const subjectPath = await canonicalSubjectPath(options.subjectStart);
  const invocationDirectory = options.subjectStart ?? process.cwd();
  const container = options.isContainer ?? detectContainer();
  const bindAddress = container ? "0.0.0.0" : "127.0.0.1";
  const bootstrapToken = randomBytes(32).toString("base64url");
  const sessionId = randomBytes(32).toString("base64url");
  const csrf = randomBytes(32).toString("base64url");
  const nonce = randomBytes(18).toString("base64url");
  let claimed = false;
  let connected = false;
  let disconnectTimer: NodeJS.Timeout | undefined;
  let shuttingDown = false;
  let finish: ((reason: PolicyEditorResult["reason"]) => void) | undefined;
  let port = 0;
  let resourcesPromise = discoverResources(options.paths, options.context, subjectPath);
  let restart = "";

  const authenticated = (request: IncomingMessage): boolean => sameSecret(cookies(request).teams_cli_editor ?? "", sessionId);
  const validateRequestOrigin = (request: IncomingMessage, requireOrigin = false): void => {
    if (!allowedHost(request.headers.host, port)) throw new HttpError(400, "Untrusted Host header");
    const expected = `http://${request.headers.host}`;
    if ((requireOrigin && !request.headers.origin) || (request.headers.origin && request.headers.origin !== expected)) {
      throw new HttpError(403, "Untrusted request origin");
    }
  };
  const requireMutation = (request: IncomingMessage): void => {
    validateRequestOrigin(request, true);
    if (!authenticated(request)) throw new HttpError(401, "Editor session is not authenticated");
    if (!sameSecret(String(request.headers["x-csrf-token"] ?? ""), csrf)) throw new HttpError(403, "Invalid CSRF token");
  };

  const server = createServer(async (request, response) => {
    try {
      validateRequestOrigin(request);
      const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
      if (request.method === "GET" && (url.pathname === "/" || url.pathname.startsWith("/claim/"))) {
        if (url.pathname === "/" && !authenticated(request)) throw new HttpError(401, "Open the one-time editor URL printed by the CLI");
        const body = html(nonce, restart);
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-length": Buffer.byteLength(body),
          "cache-control": "no-store",
          "content-security-policy": `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
          "x-frame-options": "DENY",
        });
        response.end(body);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/claim") {
        validateRequestOrigin(request, true);
        const body = object(await readBody(request), "Claim request");
        if (claimed || typeof body.token !== "string" || !sameSecret(body.token, bootstrapToken)) throw new HttpError(401, "The one-time editor link is invalid or already used");
        claimed = true;
        response.setHeader("set-cookie", `teams_cli_editor=${encodeURIComponent(sessionId)}; HttpOnly; SameSite=Strict; Path=/`);
        json(response, 200, { csrf });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/session") {
        if (!authenticated(request)) throw new HttpError(401, "Editor session is not authenticated");
        json(response, 200, { csrf });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/state") {
        if (!authenticated(request)) throw new HttpError(401, "Editor session is not authenticated");
        const policies = await inspectPolicyStore(options.paths, subjectPath);
        const discovered = await resourcesPromise;
        const active = policies.filter((record) => record.applies && record.policy?.active);
        const profiles = await loadProfiles(options.paths);
        const identities = Object.entries(profiles.profiles).flatMap(([profileName, profile]) =>
          profile.tenantId && profile.userId
            ? [{ profileName, tenantId: profile.tenantId, userId: profile.userId, label: profile.username ?? profileName }]
            : []);
        const issues = [
          ...(active.length === 0 ? ["No active policy applies to this workspace"] : []),
          ...policies.filter((record) => record.error).map((record) => `${record.name}: ${record.error}`),
          ...policies.flatMap((record) => record.warnings?.map((warning) => `${record.name}: ${warning}`) ?? []),
          ...(discovered.error ? [`Teams discovery: ${discovered.error}`] : []),
        ];
        json(response, 200, {
          version: options.version,
          invocationDirectory,
          subjectPath,
          context: { profileName: options.context.profileName, tenantId: options.context.tenantId, userId: options.context.userId, username: options.context.username, browser: options.context.browser },
          policies,
          identities,
          resources: discovered.resources,
          issues,
          requestedName: options.requestedName,
          binding: `${bindAddress}:${port}`,
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/people") {
        if (!authenticated(request)) throw new HttpError(401, "Editor session is not authenticated");
        const query = (url.searchParams.get("q") ?? "").trim();
        if (query.length < 2) throw new HttpError(400, "Enter at least two characters to search the directory");
        if (query.length > 100) throw new HttpError(400, "Directory search is limited to 100 characters");
        if (!options.context.tenantId || !options.context.userId) throw new HttpError(400, "Select a tenant and user before searching people");
        const discovered = await resourcesPromise;
        const result = await withDataSession(
          options.paths,
          { tenantId: options.context.tenantId, userId: options.context.userId },
          options.context.browser,
          "search",
          (session) => searchPeople(session, query),
        );
        const directChats = discovered.resources.filter((resource) => resource.kind === "person");
        json(response, 200, {
          people: result.people.map((person) => ({
            id: person.id,
            mri: person.mri,
            displayName: person.displayName,
            email: person.email,
            jobTitle: person.jobTitle,
            chatId: directChats.find((resource) => resource.participantIds?.some((id) => id === person.id || id === person.mri))?.chatId ?? null,
          })),
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/render") {
        requireMutation(request);
        const body = object(await readBody(request), "Render request");
        json(response, 200, { yaml: stringify(parsePolicy(body.policy)) });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/export") {
        requireMutation(request);
        const body = object(await readBody(request), "Export request");
        const policy = parsePolicy(body.policy);
        if (typeof body.originalName !== "string" || body.originalName !== policy.name) {
          throw new HttpError(400, "Exported existing policies must keep their name");
        }
        const records = await inspectPolicyStore(options.paths, subjectPath);
        const existing = records.find((record) => record.name === body.originalName);
        if (!existing?.policy) throw new HttpError(404, `Policy ${body.originalName} does not exist or is invalid`);
        const file = policyFile(options.paths, policy.name);
        const yaml = stringify(policy);
        json(response, 200, { yaml, command: policyReplacementCommand(file, yaml), file });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/save") {
        requireMutation(request);
        const body = object(await readBody(request), "Save request");
        if (body.mode !== "draft" && body.mode !== "activate") throw new HttpError(400, "Save mode must be draft or activate");
        const parsed = parsePolicy(body.policy);
        const policy: Policy = { ...parsed, active: body.mode === "activate" };
        const originalName = body.originalName === null ? null : typeof body.originalName === "string" ? body.originalName : null;
        if (originalName && originalName !== policy.name) throw new HttpError(400, "Existing policies cannot be renamed");
        const records = await inspectPolicyStore(options.paths, subjectPath);
        const existing = originalName ? records.find((record) => record.name === originalName) : undefined;
        if (existing?.locked) throw new HttpError(409, existing.lockReason ?? "Policy is locked");
        if (!existing && records.some((record) => record.name === policy.name)) throw new HttpError(409, `Policy ${policy.name} already exists`);
        if (existing && body.expectedHash !== existing.hash) throw new HttpError(409, "Policy changed outside the editor; reload before saving");
        const file = policyFile(options.paths, policy.name);
        const yaml = stringify(policy);
        try {
          await mkdir(dirname(file), { recursive: true, mode: 0o700 });
          await chmod(dirname(file), 0o700);
          const temporary = `${file}.${randomUUID()}.tmp`;
          await writeFile(temporary, yaml, { mode: 0o600 });
          await rename(temporary, file);
          await chmod(file, 0o600);
        } catch (error) {
          throw new HttpError(500, error instanceof Error ? error.message : String(error), {
            yaml,
            command: policyReplacementCommand(file, yaml),
          });
        }
        json(response, 200, { policy, file, protection: process.platform === "win32" ? "Apply an administrator-managed read-only ACL" : `chmod 400 -- ${shellQuote(file)}` });
        if (body.mode === "activate") setTimeout(() => finish?.("activated"), 50);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/delete") {
        requireMutation(request);
        const body = object(await readBody(request), "Delete request");
        if (typeof body.name !== "string") throw new HttpError(400, "Policy name is required");
        const records = await inspectPolicyStore(options.paths, subjectPath);
        const existing = records.find((record) => record.name === body.name);
        if (!existing) throw new HttpError(404, `Policy ${body.name} does not exist`);
        if (existing.policy?.active) throw new HttpError(409, "Active policies cannot be deleted");
        if (existing.locked) throw new HttpError(409, existing.lockReason ?? "Policy is locked");
        if (body.expectedHash !== existing.hash) throw new HttpError(409, "Policy changed outside the editor; reload before deleting");
        await unlink(existing.file);
        json(response, 200, { deleted: true });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/done") {
        requireMutation(request);
        json(response, 200, { done: true });
        setTimeout(() => finish?.("done"), 50);
        return;
      }
      throw new HttpError(404, "Not found");
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof Error ? error.message : String(error);
      json(response, status, { error: message, ...(error instanceof HttpError && error.detail ? error.detail : {}) });
    }
  });

  const sockets = new Set<WebSocket>();
  const webSockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    try {
      validateRequestOrigin(request, true);
      if (request.url !== "/ws" || !authenticated(request)) throw new Error("Unauthorized WebSocket");
      webSockets.handleUpgrade(request, socket, head, (webSocket) => webSockets.emit("connection", webSocket, request));
    } catch {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
    }
  });
  webSockets.on("connection", (socket) => {
    connected = true;
    if (disconnectTimer) clearTimeout(disconnectTimer);
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
      if (!shuttingDown && sockets.size === 0) disconnectTimer = setTimeout(() => finish?.("disconnected"), options.disconnectGraceMs ?? DISCONNECT_GRACE_MS);
    });
  });

  port = await bindServer(server, bindAddress, options.port);
  restart = `cd ${shellQuote(subjectPath)} && teams-cli --profile ${shellQuote(options.context.profileName)}${options.context.tenantId ? ` --tenant ${shellQuote(options.context.tenantId)}` : ""}${options.context.userId ? ` --user ${shellQuote(options.context.userId)}` : ""} policy edit --port ${port}`;
  const url = `http://localhost:${port}/claim/${encodeURIComponent(bootstrapToken)}`;
  process.stderr.write(`Policy editor: ${url}\n`);
  process.stderr.write(`Workspace: ${subjectPath}\n`);
  if (container) process.stderr.write(`Warning: container mode binds ${bindAddress}:${port}; publish only to a trusted localhost interface.\n`);
  options.onReady?.({ url, port, bindAddress });
  if (options.open) {
    try {
      await (options.openUrl ?? openSystemBrowser)(url);
    } catch (error) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      webSockets.close();
      throw error;
    }
  }

  let interrupted = false;
  const onInterrupt = () => { interrupted = true; finish?.("interrupted"); };
  process.once("SIGINT", onInterrupt);
  const reason = await new Promise<PolicyEditorResult["reason"]>((resolve) => {
    finish = resolve;
    setTimeout(() => { if (!connected) resolve("timeout"); }, options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS).unref();
  });
  process.off("SIGINT", onInterrupt);
  shuttingDown = true;
  if (disconnectTimer) clearTimeout(disconnectTimer);
  for (const socket of sockets) socket.close(1001, "Policy editor closed");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  webSockets.close();
  if (interrupted) process.stderr.write("Policy editor interrupted.\n");
  return { reason, url, port, bindAddress };
}
