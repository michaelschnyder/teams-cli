import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { access, chmod, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join, matchesGlob } from "node:path";
import { spawn } from "node:child_process";
import { WebSocketServer, type WebSocket } from "ws";
import { stringify } from "yaml";
import { withDataSession } from "./data.js";
import type { RuntimeContext } from "./config.js";
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
  kind: "chat" | "channel";
  category: "person" | "group" | "channel";
  id: string;
  label: string;
  detail: string;
  participantIds?: string[];
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
  return policy.subject.paths.some((pattern) => {
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
  return {
    kind: "chat",
    category: chat.oneOnOne ? "person" : "group",
    id: chat.id,
    label,
    detail: detailParts.join(", ") || (chat.oneOnOne ? "One-to-one chat" : "Participants unavailable"),
    participantIds: participants.flatMap((participant) => [participant.id, participant.objectId].filter((value): value is string => Boolean(value))),
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
<title>Teams CLI policy editor</title>
<style nonce="${nonce}">
:root{color-scheme:light;font:14px/1.45 system-ui,sans-serif;--bg:#f5f7fb;--panel:#fff;--text:#172033;--muted:#647089;--line:#dbe1ec;--accent:#5666d8;--danger:#b42318;--ok:#16794b;--post:#a44b13}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text)}header{padding:13px 18px;background:#252b4a;color:#fff;display:flex;gap:14px;align-items:center;position:sticky;top:0;z-index:10}header h1{font-size:17px;margin:0;white-space:nowrap}.meta{font-size:12px;opacity:.82;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.status{margin-left:auto;white-space:nowrap}.top-close{background:transparent;color:#fff;border-color:#7780a9}.layout{display:grid;grid-template-columns:240px 1fr;min-height:calc(100vh - 60px)}nav{padding:14px;border-right:1px solid var(--line);background:var(--panel)}nav button{width:100%;text-align:left;margin:3px 0}.content{padding:20px;min-width:0;max-width:1050px}.card{background:var(--panel);border:1px solid var(--line);border-radius:11px;padding:17px;margin-bottom:14px}.card h3{margin:0 0 5px}.card h4{margin:0 0 5px}.section-lead{color:var(--muted);margin:0 0 14px}.guardrail-section{border-top:1px solid var(--line);padding-top:15px;margin-top:15px}.guardrail-section:first-of-type{border-top:0;padding-top:0}.banner{padding:10px 14px;border-radius:8px;margin:10px 0;background:#fff4ce;color:#5c4300}.banner.error{background:#fee4e2;color:var(--danger)}.banner.ok{background:#dff6e9;color:var(--ok)}button{border:1px solid var(--line);border-radius:7px;background:var(--panel);color:inherit;padding:8px 11px;cursor:pointer}button.primary,summary.primary,.allow-result{background:var(--accent);color:#fff;border-color:var(--accent)}button.danger,.deny-result{color:var(--danger)}button:disabled{opacity:.5;cursor:not-allowed}input[type=text],textarea{width:100%;padding:9px;border:1px solid var(--line);border-radius:6px;background:var(--panel);color:inherit}select{padding:8px;border:1px solid var(--line);border-radius:7px;background:var(--panel);color:inherit}.read-access{border-color:#8390d9;background:#f0f2ff}.post-access{border-color:#d79a70;background:#fff2e8;color:#74330d}label{display:block;font-weight:600;margin:10px 0 5px}.field-title{display:flex;align-items:center;gap:7px}.help{border:0;padding:0;background:transparent;color:var(--muted);cursor:help;font-size:15px}.identity-card{display:grid;grid-template-columns:auto 1fr;gap:10px;align-items:start;background:#f4f5f8;border:1px solid var(--line);border-radius:8px;padding:12px;color:#343c50}.identity-card .icon{font-size:20px}.token-row{display:grid;grid-template-columns:auto 1fr;gap:10px;align-items:start;padding:4px 0}.token-row input{margin-top:4px}.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px;align-items:start}.save-menu{position:relative}.save-menu summary{list-style:none;border:1px solid var(--accent);border-radius:7px;padding:8px 12px;cursor:pointer}.save-menu summary::-webkit-details-marker{display:none}.save-options{position:absolute;right:0;top:42px;z-index:5;min-width:220px;background:var(--panel);border:1px solid var(--line);border-radius:8px;box-shadow:0 8px 24px #18213a26;padding:6px}.save-options button{display:block;width:100%;text-align:left;border:0}.resource{display:grid;grid-template-columns:minmax(0,1fr) 86px 86px;gap:12px;align-items:center;border-top:1px solid var(--line);padding:11px 0}.resource small,.muted{color:var(--muted)}.resource code{font-size:11px}.default-deny{background:#f4f5f8;border-radius:7px;padding:9px 11px;font-weight:600;margin:9px 0}.broad-rules{display:grid;gap:7px;margin:10px 0}.broad-rule{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:14px;align-items:center;border:1px solid var(--line);border-radius:8px;padding:10px}.broad-rule label{margin:0;font-weight:500}.post-label{color:var(--post)}.bucket{display:grid;gap:6px;margin-top:10px}.bucket-resource{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:10px;align-items:center;border:1px solid var(--line);border-left:4px solid var(--accent);border-radius:8px;padding:10px}.bucket-resource.deny{border-left-color:var(--danger);background:#fff9f8}.kind-badge{display:inline-block;background:#edf0f7;color:#434d66;border-radius:10px;padding:2px 7px;font-size:11px}.suggestions{border:1px solid var(--line);border-radius:8px;margin-top:6px;background:var(--panel);box-shadow:0 8px 24px #18213a18}.suggestion{display:flex;justify-content:space-between;gap:12px;align-items:center;padding:10px 12px;border-top:1px solid var(--line)}.suggestion:first-child{border-top:0}.suggestion small{color:var(--muted)}.suggestion-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}.directory-only{background:#fafbfc}.badge{display:inline-block;padding:2px 7px;border-radius:10px;background:#e8ebf8;color:#38439b;font-size:11px;margin-left:5px}.badge.active{background:#dff6e9;color:var(--ok)}.badge.error{background:#fee4e2;color:var(--danger)}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#101526;color:#e8ecf5;padding:12px;border-radius:7px}.hidden{display:none}@media(max-width:720px){header{flex-wrap:wrap}.meta{order:3;width:100%}.layout{grid-template-columns:1fr}nav{border-right:0;border-bottom:1px solid var(--line);display:flex;overflow:auto;gap:5px}nav button{width:auto;white-space:nowrap}.content{padding:12px}.resource{grid-template-columns:minmax(0,1fr) 42px 42px}.broad-rule,.bucket-resource{grid-template-columns:1fr}.suggestion{align-items:flex-start;flex-direction:column}.status{margin-left:auto}}
</style></head><body>
<header><h1>Teams CLI policy editor</h1><div id="headerMeta" class="meta">Connecting…</div><div id="connection" class="status">● connecting</div><button id="closeEditor" class="top-close">Close</button></header>
<div id="offline" class="banner error hidden">Editing has ended because the CLI server disconnected. Start it again with: <code>${escapedCommand}</code></div>
<div class="layout"><nav id="tabs"></nav><main id="content" class="content"><div class="card">Loading policy context…</div></main></div>
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
        const directChats = discovered.resources.filter((resource) => resource.category === "person");
        json(response, 200, {
          people: result.people.map((person) => ({
            id: person.id,
            mri: person.mri,
            displayName: person.displayName,
            email: person.email,
            jobTitle: person.jobTitle,
            chatId: directChats.find((resource) => resource.participantIds?.some((id) => id === person.id || id === person.mri))?.id ?? null,
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
        if (JSON.stringify(existing.policy.identity ?? {}) !== JSON.stringify(policy.identity ?? {})) {
          throw new HttpError(400, "The policy identity cannot be changed in the editor");
        }
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
        if (existing?.policy && JSON.stringify(existing.policy.identity ?? {}) !== JSON.stringify(policy.identity ?? {})) {
          throw new HttpError(400, "The policy identity cannot be changed in the editor");
        }
        if (!existing) {
          if (!options.context.tenantId || !options.context.userId) throw new HttpError(400, "Select a tenant and user before creating a policy");
          if (policy.identity?.tenantId !== options.context.tenantId || policy.identity?.userId !== options.context.userId) {
            throw new HttpError(400, "New policies must use the selected tenant and user");
          }
        }
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
