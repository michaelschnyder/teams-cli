import { ResultCommand } from "../command-runner.js";
import { runDoctor, type DoctorCommandOptions, type DoctorReport } from "../doctor.js";
import { commandResult } from "../output.js";
export function registerDoctorCommand(program: ResultCommand, options: DoctorCommandOptions): void {
  program.command("doctor").configureRunner({ ...(options.stdout ? { stdout: options.stdout } : {}), ...(options.environment ? { environment: options.environment } : {}) })
    .description("Inspect the local teams-cli setup without changing it")
    .option("--json", "Output structured diagnostic information")
    .action(async () => {
      let report: DoctorReport;
      try {
        const context = typeof options.context === "function" ? await options.context() : options.context;
        report = await runDoctor({ ...options, context });
      } catch (error) {
        report = {
          ok: false,
          checks: [{
            name: "configuration",
            status: "error",
            message: error instanceof Error ? error.message : "The local teams-cli configuration could not be read",
          }],
        };
      }

      if (!report.ok) (options.setExitCode ?? ((code: number) => { process.exitCode = code; }))(1);
      return { ...commandResult("doctor", report), failed: !report.ok };
    });
}
