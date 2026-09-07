import { Command, Option } from "commander";
import { Diagnostics, resolveLogLevel, withDiagnostics, type LogLevel } from "./diagnostics.js";
import { Terminal, withTerminal, type OutputStream } from "./terminal.js";
import { resolveOutput, writeResult, type CommandResult, type OutputOptions } from "./output.js";

export type RunnerOptions = { stdout?: OutputStream; stderr?: OutputStream; environment?: NodeJS.ProcessEnv; confirm?: (question: string) => Promise<boolean>; };
export class ResultCommand extends Command {
  constructor(name?: string, private runner: RunnerOptions = {}) { super(name); }
  configureRunner(options: Omit<RunnerOptions, "confirm">): this { this.runner = { ...this.runner, ...options }; return this; }
  override createCommand(name?: string): ResultCommand { return new ResultCommand(name, this.runner); }
  override action(handler: (...args: any[]) => void | Promise<void> | CommandResult | Promise<CommandResult | void>): this {
    this.addOption(new Option("-o, --output <format>", "Output format (default: text in a terminal, JSON when piped)").choices(["text", "json", "yaml"]));
    if (!this.options.some(option => option.long === "--json")) this.option("--json", "Output JSON (equivalent to --output json)");
    return super.action(async (...args: any[]) => {
      const options = this.optsWithGlobals() as OutputOptions & { log?: LogLevel; debug?: boolean; verbose?: number; logFile?: string; };
      const stdout = this.runner.stdout ?? process.stdout;
      const format = resolveOutput(options, Boolean(stdout.isTTY));
      const terminal = new Terminal({ ...this.runner, interactive: format === "text" && (Boolean(stdout.isTTY) || this.runner.confirm !== undefined) });
      const diagnostics = new Diagnostics(terminal, resolveLogLevel(options, terminal.interactive), options.logFile);
      const names: string[] = [];
      for (let command: Command | null = this; command?.parent; command = command.parent) names.unshift(command.name());
      const command = names.join(" ") || "help";
      const started = performance.now();
      const interrupted = () => {
        terminal.close();
        diagnostics.emit({ event: "command", command, outcome: "interrupted", durationMs: Math.round(performance.now() - started) });
        diagnostics.close();
        // A long-lived command such as the editor has its own shutdown listener.
        // Without one, retain the normal SIGINT exit behavior after UI cleanup.
        if (process.listenerCount("SIGINT") === 0) process.exit(130);
        process.exitCode = 130;
      };
      process.once("SIGINT", interrupted);
      try {
        await withTerminal(terminal, () => withDiagnostics(diagnostics, async () => {
          diagnostics.emit({ event: "command", command, outcome: "started" });
          const result = await handler(...args);
          terminal.close();
          if (result) writeResult(result, format, stdout, this.runner.environment);
          const durationMs = Math.round(performance.now() - started);
          diagnostics.emit({ event: "command", command, outcome: result?.failed ? "error" : "success", durationMs });
          if (format === "text" && terminal.interactive && result && !result.failed) diagnostics.complete(durationMs);
        }));
      } catch (error) {
        diagnostics.emit({ event: "command", command, outcome: "error", durationMs: Math.round(performance.now() - started) });
        throw error;
      } finally { process.removeListener("SIGINT", interrupted); terminal.close(); diagnostics.close(); }
    });
  }
}
