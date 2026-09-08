// @ts-check
/**
 * @typedef {{ name: string, version: string, deprecated?: string, dist: { integrity: string, tarball: string, attestations?: { url: string } } }} Manifest
 * @typedef {{ versions: Record<string, Manifest>, "dist-tags": Record<string, string> }} Inventory
 * @typedef {{ schemaVersion: 1, packageName: string, version: string, upstreamIntegrity: string, internalIntegrity: string, commit: string, transformationRevision: string, pipelineUrl: string }} Receipt
 * @typedef {{ name: string, registry: string, publishRegistry: string, minimum: string, pipelineUrl: string, workspace: string }} PromotionConfig
 * @typedef {{ draft: boolean, prerelease: boolean, published_at: string | null, tag_name: string }} Release
 * @typedef {object} PromotionIO
 * @property {() => Promise<Inventory>} publicInventory
 * @property {() => Promise<Inventory>} internalInventory
 * @property {(version: string) => Promise<Receipt | null>} receipt
 * @property {(version: string) => Promise<string>} sourceCommit
 * @property {(version: string) => Promise<Release>} release
 * @property {(manifest: Manifest) => Promise<Buffer>} publicArtifact
 * @property {(manifest: Manifest) => Promise<unknown>} attestations
 * @property {(manifest: Manifest) => Promise<Buffer>} internalArtifact
 * @property {(file: string) => Promise<void>} smoke
 * @property {(file: string, tag: string) => Promise<unknown>} publish
 * @property {(version: string, receipt: Receipt) => Promise<unknown>} record
 * @property {(version: string) => Promise<unknown>} setLatest
 * @property {(tag: string) => Promise<unknown>} removeTag
 * @property {(attestations: unknown, bytes: Buffer, version: string, commit: string) => Promise<void>} verifyProvenance
 */
import { PromotionError } from "./errors.mjs";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import semver from "semver";
import {
  compareArtifact,
  transformArtifact,
  extractArtifact,
  integrity,
  verifyIntegrity,
  TRANSFORMATION_REVISION,
} from "../package-artifact.mjs";
import { UPSTREAM_PACKAGE } from "./provenance.mjs";

/** @param {{ versions: Record<string, { deprecated?: string }> }} inventory @param {string} minimum */
export function eligibleVersions(inventory, minimum) {
  if (!semver.valid(minimum) || semver.prerelease(minimum))
    throw new PromotionError("Minimum version must be stable semver");
  return Object.keys(inventory.versions ?? {})
    .filter(
      (v) =>
        semver.valid(v) === v && !semver.prerelease(v) && semver.gte(v, minimum) && !inventory.versions[v].deprecated,
    )
    .sort(semver.compare);
}
/** @param {Receipt | null} receipt @param {Manifest | undefined} manifest @param {Manifest} upstream @param {PromotionConfig} config */
export function validateReceipt(receipt, manifest, upstream, config) {
  if (
    receipt?.schemaVersion !== 1 ||
    receipt.version !== upstream.version ||
    receipt.packageName !== config.name ||
    receipt.upstreamIntegrity !== upstream.dist?.integrity ||
    receipt.internalIntegrity !== manifest?.dist?.integrity ||
    receipt.transformationRevision !== TRANSFORMATION_REVISION ||
    typeof receipt.commit !== "string" ||
    typeof receipt.pipelineUrl !== "string"
  )
    throw new PromotionError("Existing promotion receipt conflicts with registry content");
}

