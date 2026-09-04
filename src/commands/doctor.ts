import type { Command } from "commander";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { satisfies } from "semver";
import type { RuntimeContext } from "../config.js";
import { loadSession, type StoragePaths } from "../storage.js";
import {
  detectClaudeDesktop,
  detectSkillPlatforms,
  findProjectRoot,
  loadBundledSkills,
  loadSkillManifest,
  skillManifestFile,
} from "../skills.js";

export type DoctorCheck = {
  name: string;
  status: "ok" | "warning" | "error";
  message: string;
};

export type DoctorReport = { ok: boolean; checks: DoctorCheck[] };

export type DoctorOptions = {
  paths: StoragePaths;
  context: RuntimeContext;
  projectRoot?: string;
  userHome?: string;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  exists?: (path: string) => boolean;
  detectCowork?: () => Promise<boolean>;
  nodeVersion?: string;
  now?: Date;
};

export type DoctorCommandOptions = Omit<DoctorOptions, "context"> & {
  context: RuntimeContext | (() => Promise<RuntimeContext>);
  stdout?: Pick<NodeJS.WriteStream, "write">;
  setExitCode?: (code: number) => void;
};

const NODE_REQUIREMENT = ">=22.20.0";

function executableInPath(names: readonly string[], environment: NodeJS.ProcessEnv, exists: (path: string) => boolean): boolean {
  return (environment.PATH ?? "").split(":").filter(Boolean).some((directory) =>
    names.some((name) => exists(join(directory, name))));
}

export function detectBrowsers(options: {
  platform?: NodeJS.Platform;
  userHome?: string;
  environment?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
} = {}): Array<"edge" | "chrome"> {
  const platform = options.platform ?? process.platform;
  const userHome = options.userHome ?? homedir();
  const environment = options.environment ?? process.env;
  const exists = options.exists ?? existsSync;
  const found: Array<"edge" | "chrome"> = [];
  if (platform === "win32") {
    const roots = [environment["ProgramFiles"], environment["ProgramFiles(x86)"], environment.LOCALAPPDATA].filter(
      (value): value is string => Boolean(value),
    );
    if (roots.some((root) => exists(join(root, "Microsoft", "Edge", "Application", "msedge.exe")))) found.push("edge");
    if (roots.some((root) => exists(join(root, "Google", "Chrome", "Application", "chrome.exe")))) found.push("chrome");
  } else if (platform === "darwin") {
    if (exists("/Applications/Microsoft Edge.app") || exists(join(userHome, "Applications", "Microsoft Edge.app"))) found.push("edge");
    if (exists("/Applications/Google Chrome.app") || exists(join(userHome, "Applications", "Google Chrome.app"))) found.push("chrome");
  } else if (platform === "linux") {
    if (executableInPath(["microsoft-edge", "microsoft-edge-stable"], environment, exists)) found.push("edge");
    if (executableInPath(["google-chrome", "google-chrome-stable"], environment, exists)) found.push("chrome");
  }
  return found;
}

