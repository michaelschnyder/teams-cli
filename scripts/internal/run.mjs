// @ts-check
/** @typedef {import("./promote.mjs").PromotionIO} PromotionIO */
import { PromotionError } from "./errors.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { packageName, registryUrl } from "../package-artifact.mjs";
import { syncSource, askpass, git } from "./sync-source.mjs";
import { reconcile } from "./promote.mjs";
import semver from "semver";
import { UPSTREAM_PACKAGE, UPSTREAM_REPOSITORY, verifyProvenance } from "./provenance.mjs";

const execute = promisify(execFile);
/** @param {string} binary @param {string[]} args @param {import("node:child_process").ExecFileOptions} [options] */
async function command(binary, args, options = {}) {
  try {
    return (
      await execute(binary, args, { timeout: 300000, maxBuffer: 8 * 1024 * 1024, ...options, encoding: "utf8" })
    ).stdout.trim();
  } catch {
    throw new PromotionError(`${binary} operation failed (output withheld to protect credentials)`);
  }
}
/** @param {NodeJS.ProcessEnv} environment */
export function configuration(environment) {
  const required = /** @type {const} */ ([
    "CI_API_V4_URL",
    "CI_PROJECT_ID",
    "CI_PROJECT_URL",
    "CI_PIPELINE_URL",
    "CI_JOB_TOKEN",
    "SYNC_TOKEN",
    "INTERNAL_NPM_REGISTRY",
    "PROMOTION_MIN_VERSION",
    "PROMOTION_SMOKE_IMAGE",
  ]);
  for (const key of required) {
    if (!environment[key]) throw new PromotionError(`Missing configuration: ${key}`);
  }
  const env = /** @type {NodeJS.ProcessEnv & Record<typeof required[number], string>} */ (environment);
  if (
    env.CI_COMMIT_BRANCH !== "main" ||
    env.CI_COMMIT_REF_PROTECTED !== "true" ||
    !["schedule", "web"].includes(env.CI_PIPELINE_SOURCE ?? "")
  )
    throw new PromotionError("Promotion requires a scheduled/manual protected main pipeline");
  if (!/^\d+$/.test(env.CI_PROJECT_ID)) throw new PromotionError("Invalid GitLab project ID");
  if (!semver.valid(env.PROMOTION_MIN_VERSION) || semver.prerelease(env.PROMOTION_MIN_VERSION))
    throw new PromotionError("Minimum version must be stable semver");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9./:@_-]*$/.test(env.PROMOTION_SMOKE_IMAGE))
    throw new PromotionError("Invalid smoke image reference");
  if (
    new URL(env.INTERNAL_NPM_REGISTRY).hostname === "registry.npmjs.org" ||
    env.INTERNAL_NPM_PACKAGE === UPSTREAM_PACKAGE
  )
    throw new PromotionError("Internal distribution must have a distinct package and internal registry");
  const api = registryUrl(env.CI_API_V4_URL);
  const projectUrl = registryUrl(env.CI_PROJECT_URL).replace(/\/$/, "");
  if (new URL(projectUrl).origin !== new URL(api).origin) throw new PromotionError("Project and API hosts differ");
  return {
    name: packageName(env.INTERNAL_NPM_PACKAGE ?? "@zuehlkelabs/teams-cli"),
    registry: registryUrl(env.INTERNAL_NPM_REGISTRY),
    publishRegistry: `${api}projects/${env.CI_PROJECT_ID}/packages/npm/`,
    receiptRoot: `${api}projects/${env.CI_PROJECT_ID}/packages/generic/teams-cli-promotions/`,
    minimum: env.PROMOTION_MIN_VERSION,
    pipelineUrl: env.CI_PIPELINE_URL,
    projectUrl,
    api,
    smokeImage: env.PROMOTION_SMOKE_IMAGE,
  };
}
/** @param {string} url @param {{ token?: string, missing?: boolean, method?: string, body?: string, bytes?: boolean }} [options] */
async function request(url, { token, missing = false, method = "GET", body, bytes = false } = {}) {
  const response = await fetch(url, {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(30000),
    headers: {
      ...(token ? { "JOB-TOKEN": token, Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body } : {}),
  });
  if (missing && response.status === 404) return null;
  if (!response.ok) throw new PromotionError(`Registry/API ${method} failed with status ${response.status}`);
  if (method === "PUT") {
    await response.arrayBuffer();
    return null;
  }
  if (bytes) {
    if (!response.body) throw new PromotionError("Artifact response has no body");
    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 25 * 1024 * 1024) {
        await reader.cancel();
        throw new PromotionError("Artifact exceeds download limit");
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  }
  return response.json();
}
/** @param {string | undefined} value */
function publicUrl(value) {
  if (!value) throw new PromotionError("Missing upstream artifact URL");
  const u = new URL(value);
  if (u.origin !== "https://registry.npmjs.org" || u.username || u.password)
    throw new PromotionError("Unexpected upstream artifact host");
  return u.href;
}
/** @param {NodeJS.ProcessEnv} [env] */
export async function main(env = process.env) {
  const config = configuration(env);
  const workspace = await mkdtemp(join(tmpdir(), "teams-promotion-"));
  try {
    const gitEnv = { ...env, SYNC_HOST: new URL(config.projectUrl).host, GIT_ASKPASS: await askpass(workspace) };
    const source = await syncSource({
      upstream: `${UPSTREAM_REPOSITORY}.git`,
      destination: `${config.projectUrl}.git`,
      directory: join(workspace, "source.git"),
      env: gitEnv,
    });
    const npmrc = join(workspace, "npmrc");
    const authPath = config.publishRegistry.replace(/^https:/, "");
    await writeFile(
      npmrc,
      `${config.name.split("/")[0]}:registry=${config.publishRegistry}\n${authPath}:_authToken=\${CI_JOB_TOKEN}\n`,
      { mode: 0o600 },
    );
    const npmEnv = {
      ...env,
      NPM_CONFIG_USERCONFIG: npmrc,
      NPM_CONFIG_GLOBALCONFIG: join(workspace, "empty-npmrc"),
      NPM_CONFIG_CACHE: join(workspace, "npm-cache"),
    };
    await writeFile(npmEnv.NPM_CONFIG_GLOBALCONFIG, "");
    /** @param {string[]} args */
    const npm = (args) =>
      command(
        "npm",
        [
          ...args,
          "--ignore-scripts",
          "--logs-max=0",
          "--fetch-retries=0",
          `--registry=${config.publishRegistry}`,
          `--${config.name.split("/")[0]}:registry=${config.publishRegistry}`,
        ],
        { cwd: workspace, env: npmEnv },
      );
    const inventory = async () =>
      (await request(`${config.publishRegistry}${encodeURIComponent(config.name)}`, {
        token: env.CI_JOB_TOKEN,
        missing: true,
      })) ?? { versions: {}, "dist-tags": {} };
    /** @type {PromotionIO} */
    const adapters = {
      verifyProvenance,
      publicInventory: () => request(`https://registry.npmjs.org/${encodeURIComponent(UPSTREAM_PACKAGE)}`),
      internalInventory: inventory,
      receipt: (version) =>
        request(`${config.receiptRoot}${encodeURIComponent(version)}/promotion.json`, {
          token: env.CI_JOB_TOKEN,
          missing: true,
        }),
      sourceCommit: async (version) => {
        const options = { cwd: source.directory, env: gitEnv };
        const commit = await git(["rev-parse", `refs/tags/v${version}^{commit}`], options);
        await git(["merge-base", "--is-ancestor", commit, "refs/heads/main"], options);
        return commit;
      },
      release: (version) => request(`https://api.github.com/repos/michaelschnyder/teams-cli/releases/tags/v${version}`),
      publicArtifact: (manifest) => request(publicUrl(manifest.dist.tarball), { bytes: true }),
      attestations: (manifest) => request(publicUrl(manifest.dist.attestations?.url)),
      internalArtifact: (manifest) => {
        const url = new URL(manifest.dist.tarball);
        if (!url.href.startsWith(config.publishRegistry) || url.username || url.password)
          throw new PromotionError("Unexpected internal artifact location");
        return request(url.href, { token: env.CI_JOB_TOKEN, bytes: true });
      },
      smoke: async (tarball) => {
        await command(
          process.execPath,
          [fileURLToPath(new URL("./smoke-container.mjs", import.meta.url)), tarball, config.smokeImage],
          {
            env: {
              PATH: env.PATH,
              HOME: env.HOME,
              DOCKER_HOST: env.DOCKER_HOST,
              DOCKER_TLS_VERIFY: env.DOCKER_TLS_VERIFY,
              DOCKER_CERT_PATH: env.DOCKER_CERT_PATH,
            },
          },
        );
      },
      publish: (file, tag) => npm(["publish", file, "--tag", tag, "--provenance=false"]),
      record: (version, value) =>
        request(`${config.receiptRoot}${encodeURIComponent(version)}/promotion.json`, {
          token: env.CI_JOB_TOKEN,
          method: "PUT",
          body: JSON.stringify(value),
        }),
      setLatest: (version) => npm(["dist-tag", "add", `${config.name}@${version}`, "latest"]),
      removeTag: (tag) => npm(["dist-tag", "rm", config.name, tag]),
    };
    await reconcile({ ...config, workspace }, adapters);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    // Tool/network errors can include URLs or child output. Do not print arbitrary error strings here.
    process.stderr.write(
      `Internal promotion failed (${error instanceof PromotionError ? error.message : "network or tool verification error"}). Run the documented configuration and access checks.\n`,
    );
    process.exitCode = 1;
  });
