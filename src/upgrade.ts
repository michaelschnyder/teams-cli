import { win32 } from "node:path";
import { PACKAGE_NAME } from "./version.js";

export type UpgradeRunner = (command: string, args: readonly string[]) => Promise<number>;

export type NpmInvocation = { command: string; args: readonly string[] };

export function npmInvocation(
  platform = process.platform,
  nodeExecutable = process.execPath,
  npmExecPath: string | null | undefined = process.env.npm_execpath,
): NpmInvocation {
  if (npmExecPath) return { command: nodeExecutable, args: [npmExecPath] };
  if (platform === "win32") {
    return {
      command: nodeExecutable,
      args: [win32.join(win32.dirname(nodeExecutable), "node_modules", "npm", "bin", "npm-cli.js")],
    };
  }
  return { command: "npm", args: [] };
}

export async function upgradeCli(options: {
  runner?: UpgradeRunner;
  globalRoot?: () => Promise<string>;
  targetVersion?: string;
  onInstalled?: () => Promise<void>;
} = {}): Promise<void> {
  void options;
  throw new Error(
    `Automatic self-upgrade is disabled. Upgrade ${PACKAGE_NAME} with your package manager in the same installation scope.`,
  );
}
