import { stringify } from "yaml";
import type { View } from "./presentation.js";
import { renderView } from "./presentation.js";
import { present } from "./presenters.js";
import type { Results } from "./results.js";
import type { OutputStream } from "./terminal.js";

export type OutputFormat = "text" | "json" | "yaml";
export type OutputOptions = { output?: OutputFormat; json?: boolean; };
export function resolveOutput(options: OutputOptions, stdoutIsTTY: boolean): OutputFormat {
  if (options.json && options.output && options.output !== "json") throw new Error("--json conflicts with --output; select one output format.");
  return options.json ? "json" : options.output ?? (stdoutIsTTY ? "text" : "json");
}
export type CommandResult = { data: unknown; view: () => View; raw?: Buffer; failed?: boolean; };
export function commandResult<K extends keyof Results>(kind: K, data: Results[K]): CommandResult {
  return { data, view: () => present(kind, data) };
}
export function rawResult(raw: Buffer): CommandResult { return { data: null, view: () => ({ kind: "text", text: "" }), raw }; }
export function writeResult(result: CommandResult, format: OutputFormat, stdout: OutputStream, environment?: NodeJS.ProcessEnv): void {
  if (result.raw) { stdout.write(result.raw); return; }
  stdout.write(format === "json" ? `${JSON.stringify(result.data, null, 2)}\n` : format === "yaml" ? stringify(result.data, { lineWidth: 0 }) : renderView(result.view(), stdout, environment));
}
