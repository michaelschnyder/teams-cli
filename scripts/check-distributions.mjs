import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { transformArtifact, extractArtifact, packArtifact } from "./package-artifact.mjs";
import { smokeInstalled } from "./smoke-installed.mjs";
const directory = await mkdtemp(join(tmpdir(), "teams-distributions-"));
try {
  const file = process.argv[2] ? resolve(process.argv[2]) : packArtifact(directory);
  const source = await extractArtifact(file, join(directory, "verified"));
  smokeInstalled(file);
  const result = await transformArtifact(source, directory, {
    name: "@zuehlkelabs/teams-cli",
    registry: "https://registry.example.invalid/npm/",
    publishRegistry: "https://registry.example.invalid/npm/",
    upstreamIntegrity: source.integrity,
  });
  smokeInstalled(result.file);
} finally {
  await rm(directory, { recursive: true, force: true });
}
