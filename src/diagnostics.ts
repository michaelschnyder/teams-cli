import { AsyncLocalStorage } from "node:async_hooks";
import { constants, closeSync, fstatSync, openSync, writeSync, fchmodSync } from "node:fs";
import { createConsola } from "consola";
import type { Terminal } from "./terminal.js";

export type LogLevel = "error" | "warn" | "info" | "debug" | "trace";
const levels = { error: 0, warn: 1, info: 3, debug: 4, trace: 5 } as const;
export const MAX_LOG_BYTES = 10 * 1024 * 1024;
export function resolveLogLevel(options: { log?: LogLevel; debug?: boolean; verbose?: number; }, interactive: boolean): LogLevel {
  return options.log ?? (options.debug ? "debug" : (options.verbose ?? 0) >= 3 ? "trace" : options.verbose === 2 ? "debug" : options.verbose === 1 ? "info" : interactive ? "info" : "warn");
}

// Only fixed event names and explicitly projected primitive fields enter either reporter.
export type DiagnosticEvent =
  | { event: "command"; command: string; outcome: "started" | "success" | "error" | "interrupted"; durationMs?: number; }
  | { event: "request" | "response" | "http-error"; method: string; endpoint: string; attempt: number; status?: number; durationMs?: number; }
  | { event: "refresh"; target: "access" | "skype" | "chat" | "search"; }
  | { event: "retry"; status: number; attempt: number; };

// Retain static route segments only. Unknown paths and every identifier are redacted,
// including encoded identifiers, userinfo, query strings, and editor access tokens.
const routeWords = new Set(["api", "mt", "csa", "emea", "amer", "apac", "beta", "v1", "v2", "v3", "v4", "v6", "v7", "v8", "users", "conversations", "messages", "properties", "profile", "profilepicture", "teams", "channels", "search", "query", "chats", "authz", "token", "me", "all", "members", "updates", "sync"]);
export function sanitizedEndpoint(input: string | URL | Request): string {
  try {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const parts = url.pathname.split("/").map((part, i, all) => {
      if (!part) return "";
      if (["users", "conversations", "messages", "teams", "channels"].includes(all[i - 1] ?? "")) return "<redacted>";
      return routeWords.has(part.toLowerCase()) ? part : "<redacted>";
    });
    // Hostnames can themselves contain user-controlled identifiers. Only service families are retained.
    const hosts = new Set(["teams.microsoft.com", "outlook.office.com", "login.microsoftonline.com", "emea.ng.msg.teams.microsoft.com", "amer.ng.msg.teams.microsoft.com", "apac.ng.msg.teams.microsoft.com"]);
    const host = hosts.has(url.hostname) ? url.hostname : "<host>";
    return `${url.protocol === "https:" ? "https" : "http"}://${host}${parts.join("/")}`;
  } catch { return "<redacted>"; }
}

function project(event: DiagnosticEvent): Record<string, string | number> {
  switch (event.event) {
    case "command": return { event: event.event, command: /^[a-z-]+(?: [a-z-]+)*$/.test(event.command) ? event.command : "command", outcome: event.outcome, ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }) };
    case "refresh": return { event: event.event, target: event.target };
    case "retry": return { event: event.event, status: event.status, attempt: event.attempt };
    default: return { event: event.event, method: /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)$/.test(event.method) ? event.method : "OTHER", endpoint: sanitizedEndpoint(event.endpoint), attempt: event.attempt, ...(event.status === undefined ? {} : { status: event.status }), ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }) };
  }
}

export class Diagnostics {
  private file: number | undefined;
  private fileWarning = false;
  private readonly logger;
  constructor(private readonly terminal: Terminal, readonly level: LogLevel, path?: string) {
    this.logger = createConsola({
      level: levels[level], reporters: [{
        log: (obj) => {
          const icon = obj.type === "error" ? "✖" : obj.type === "warn" ? "⚠" : obj.type === "success" ? "✔" : "ℹ";
          terminal.line(`${terminal.rich ? icon : `[${obj.type}]`} ${obj.args.map(String).join(" ")}`, obj.type === "error" || obj.type === "warn" || obj.type === "success" || obj.type === "info" ? obj.type : "debug");
        }
      }]
    });
    terminal.reportNotice = message => { if (/^Warning:/i.test(message)) this.logger.warn(message); else this.logger.info(message); };
    if (path) {
      try {
        this.file = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK, 0o600);
        if (!fstatSync(this.file).isFile()) throw new Error("not a regular file");
        if (process.platform !== "win32") fchmodSync(this.file, 0o600);
      } catch {
        this.close();
        throw new Error("Cannot open diagnostic log file; choose a writable regular file.");
      }
    }
  }
  emit(event: DiagnosticEvent): void {
    const fields = project(event);
    const entry = { timestamp: new Date().toISOString(), ...fields };
    const line = Object.entries(fields).map(([key, value]) => `${key}=${value}`).join(" ");
    this.logger.debug(line);
    if (this.file === undefined) return;
    try {
      const bytes = Buffer.from(`${JSON.stringify(entry)}\n`);
      if (fstatSync(this.file).size + bytes.length > MAX_LOG_BYTES) { this.disableFile("Diagnostic log reached its 10 MiB limit; file logging stopped."); return; }
      if (writeSync(this.file, bytes) !== bytes.length) this.disableFile("Diagnostic file write was incomplete; file logging stopped.");
    } catch { this.disableFile("Diagnostic file is unavailable; file logging stopped."); }
  }
  complete(durationMs: number): void { this.logger.success(`Completed in ${durationMs} ms`); }
  private disableFile(message: string): void {
    this.close();
    if (!this.fileWarning) { this.fileWarning = true; this.terminal.line(`Warning: ${message}`); }
  }
  close(): void { if (this.file !== undefined) { const file = this.file; this.file = undefined; try { closeSync(file); } catch { /* Diagnostic cleanup cannot change command outcome. */ } } }
}

type Scope = { diagnostics: Diagnostics; attempt: number; };
const scopes = new AsyncLocalStorage<Scope>();
export function withDiagnostics<T>(diagnostics: Diagnostics, operation: () => T): T { return scopes.run({ diagnostics, attempt: 1 }, operation); }
export function withRequestAttempt<T>(attempt: number, operation: () => T): T {
  const scope = scopes.getStore();
  return scope ? scopes.run({ ...scope, attempt }, operation) : operation();
}
export function diagnostic(event: DiagnosticEvent): void { scopes.getStore()?.diagnostics.emit(event); }
export async function observedFetch(implementation: typeof fetch, input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  const endpoint = input instanceof Request ? input.url : input.toString();
  const attempt = scopes.getStore()?.attempt ?? 1;
  const started = performance.now();
  diagnostic({ event: "request", method, endpoint, attempt });
  try {
    const response = await implementation(input, init);
    diagnostic({ event: "response", method, endpoint, attempt, status: response.status, durationMs: Math.round(performance.now() - started) });
    return response;
  } catch (error) {
    diagnostic({ event: "http-error", method, endpoint, attempt, durationMs: Math.round(performance.now() - started) });
    throw error;
  }
}
