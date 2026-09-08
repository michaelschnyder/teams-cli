import { PromotionError } from "./errors.mjs";
import { createHash } from "node:crypto";
import { verify } from "sigstore";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const UPSTREAM_PACKAGE = "@michaelschnyder/teams-cli";
export const UPSTREAM_REPOSITORY = "https://github.com/michaelschnyder/teams-cli";
export const WORKFLOW = ".github/workflows/publish-npm.yml";
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** @param {(bundle: import("sigstore").Bundle, options: import("sigstore").VerifyOptions) => Promise<unknown>} [verifier] */
export async function verifyProvenance(attestations, bytes, version, commit, verifier = verify) {
  const attestation = attestations?.attestations?.find((a) => a.predicateType === "https://slsa.dev/provenance/v1");
  if (!attestation?.bundle?.dsseEnvelope) throw new PromotionError("Required upstream provenance is missing");
  const cache = await mkdtemp(join(tmpdir(), "teams-provenance-"));
  try {
    await verifier(attestation.bundle, {
      tufCachePath: cache,
      certificateIssuer: "https://token.actions.githubusercontent.com",
      certificateIdentityURI: `^${escape(`${UPSTREAM_REPOSITORY}/${WORKFLOW}@refs/tags/v${version}`)}$`,
      retry: 0,
      timeout: 10000,
    });
  } catch {
    throw new PromotionError("Upstream signature or transparency verification failed");
  } finally {
    await rm(cache, { recursive: true, force: true });
  }
  const statement = JSON.parse(Buffer.from(attestation.bundle.dsseEnvelope.payload, "base64").toString("utf8"));
  const subject = statement.subject;
  const definition = statement.predicate?.buildDefinition;
  const workflow = definition?.externalParameters?.workflow;
  const digest = createHash("sha512").update(bytes).digest("hex");
  if (
    statement.predicateType !== "https://slsa.dev/provenance/v1" ||
    subject?.length !== 1 ||
    subject[0].name !== `pkg:npm/${UPSTREAM_PACKAGE.replace("@", "%40")}@${version}` ||
    subject[0].digest?.sha512 !== digest ||
    workflow?.repository !== UPSTREAM_REPOSITORY ||
    workflow.path !== WORKFLOW ||
    workflow.ref !== `refs/tags/v${version}` ||
    definition?.internalParameters?.github?.event_name !== "release" ||
    !definition.resolvedDependencies?.some(
      (dependency) =>
        dependency.uri === `git+${UPSTREAM_REPOSITORY}@refs/tags/v${version}` &&
        dependency.digest?.gitCommit === commit,
    )
  ) {
    throw new PromotionError("Upstream provenance identity, source, or artifact mismatch");
  }
}
