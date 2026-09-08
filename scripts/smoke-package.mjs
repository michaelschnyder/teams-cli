import { mkdtemp, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { packArtifact } from "./package-artifact.mjs";
import { smokeInstalled } from "./smoke-installed.mjs";

const temporary = await mkdtemp(join(tmpdir(), "teams-package-smoke-"));
try {
  smokeInstalled(process.argv[2] ? resolve(process.argv[2]) : packArtifact(temporary));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
