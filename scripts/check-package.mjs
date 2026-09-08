import { mkdtemp, rm } from "node:fs/promises";
import { resolve, join, basename } from "node:path";
import { tmpdir } from "node:os";
import { extractArtifact, packArtifact } from "./package-artifact.mjs";

const temporary = await mkdtemp(join(tmpdir(), "teams-package-check-"));
try {
  const file = process.argv[2] ? resolve(process.argv[2]) : packArtifact(temporary);
  const result = await extractArtifact(file, join(temporary, "extracted"));
  process.stdout.write(`Validated ${basename(file)} with ${result.files.size} files.\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
