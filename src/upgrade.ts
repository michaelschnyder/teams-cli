import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { PACKAGE_NAME } from "./version.js";

const execFileAsync = promisify(execFile);

export type UpgradeRunner = (command: string, args: readonly string[]) => Promise<number>;

export function npmExecutable(platform = process.platform): string {
  return platform === "win32" ? "npm.cmd" : "npm";
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
  const npm = npmExecutable();
  const installStatus = await runner(npm, ["install", "--global", `${PACKAGE_NAME}@latest`]);
  if (installStatus !== 0) {
    throw new Error(`npm upgrade failed with exit code ${installStatus}`);
  }
  const globalRoot = options.globalRoot ?? (async () => {
    const { stdout } = await execFileAsync(npm, ["root", "--global"], { encoding: "utf8", windowsHide: true });
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