function normalized(content: string): string {
  return content.replaceAll("\r\n", "\n");
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const userHome = options.userHome ?? homedir();
  const projectRoot = options.projectRoot ?? findProjectRoot();
  const environment = options.environment ?? process.env;
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  checks.push({
    name: "node",
    status: satisfies(nodeVersion, NODE_REQUIREMENT) ? "ok" : "error",
    message: `Node.js ${nodeVersion}; teams-cli requires ${NODE_REQUIREMENT}`,
  });

  const browsers = detectBrowsers({
    ...(options.platform ? { platform: options.platform } : {}),
    userHome,
    environment,
    ...(options.exists ? { exists: options.exists } : {}),
  });
  checks.push({
    name: "browser",
    status: browsers.includes(options.context.browser) ? "ok" : "error",
    message: browsers.includes(options.context.browser)
      ? `${options.context.browser} is available for the selected profile`
      : `${options.context.browser} was not found; install it or select ${options.context.browser === "edge" ? "chrome" : "edge"}`,
  });

  if (!options.context.tenantId || !options.context.userId) {
    checks.push({ name: "identity", status: "warning", message: "No Teams identity is configured; run teams-cli login" });
  } else {
    checks.push({ name: "identity", status: "ok", message: "A Teams identity is configured" });
    try {
      const session = await loadSession(options.paths, {
        tenantId: options.context.tenantId,
        userId: options.context.userId,
      });
      const now = (options.now ?? new Date()).getTime();
      const expired = [session.accessToken, session.skypeToken, session.chatToken, session.searchToken]
        .some(({ expiresAt }) => Date.parse(expiresAt) <= now);
      checks.push({
        name: "session",
        status: expired ? "warning" : "ok",
        message: expired ? "The saved Teams session contains expired credentials and may require refresh" : "The saved Teams session is current",
      });
    } catch {
      checks.push({
        name: "session",
        status: "warning",
        message: "The saved Teams session could not be read or is incomplete",
      });
    }
  }

  try {
    const manifest = await loadSkillManifest(skillManifestFile(options.paths.root));
    const canonical = (await loadBundledSkills()).find(({ name }) => name === "teams-cli")?.content;
    if (!manifest.installations.length) {
      checks.push({ name: "skills", status: "warning", message: "No CLI-managed agent skill installation is recorded" });
    } else if (!canonical) {
      checks.push({ name: "skills", status: "error", message: "The packaged teams-cli skill is missing" });
    } else {
      let healthy = true;
      for (const installation of manifest.installations) {
        for (const skillName of installation.skillNames) {
          try {
            const installed = await readFile(join(installation.destination, skillName, "SKILL.md"), "utf8");
            if (skillName === "teams-cli" && normalized(installed) !== normalized(canonical)) healthy = false;
          } catch {
            healthy = false;
          }
        }
      }
      checks.push({
        name: "skills",
        status: healthy ? "ok" : "warning",
        message: healthy ? "CLI-managed agent skills are present and current" : "A CLI-managed agent skill is missing or differs from the packaged copy",
      });
    }
  } catch (error) {
    checks.push({ name: "skills", status: "error", message: error instanceof Error ? error.message : "Skill installation state is invalid" });
  }

  const agents = detectSkillPlatforms(projectRoot, userHome).map(({ name }) => name);
  checks.push({
    name: "agents",
    status: agents.length ? "ok" : "warning",
    message: agents.length ? `Detected agent environments: ${agents.join(", ")}` : "No filesystem-based agent environment was detected",
  });

  let cowork: boolean | undefined;
  try {
    cowork = options.detectCowork
      ? await options.detectCowork()
      : await detectClaudeDesktop({
        ...(options.platform ? { platform: options.platform } : {}),
        userHome,
        environment,
        ...(options.exists ? { exists: options.exists } : {}),
      });
  } catch {
    cowork = undefined;
  }
  checks.push({
    name: "cowork",
    status: cowork === false ? "ok" : "warning",
    message: cowork === true
      ? "Claude Desktop is present; Cowork's account-level skill installation and permissions cannot be verified locally"
      : cowork === false
        ? "Claude Desktop was not detected"
        : "Claude Desktop detection could not be completed; Cowork's account-level skill installation and permissions cannot be verified locally",
  });

  return { ok: checks.every(({ status }) => status !== "error"), checks };
}

export function renderDoctor(report: DoctorReport): string {
  const labels = { ok: "OK", warning: "WARN", error: "ERROR" } as const;
  return `${report.checks.map((check) => `[${labels[check.status]}] ${check.name}: ${check.message}`).join("\n")}\n`;
}

export function registerDoctorCommand(program: Command, options: DoctorCommandOptions): void {
  program.command("doctor")
    .description("Inspect the local teams-cli setup without changing it")
    .option("--json", "Output structured diagnostic information")
    .action(async (commandOptions: { json?: boolean }) => {
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
      (options.stdout ?? process.stdout).write(commandOptions.json ? `${JSON.stringify(report, null, 2)}\n` : renderDoctor(report));
      if (!report.ok) (options.setExitCode ?? ((code: number) => { process.exitCode = code; }))(1);
    });
}
