import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, win32 } from "node:path";
import { promisify } from "node:util";
import { PACKAGE_NAME } from "./version.js";

const execFileAsync = promisify(execFile);

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

const defaultRunner: UpgradeRunner = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, [...args], { stdio: "inherit", shell: false, windowsHide: true });
  child.once("error", reject);
  child.once("exit", (code) => resolve(code ?? 1));
});

export async function upgradeCli(options: {
  runner?: UpgradeRunner;
  globalRoot?: () => Promise<string>;
} = {}): Promise<void> {
  const runner = options.runner ?? defaultRunner;
  const npm = npmInvocation();
  const installStatus = await runner(npm.command, [...npm.args, "install", "--global", `${PACKAGE_NAME}@latest`]);
  if (installStatus !== 0) {
    throw new Error(`npm upgrade failed with exit code ${installStatus}`);
  }
  const globalRoot = options.globalRoot ?? (async () => {
    const { stdout } = await execFileAsync(npm.command, [...npm.args, "root", "--global"], {
      encoding: "utf8",
      windowsHide: true,
    });
    return stdout.trim();
  });
  const installedCli = join(await globalRoot(), ...PACKAGE_NAME.split("/"), "dist", "cli.js");
  if (!existsSync(installedCli) && !options.globalRoot) {
    throw new Error(`The updated CLI was not found at ${installedCli}`);
  }
  const reinstallStatus = await runner(process.execPath, [installedCli, "skills", "reinstall"]);
  if (reinstallStatus !== 0) {
    throw new Error(`The CLI was upgraded, but skill reinstallation failed with exit code ${reinstallStatus}`);
  }
}
