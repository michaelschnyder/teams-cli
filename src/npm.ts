import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { win32 } from "node:path";
import { PACKAGE_NAME, DISTRIBUTION } from "./version.js";

const execute = promisify(execFile);
export type NpmInvocation = { command: string; args: readonly string[] };
export type NpmExecutor = (npm: NpmInvocation, args: readonly string[]) => Promise<string>;
export type NpmDestination = { packageName: string; registry: string; npm: NpmInvocation };
export type RegistryClient = NpmDestination & {
  configFiles: string[];
  configurationKey: string;
  manifest: (tag: string) => Promise<unknown | null>;
};

export function npmInvocation(
  platform = process.platform,
  node = process.execPath,
  npmPath: string | null | undefined = process.env.npm_execpath,
): NpmInvocation {
  if (npmPath) return { command: node, args: [npmPath] };
  if (platform === "win32")
    return { command: node, args: [win32.join(win32.dirname(node), "node_modules", "npm", "bin", "npm-cli.js")] };
  return { command: "npm", args: [] };
}

export function registryUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid npm registry URL");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  ) {
    throw new Error("npm registry must use HTTPS without embedded credentials, query, or fragment");
  }
  return `${url.href.replace(/\/+$/, "")}/`;
}

function packageScope(name: string): string {
  if (!/^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/.test(name)) throw new Error("Expected a scoped npm package name");
  return name.split("/")[0]!;
}

export function registryArgs(name: string, registry: string): string[] {
  return [`--${packageScope(name)}:registry=${registry}`];
}

// Never surface npm's raw stderr: it can contain credentials and registry responses.
export function npmExecutor(environment: NodeJS.ProcessEnv = process.env): NpmExecutor {
  return async (npm, args) => {
    try {
      const result = await execute(npm.command, [...npm.args, ...args, "--update-notifier=false"], {
        cwd: homedir(),
        env: environment,
        encoding: "utf8",
        shell: false,
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      return result.stdout.trim();
    } catch (error) {
      const output = (error as { stdout?: string }).stdout;
      let code: unknown;
      try {
        code = JSON.parse(output ?? "{}").error?.code;
      } catch {
        /* sanitized below */
      }
      if (code === "E404") throw new Error("NPM_NOT_FOUND");
      throw new Error("npm operation failed; check registry access and npm configuration");
    }
  };
}

export async function configurationKey(
  files: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const hash = createHash("sha256");
  hash.update(JSON.stringify([process.execPath, PACKAGE_NAME, DISTRIBUTION]));
  const names = new Set(
    Object.keys(environment).filter((key) =>
      /^(npm_|node_|https?_proxy$|all_proxy$|no_proxy$|path$|home$|userprofile$|appdata$|localappdata$|systemroot$|comspec$|teams_cli_update_channel$)/i.test(
        key,
      ),
    ),
  );
  for (const file of files) {
    hash.update(file);
    try {
      const contents = await readFile(file, "utf8");
      hash.update(contents);
      for (const match of contents.matchAll(/\$\{([A-Za-z_][A-Za-z_0-9]*)\}/g)) names.add(match[1]!);
    } catch {
      hash.update("missing");
    }
  }
  for (const key of [...names].sort()) hash.update(`${key}\0${environment[key] ?? ""}\0`);
  return hash.digest("hex");
}

export async function resolveRegistry(
  options: {
    packageName?: string;
    registry?: string;
    npm?: NpmInvocation;
    execute?: NpmExecutor;
    environment?: NodeJS.ProcessEnv;
  } = {},
): Promise<RegistryClient> {
  const name = options.packageName ?? PACKAGE_NAME;
  const scopeName = packageScope(name);
  const expected = options.registry ?? DISTRIBUTION?.registry;
  const npm =
    options.npm ?? npmInvocation(process.platform, process.execPath, (options.environment ?? process.env).npm_execpath);
  const run = options.execute ?? npmExecutor(options.environment);
  const get = async (key: string) => {
    const value = await run(npm, ["config", "get", key, "--global"]);
    return value === "undefined" || value === "null" ? "" : value;
  };
  const scope = await get(`${scopeName}:registry`);
  if (expected && scope && registryUrl(scope) !== registryUrl(expected)) {
    throw new Error("The npm scope registry conflicts with this distribution's registry");
  }
  const registry = registryUrl(expected ?? (scope || (await get("registry"))));
  const configFiles = (await Promise.all([get("userconfig"), get("globalconfig")])).filter(Boolean);
  const key = await configurationKey(configFiles, options.environment);
  return {
    packageName: name,
    registry,
    npm,
    configFiles,
    configurationKey: key,
    manifest: async (tag) => {
      try {
        const value: unknown = JSON.parse(
          await run(npm, [
            "view",
            `${name}@${tag}`,
            "--json",
            "--global",
            "--prefer-online",
            "--fetch-retries=0",
            "--fetch-timeout=5000",
            "--logs-max=0",
            ...registryArgs(name, registry),
          ]),
        );
        if (Array.isArray(value)) {
          if (value.length !== 1) throw new Error("npm returned an ambiguous version selection");
          return value[0];
        }
        return value;
      } catch (error) {
        if (tag === "canary" && error instanceof Error && error.message === "NPM_NOT_FOUND") return null;
        throw error;
      }
    },
  };
}
