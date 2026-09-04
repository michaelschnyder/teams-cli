import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packageMetadata = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
let buildInfo = {
  schemaVersion: 1,
  version: packageMetadata.version,
  channel: /-canary(?:\.|$)/.test(packageMetadata.version)
    ? "canary"
    : /-snapshot(?:\.|$)/.test(packageMetadata.version) ? "snapshot" : "local",
  trigger: { kind: "local" },
};

if (process.env.TEAMS_CLI_BUILD_INFO_FILE) {
  const prepared = JSON.parse(readFileSync(process.env.TEAMS_CLI_BUILD_INFO_FILE, "utf8"));
  if (prepared.schemaVersion !== 1 || prepared.version !== packageMetadata.version) {
    throw new Error("Prepared build metadata does not match package.json");
  }
  buildInfo = prepared;
}

mkdirSync(join(root, "dist"), { recursive: true });
writeFileSync(join(root, "dist", "build-info.json"), `${JSON.stringify(buildInfo, null, 2)}\n`, "utf8");