// All writes are behind injected adapters. Verification failures cannot reach publish/record/tag.
/** @param {PromotionConfig} config @param {PromotionIO} io */
export async function reconcile(config, io) {
  const upstream = await io.publicInventory();
  const eligible = eligibleVersions(upstream, config.minimum);
  let internalInventory = await io.internalInventory();
  let writes = 0;
  for (const version of eligible) {
    const manifest = upstream.versions[version];
    if (manifest.name !== UPSTREAM_PACKAGE || manifest.version !== version || !manifest.dist?.integrity)
      throw new PromotionError("Invalid upstream manifest");
    let existing = internalInventory.versions[version];
    const receipt = await io.receipt(version);
    if (existing && receipt) {
      validateReceipt(receipt, existing, manifest, config);
      continue;
    }
    if (receipt && !existing) throw new PromotionError("Published artifact recorded in receipt is missing");
    const directory = await mkdtemp(join(config.workspace, "version-"));
    try {
      const commit = await io.sourceCommit(version);
      const release = await io.release(version);
      if (
        release.draft !== false ||
        release.prerelease !== false ||
        !release.published_at ||
        release.tag_name !== `v${version}`
      )
        throw new PromotionError("Matching published stable GitHub release is missing");
      const bytes = await io.publicArtifact(manifest);
      verifyIntegrity(bytes, manifest.dist.integrity);
      await io.verifyProvenance(await io.attestations(manifest), bytes, version, commit);
      const sourceFile = join(directory, "upstream.tgz");
      await writeFile(sourceFile, bytes);
      const verified = await extractArtifact(sourceFile, join(directory, "verified"));
      const build = JSON.parse(await readFile(join(verified.root, "dist/build-info.json"), "utf8"));
      if (
        verified.metadata.name !== UPSTREAM_PACKAGE ||
        verified.metadata.version !== version ||
        !verified.files.has("dist/npm.js") ||
        build.version !== version ||
        build.source?.commit !== commit ||
        build.channel !== "stable"
      )
        throw new PromotionError(
          "Embedded package/build metadata differs from verified source or predates internal updates",
        );
      const options = {
        name: config.name,
        registry: config.registry,
        publishRegistry: config.publishRegistry,
        upstreamIntegrity: manifest.dist.integrity,
      };
      let internalBytes;
      if (existing) {
        internalBytes = await io.internalArtifact(existing);
        verifyIntegrity(internalBytes, existing.dist?.integrity);
        const file = join(directory, "existing.tgz");
        await writeFile(file, internalBytes);
        await compareArtifact(verified, file, join(directory, "existing-comparison"), options);
        await io.smoke(file);
      } else {
        const transformed = await transformArtifact(verified, directory, options);
        await io.smoke(transformed.file);
        internalBytes = await readFile(transformed.file);
        internalInventory = await io.internalInventory();
        existing = internalInventory.versions[version];
        if (existing) throw new PromotionError("Package appeared during promotion; retry without overwriting");
        await io.publish(transformed.file, `promotion-${version}`);
        writes++;
        internalInventory = await io.internalInventory();
        existing = internalInventory.versions[version];
        if (!existing) throw new PromotionError("Published package is not visible yet");
        verifyIntegrity(await io.internalArtifact(existing), integrity(internalBytes));
      }
      /** @type {Receipt} */
      const result = {
        schemaVersion: 1,
        packageName: config.name,
        version,
        upstreamIntegrity: manifest.dist.integrity,
        internalIntegrity: integrity(internalBytes),
        commit,
        transformationRevision: TRANSFORMATION_REVISION,
        pipelineUrl: config.pipelineUrl,
      };
      validateReceipt(result, existing, manifest, config);
      await io.record(version, result);
      const saved = await io.receipt(version);
      if (JSON.stringify(saved) !== JSON.stringify(result))
        throw new PromotionError("Promotion receipt readback failed");
      writes++;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  // Re-read upstream and internal channel state after uploads, including on tag-only retries.
  const latestPublic = await io.publicInventory();
  const target = latestPublic["dist-tags"]?.latest;
  if (eligibleVersions(latestPublic, config.minimum).includes(target)) {
    internalInventory = await io.internalInventory();
    const internal = internalInventory.versions[target];
    const receipt = await io.receipt(target);
    if (!internal || !receipt) throw new PromotionError("Stable channel target has not completed promotion; retry");
    validateReceipt(receipt, internal, latestPublic.versions[target], config);
    const tags = internalInventory["dist-tags"];
    if (!tags.latest || (semver.valid(tags.latest) && semver.gt(target, tags.latest))) {
      await io.setLatest(target);
      writes++;
    }
    for (const [tag, version] of Object.entries(tags)) {
      if (tag !== `promotion-${version}` || !eligible.includes(version)) continue;
      const recorded = await io.receipt(version);
      if (recorded) {
        await io.removeTag(tag);
        writes++;
      }
    }
  }
  return { writes };
}
