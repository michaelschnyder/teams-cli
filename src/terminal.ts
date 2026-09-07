import { Writable } from "node:stream";
import { cursorTo, moveCursor, clearLine } from "node:readline";
import { AsyncLocalStorage } from "node:async_hooks";
import { createInterface } from "node:readline/promises";
import { stripVTControlCharacters } from "node:util";
import { Chalk, type ChalkInstance } from "chalk";
import ora, { type Ora } from "ora";

export type OutputStream = Pick<NodeJS.WriteStream, "write"> & { isTTY?: boolean; columns?: number; };
export type TerminalOptions = {
  stdout?: OutputStream;
  stderr?: OutputStream;
  environment?: NodeJS.ProcessEnv;
  interactive: boolean;
  confirm?: (question: string) => Promise<boolean>;
};

export function safeText(value: unknown): string {
  return stripVTControlCharacters(String(value ?? "")).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

export class Terminal {
  readonly stdout: OutputStream;
  readonly stderr: OutputStream;
  readonly color: ChalkInstance;
  readonly interactive: boolean;
  readonly rich: boolean;
  reportNotice: ((message: string) => void) | undefined;
  private spinner: Ora | undefined;
  private status = "";
  private depth = 0;
  constructor(private readonly options: TerminalOptions) {
    this.stdout = options.stdout ?? process.stdout;
    this.stderr = options.stderr ?? process.stderr;
    const env = options.environment ?? process.env;
    this.interactive = options.interactive && !env.CI;
    const enabled = this.interactive && Boolean(this.stderr.isTTY) && !env.CI && env.TERM !== "dumb";
    this.rich = enabled;
    this.color = new Chalk({ level: enabled && env.NO_COLOR === undefined ? 1 : 0 });
    if (enabled) {
      const stream = Object.assign(new Writable({ write: (chunk, _encoding, done) => { this.stderr.write(chunk); done(); } }), {
        isTTY: true, columns: this.stderr.columns ?? 80,
        cursorTo: (x: number) => cursorTo(stream, x),
        moveCursor: (x: number, y: number) => moveCursor(stream, x, y),
        clearLine: (direction: -1 | 0 | 1) => clearLine(stream, direction),
      });
      this.spinner = ora({ stream: stream as unknown as NodeJS.WriteStream, discardStdin: false, isEnabled: true, color: env.NO_COLOR === undefined ? "cyan" : false, hideCursor: false });
    }
  }
  setStatus(message: string): void {
    this.status = safeText(message);
    if (!this.depth) { this.spinner?.stop(); this.spinner?.start(this.status); }
  }
  clear(): void { this.spinner?.stop(); }
  line(message: string, tone?: "error" | "warn" | "success" | "debug" | "info"): void {
    this.clear();
    const text = safeText(message).trimEnd();
    const styled = tone === "error" ? this.color.red(text) : tone === "warn" ? this.color.yellow(text) : tone === "success" ? this.color.green(text) : tone === "debug" ? this.color.dim(text) : tone === "info" ? this.color.cyan(text) : text;
    this.stderr.write(`${styled}\n`);
    if (this.status && !this.depth) this.spinner?.start(this.status);
  }
  async suspend<T>(operation: () => Promise<T>): Promise<T> {
    this.depth++;
    this.clear();
    try { return await operation(); }
    finally { this.depth--; if (!this.depth && this.status) this.spinner?.start(this.status); }
  }
  async confirm(question: string): Promise<boolean> {
    if (!this.interactive) return false;
    return this.suspend(() => (this.options.confirm ?? terminalConfirmation)(safeText(question)));
  }
  async statusDuring<T>(message: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.status;
    this.setStatus(message);
    try { return await operation(); }
    finally { this.status = previous; this.clear(); if (previous && !this.depth) this.spinner?.start(previous); }
  }
  close(): void { this.status = ""; this.clear(); }
}

const terminals = new AsyncLocalStorage<Terminal>();
export function withTerminal<T>(terminal: Terminal, operation: () => T): T { return terminals.run(terminal, operation); }
export function currentTerminal(): Terminal | undefined { return terminals.getStore(); }
export function showStatus(message: string): void { currentTerminal()?.setStatus(message); }
export function clearStatus(): void { currentTerminal()?.clear(); }
export function notice(message: string): void {
  const terminal = currentTerminal();
  if (terminal) {
    if (terminal.reportNotice) terminal.reportNotice(safeText(message).trimEnd());
    else terminal.line(message);
  }
  else process.stderr.write(`${safeText(message).trimEnd()}\n`);
}
export async function terminalConfirmation(question: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) return false;
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try { return /^y(?:es)?$/i.test((await prompt.question(`${safeText(question)} [y/N] `)).trim()); }
  finally { prompt.close(); }
}
export async function confirmTerminal(question: string): Promise<boolean> {
  return currentTerminal()?.confirm(question) ?? false;
}
export async function withStatus<T>(message: string, operation: () => Promise<T>): Promise<T> {
  return currentTerminal()?.statusDuring(message, operation) ?? operation();
}

/** Instructions needed to complete an explicit interaction, never diagnostic file data. */
export function instruction(message: string): void {
  const terminal = currentTerminal();
  if (terminal) terminal.line(message);
  else notice(message);
}

export function reportError(error: unknown, stderr: OutputStream = process.stderr, environment: NodeJS.ProcessEnv = process.env): void {
  const terminal = new Terminal({ stderr, environment, interactive: Boolean(stderr.isTTY) });
  terminal.line(`${terminal.rich ? "✖" : "[error]"} ${error instanceof Error ? error.message : "Command failed"}`, "error");
  terminal.close();
}
