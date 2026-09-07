import type { DoctorReport } from "../doctor.js";
export function renderDoctor(report: DoctorReport): string {
  const labels = { ok: "OK", warning: "WARN", error: "ERROR" } as const;
  return `${report.checks.map((check) => `[${labels[check.status]}] ${check.name}: ${check.message}`).join("\n")}\n`;
}
