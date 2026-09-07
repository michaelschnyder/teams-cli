import stringWidth from "string-width";
import { Chalk } from "chalk";
import { safeText, type OutputStream } from "./terminal.js";

export type View =
  | { kind: "sections"; title: string; sections: View[]; }
  | { kind: "table"; title: string; headers: string[]; rows: unknown[][]; footer?: string; }
  | { kind: "details"; title: string; fields: Array<[string, unknown]>; }
  | { kind: "messages"; title: string; messages: Array<{ heading: string; content: string; }>; footer?: string; }
  | { kind: "text"; text: string; };

export function renderView(view: View, stream: Pick<OutputStream, "isTTY" | "columns">, environment: NodeJS.ProcessEnv = process.env): string {
  const color = new Chalk({ level: stream.isTTY && environment.NO_COLOR === undefined && environment.TERM !== "dumb" && !environment.CI ? 1 : 0 });
  const heading = (text: string) => color.bold.cyan(safeText(text));
  if (view.kind === "sections") return `${heading(view.title)}\n${view.sections.map(section => renderView(section, stream, environment)).join("\n")}`;
  if (view.kind === "text") return `${safeText(view.text).trimEnd()}\n`;
  const lines = [heading(view.title)];
  if (view.kind === "details") {
    for (const [label, value] of view.fields) lines.push(`${color.bold(safeText(label))}: ${safeText(value)}`);
  } else if (view.kind === "messages") {
    if (!view.messages.length) lines.push("No results.");
    for (const message of view.messages) lines.push("", heading(message.heading), ...safeText(message.content).split("\n").map(line => `  ${line}`));
    if (view.footer) lines.push(safeText(view.footer));
  } else {
    const rows = view.rows.map(row => view.headers.map((_, index) => safeText(row[index]).split("\n")));
    const widths = view.headers.map((header, index) => Math.max(stringWidth(header), ...rows.flatMap(row => (row[index] ?? []).map(value => stringWidth(value)))));
    const width = widths.reduce((sum, value) => sum + value, 0) + (widths.length - 1) * 3;
    if (!rows.length) lines.push("No results.");
    else if (width > (stream.columns ?? 100)) {
      for (const row of view.rows) {
        lines.push("");
        view.headers.forEach((label, i) => lines.push(`${color.bold(label)}: ${safeText(row[i])}`));
      }
    } else {
      const pad = (text: string, i: number) => text + " ".repeat(Math.max(0, (widths[i] ?? 0) - stringWidth(text)));
      lines.push(view.headers.map(pad).join("   "), widths.map(width => "-".repeat(width)).join("   "));
      for (const row of rows) {
        for (let line = 0; line < Math.max(...row.map(cell => cell.length)); line++) lines.push(row.map((cell, i) => pad(cell[line] ?? "", i)).join("   "));
      }
    }
    if (view.footer) lines.push(safeText(view.footer));
  }
  return `${lines.join("\n")}\n`;
}
