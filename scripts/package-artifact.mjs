import { PromotionError } from "./internal/errors.mjs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, stat, cp } from "node:fs/promises";
import { join } from "node:path";
import * as tar from "tar";

export const TRANSFORMATION_REVISION = "1";
export const INSTALL_DOCS = new Set([
  "README.md",
  "docs/use/installation.md",
  "docs/use/commands.md",
  "docs/releasing.md",
]);
export function integrity(bytes) {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}
export function verifyIntegrity(bytes, expected) {
  if (typeof expected !== "string" || integrity(bytes) !== expected)
    throw new PromotionError("Artifact integrity mismatch");
}
export function packageName(name) {
  if (typeof name !== "string" || !/^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/.test(name))
    throw new PromotionError("Invalid scoped package name");
  return name;
}
export function registryUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
    throw new PromotionError("Invalid internal registry URL");
  return `${url.href.replace(/\/+$/, "")}/`;
}
export async function inspectArtifact(file) {
  if ((await stat(file)).size > 25 * 1024 * 1024) throw new PromotionError("Package archive is too large");
  const files = new Map();
  const seen = new Set();
  let size = 0;
  await tar.t({
    file,
    sync: true,
    strict: true,
    onReadEntry: (entry) => {
      const path = entry.path;
      const parts = path.replace(/\/$/, "").split("/");
      if (
        parts[0] !== "package" ||
        parts.some((p) => !p || p === "." || p === ".." || /[\\:\x00-\x1f]/.test(p) || /[. ]$/.test(p)) ||
        !["File", "Directory"].includes(entry.type) ||
        entry.mode & 0o7000
      )
        throw new PromotionError("Unsafe package archive entry");
      const key = path.replace(/\/$/, "").toLowerCase();
      if (seen.has(key)) throw new PromotionError("Duplicate package archive entry");
      seen.add(key);
      size += entry.size;
      if (size > 100 * 1024 * 1024 || seen.size > 5000) throw new PromotionError("Expanded package is too large");
      if (entry.type === "File") files.set(parts.slice(1).join("/"), { mode: entry.mode & 0o777, size: entry.size });
    },
  });
  for (const required of [
    "package.json",
    "dist/cli.js",
    "dist/build-info.json",
    "dist/skills/teams-cli/SKILL.md",
    "dist/skills/teams-cli/claude-cowork.md",
    "docs/use/assets/policy-editor.png",
    "docs/releasing.md",
    "README.md",
    "LICENSE",
  ]) {
    if (!files.has(required)) throw new PromotionError(`Package is missing ${required}`);
  }
  for (const path of files.keys()) {
    if (
      ![
        "package.json",
        "README.md",
        "SECURITY.md",
        "LICENSE",
        "docs/releasing.md",
        "docs/releasing-internal.md",
      ].includes(path) &&
      !path.startsWith("dist/") &&
      !path.startsWith("docs/use/")
    ) {
      throw new PromotionError("Package contains an unexpected file");
    }
  }
  if (!(files.get("dist/cli.js").mode & 0o111)) throw new PromotionError("CLI is not executable");
  return files;
}
export async function extractArtifact(file, directory) {
  const files = await inspectArtifact(file);
  await mkdir(directory, { recursive: true });
  await tar.x({ file, cwd: directory, strict: true, noChmod: false });
  const root = join(directory, "package");
  const metadata = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  packageName(metadata.name);
  if (
    metadata.bin?.["teams-cli"] !== "dist/cli.js" ||
    (await readFile(join(root, "dist/cli.js"), "utf8")).split("\n")[0] !== "#!/usr/bin/env node"
  )
    throw new PromotionError("Invalid CLI entrypoint");
  return { root, files, metadata, integrity: integrity(await readFile(file)) };
}
export function transformedMetadata(upstream, { name, registry, publishRegistry, upstreamIntegrity }) {
  if (upstream.teamsCli?.distribution) throw new PromotionError("Upstream is already a redistributed package");
  return {
    ...upstream,
    name: packageName(name),
    publishConfig: { registry: registryUrl(publishRegistry), provenance: false },
    teamsCli: {
      ...upstream.teamsCli,
      distribution: {
        schemaVersion: 1,
        registry: registryUrl(registry),
        upstream: { name: upstream.name, version: upstream.version, integrity: upstreamIntegrity },
        transformationRevision: TRANSFORMATION_REVISION,
      },
    },
  };
}
export async function transformArtifact(source, workspace, options) {
  if (source.integrity !== options.upstreamIntegrity) throw new PromotionError("Artifact integrity mismatch");
  const staged = join(workspace, "staged", "package");
  await cp(source.root, staged, { recursive: true, force: false, errorOnExist: true });
  // Only artifacts with the new updater are eligible, even if bootstrap configuration is mistaken.
  if (!source.files.has("dist/npm.js")) throw new PromotionError("Upstream predates distribution-aware updates");
  const metadata = transformedMetadata(source.metadata, options);
  await writeFile(join(staged, "package.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  for (const path of INSTALL_DOCS) {
    if (!source.files.has(path)) continue;
    const original = await readFile(join(source.root, path), "utf8");
    await writeFile(join(staged, path), original.replaceAll(source.metadata.name, options.name));
  }
  const file = join(workspace, "internal.tgz");
  await tar.c(
    {
      file,
      cwd: join(workspace, "staged"),
      gzip: true,
      portable: true,
      mtime: new Date(0),
      onWriteEntry: (entry) => {
        const original = source.files.get(entry.path.replaceAll("\\", "/").replace(/^package\//, ""));
        if (original && entry.stat) entry.stat.mode = (entry.stat.mode & ~0o777) | original.mode;
      },
    },
    ["package"],
  );
  await compareArtifact(source, file, join(workspace, "comparison"), options);
  return { file, metadata };
}
export async function compareArtifact(source, internalFile, workspace, options) {
  const internal = await extractArtifact(internalFile, join(workspace, "internal"));
  if (JSON.stringify([...source.files.keys()].sort()) !== JSON.stringify([...internal.files.keys()].sort()))
    throw new PromotionError("Distribution file inventory differs");
  const expected = transformedMetadata(source.metadata, options);
  if (JSON.stringify(internal.metadata) !== JSON.stringify(expected))
    throw new PromotionError("Distribution manifest differs");
  for (const [path, attributes] of source.files) {
    if ((attributes.mode & 0o111) !== (internal.files.get(path).mode & 0o111))
      throw new PromotionError("Distribution executable permissions differ");
    if (path === "package.json") continue;
    const original = await readFile(join(source.root, path));
    const actual = await readFile(join(internal.root, path));
    const wanted = INSTALL_DOCS.has(path)
      ? Buffer.from(original.toString("utf8").replaceAll(source.metadata.name, options.name))
      : original;
    if (!actual.equals(wanted)) throw new PromotionError(`Distribution payload differs: ${path}`);
  }
  return internal.metadata;
}

// All package commands pack the built payload without invoking lifecycle scripts.
export function packArtifact(directory) {
  if (!process.env.npm_execpath) throw new Error("Run package validation through npm");
  const packed = JSON.parse(execFileSync(process.execPath, [
    process.env.npm_execpath, "pack", "--json", "--ignore-scripts", "--pack-destination", directory,
  ], { encoding: "utf8", env: { ...process.env, npm_config_cache: join(directory, "npm-cache") } }));
  const { filename } = Array.isArray(packed) ? packed[0] : Object.values(packed)[0];
  return join(directory, filename);
}
