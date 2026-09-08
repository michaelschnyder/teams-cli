import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import semver from "semver";
import { PACKAGE_NAME } from "./version.js";
import { npmInvocation, npmExecutor, registryArgs, type NpmInvocation, type NpmDestination } from "./npm.js";
export { npmInvocation, type NpmInvocation } from "./npm.js";

const PACKAGE_ROOT = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

export type UpgradeRunner = (command: string, args: readonly string[]) => Promise<number>;

type InstallationOptions = {
  npm?: NpmInvocation;
  globalRoot?: (npm: NpmInvocation) => Promise<string>;
  packageRoot?: string;
  canonicalize?: (path: string) => string;
  platform?: NodeJS.Platform;
};

export type UpgradeOptions = Omit<InstallationOptions, "npm"> & {
  pathExists?: (path: string) => boolean;
  destination: NpmDestination;
  targetVersion: string;
  runner?: UpgradeRunner;
  onInstalled?: () => Promise<void>;
};

export type GlobalNpmInstallation = {
  npm: NpmInvocation;
  globalRoot: string;
  packageRoot: string;
  installedCli: string;
};

async function defaultGlobalRoot(npm: NpmInvocation): Promise<string> {
  const root = await npmExecutor()(npm, ["root", "--global"]);
  if (!root) throw new Error("npm returned no global package root");
  return root;
}

function comparablePath(path: string, platform: NodeJS.Platform): string {
  const absolute = resolve(path);
  return platform === "win32" ? absolute.toLowerCase() : absolute;
}

export async function resolveGlobalNpmInstallation(options: InstallationOptions = {}): Promise<GlobalNpmInstallation> {
  const platform = options.platform ?? process.platform;
  const npm = options.npm ?? npmInvocation(platform);
  let globalRoot: string;
  try {
    globalRoot = await (options.globalRoot ?? defaultGlobalRoot)(npm);
  } catch {
    throw new Error("Cannot verify the npm global installation scope");
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

export async function canUpgradeCli(options: InstallationOptions = {}): Promise<boolean> {
  try {
    await resolveGlobalNpmInstallation(options);
    return true;
  } catch {
    return false;
  }
}

const defaultRunner: UpgradeRunner = (command, args) =>
  new Promise((resolveRun, reject) => {
    const child = spawn(command, [...args], {
      stdio: ["inherit", process.stderr, process.stderr],
      shell: false,
      windowsHide: true,
      cwd: homedir(),
      timeout: 180000,
    });
    child.once("error", reject);
    child.once("exit", (code) => resolveRun(code ?? 1));
  });

export async function upgradeCli(options: UpgradeOptions): Promise<void> {
  const { destination, targetVersion } = options;
  if (semver.valid(targetVersion) !== targetVersion) throw new Error("Upgrade requires an exact version");
  if (destination.packageName !== PACKAGE_NAME) throw new Error("Upgrade package identity mismatch");
  const installation = await resolveGlobalNpmInstallation({ ...options, npm: destination.npm });
  const runner = options.runner ?? defaultRunner;
  const installStatus = await runner(installation.npm.command, [
    ...installation.npm.args,
    "install",
    "--global",
    `${PACKAGE_NAME}@${targetVersion}`,
    ...registryArgs(PACKAGE_NAME, destination.registry),
    "--update-notifier=false",
  ]);
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
