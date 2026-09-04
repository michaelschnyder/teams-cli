import { execFile, spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PACKAGE_NAME } from "./version.js";

const execFileAsync = promisify(execFile);
const PACKAGE_ROOT = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

export type UpgradeRunner = (command: string, args: readonly string[]) => Promise<number>;

export type NpmInvocation = { command: string; args: readonly string[] };

export type UpgradeOptions = {
  runner?: UpgradeRunner;
  npm?: NpmInvocation;
  globalRoot?: (npm: NpmInvocation) => Promise<string>;
  packageRoot?: string;
  canonicalize?: (path: string) => string;
  pathExists?: (path: string) => boolean;
  platform?: NodeJS.Platform;
  targetVersion?: string;
  onInstalled?: () => Promise<void>;
};

export type GlobalNpmInstallation = {
  npm: NpmInvocation;
  globalRoot: string;
  packageRoot: string;
  installedCli: string;
};

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

async function defaultGlobalRoot(npm: NpmInvocation): Promise<string> {
  const { stdout } = await execFileAsync(npm.command, [...npm.args, "root", "--global"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const root = stdout.trim();
  if (!root) throw new Error("npm returned no global package root");
  return root;
}

function comparablePath(path: string, platform: NodeJS.Platform): string {
  const absolute = resolve(path);
  return platform === "win32" ? absolute.toLowerCase() : absolute;
}

export async function resolveGlobalNpmInstallation(options: UpgradeOptions = {}): Promise<GlobalNpmInstallation> {
  const platform = options.platform ?? process.platform;
  const npm = options.npm ?? npmInvocation(platform);
  let globalRoot: string;
  try {
    globalRoot = await (options.globalRoot ?? defaultGlobalRoot)(npm);
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(`Cannot verify the npm global installation scope${detail}`);
  }

  const packageRoot = options.packageRoot ?? PACKAGE_ROOT;
  const expectedRoot = join(globalRoot, ...PACKAGE_NAME.split("/"));
  const canonicalize = options.canonicalize ?? realpathSync;
  let actual: string;
  let expected: string;
  try {
    actual = canonicalize(packageRoot);
    expected = canonicalize(expectedRoot);
  } catch {
    throw new Error("Cannot verify that this teams-cli package belongs to npm's global installation scope");
  }
  if (comparablePath(actual, platform) !== comparablePath(expected, platform)) {
    throw new Error(
      "Automatic upgrade is available only for a global npm installation managed by the active npm executable. " +
      "Update this package through the package manager and installation scope that installed it.",
    );
  }

  return {
    npm,
    globalRoot,
    packageRoot: actual,
    installedCli: join(expectedRoot, "dist", "cli.js"),
  };
}

export async function canUpgradeCli(options: UpgradeOptions = {}): Promise<boolean> {
  try {
    await resolveGlobalNpmInstallation(options);
    return true;
  } catch {
    return false;
  }
}

const defaultRunner: UpgradeRunner = (command, args) => new Promise((resolveRun, reject) => {
  const child = spawn(command, [...args], { stdio: "inherit", shell: false, windowsHide: true });
  child.once("error", reject);
  child.once("exit", (code) => resolveRun(code ?? 1));
});

export async function upgradeCli(options: UpgradeOptions = {}): Promise<void> {
  const installation = await resolveGlobalNpmInstallation(options);
  const runner = options.runner ?? defaultRunner;
  const targetVersion = options.targetVersion ?? "latest";
  const installStatus = await runner(
    installation.npm.command,
    [...installation.npm.args, "install", "--global", `${PACKAGE_NAME}@${targetVersion}`],
  );
  if (installStatus !== 0) throw new Error(`npm upgrade failed with exit code ${installStatus}`);

  if (!(options.pathExists ?? existsSync)(installation.installedCli)) {
    throw new Error(`The updated CLI was not found at ${installation.installedCli}`);
  }
  await options.onInstalled?.();
  const reinstallStatus = await runner(process.execPath, [installation.installedCli, "skills", "reinstall"]);
  if (reinstallStatus !== 0) {
    throw new Error(`The CLI was upgraded, but skill reinstallation failed with exit code ${reinstallStatus}`);
  }
}
