import { dirname } from "node:path";
import { login } from "./auth.js";
import type { RunnerOptions } from "./command-runner.js";
import { resolveRuntimeContext, type RuntimeOverrides } from "./config.js";
import { authorizedRuntime, withAuthorizedDataSession, type InteractiveAuthSupport } from "./runtime.js";
import type { SkillsCommandOptions } from "./skill-installation.js";
import { storagePaths } from "./storage.js";
import { confirmTerminal } from "./terminal.js";
export type ProgramOptions = RunnerOptions & {
  storageRoot?: string;
  subjectPath?: string;
  loginImplementation?: typeof login;
  fetcher?: typeof fetch;
  detectCowork?: () => Promise<boolean>;
};
export function createServices(options: ProgramOptions, overrides: () => RuntimeOverrides) {
  const paths = storagePaths(options.storageRoot);
  const subjectPath = options.subjectPath;
  const interactiveAuth: InteractiveAuthSupport = { confirm: confirmTerminal, login: options.loginImplementation ?? login };
  const context = () => resolveRuntimeContext(paths, overrides());
  const isolated = options.storageRoot ? dirname(options.storageRoot) : undefined;
  const skillsOptions: SkillsCommandOptions = {
    ...(options.storageRoot ? { storageRoot: options.storageRoot } : {}),
    ...(options.environment ? { environment: options.environment } : {}),
    ...(isolated ? { projectRoot: isolated, userHome: isolated } : {}),
    ...(options.detectCowork ? { detectCowork: options.detectCowork } : options.storageRoot ? { detectCowork: async () => false } : {}),
  };
  return {
    options, paths, subjectPath, interactiveAuth, skillsOptions, context,
    authorized: (report?: (warnings: readonly string[]) => void, auth = interactiveAuth, offerLogin = true) => authorizedRuntime(context, paths, subjectPath, report, auth, offerLogin),
    data: <T>(targets: Parameters<typeof withAuthorizedDataSession>[3], operation: Parameters<typeof withAuthorizedDataSession<T>>[4], auth = interactiveAuth) => withAuthorizedDataSession(context, paths, subjectPath, targets, operation, auth),
  };
}
export type CommandServices = ReturnType<typeof createServices>;
