import { createRequire } from "node:module";

type PackageMetadata = { name?: unknown; version?: unknown };

const metadata = createRequire(import.meta.url)("../package.json") as PackageMetadata;

if (typeof metadata.name !== "string" || typeof metadata.version !== "string") {
  throw new Error("Installed package metadata is invalid");
}

export const PACKAGE_NAME = metadata.name;
export const CLI_VERSION = metadata.version;
