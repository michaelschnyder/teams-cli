import { configurationKey, type RegistryClient } from "../src/npm.js";
import { PACKAGE_NAME } from "../src/version.js";

export async function fakeRegistry(manifest: RegistryClient["manifest"]): Promise<RegistryClient> {
  return {
    packageName: PACKAGE_NAME,
    registry: "https://registry.npmjs.org/",
    npm: { command: "npm", args: [] },
    configFiles: [],
    configurationKey: await configurationKey([]),
    manifest,
  };
}
