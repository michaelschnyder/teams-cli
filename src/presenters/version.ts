import { stripVTControlCharacters } from "node:util";
import { PACKAGE_NAME, type BuildInfo } from "../version.js";
import type { UpdateChannel } from "../settings.js";
import type { UpdateCandidate } from "../update.js";
function safe(value: string): string {
  return stripVTControlCharacters(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

export function renderVersion(
  info: BuildInfo,
  channel: UpdateChannel,
  candidate: UpdateCandidate | null,
  updateStatus: "available" | "current" | "pinned" | "npx" | "disabled" | "unavailable" = candidate ? "available" : "current",
): string {
  const lines = [
    `Version: ${info.version}`,
    `Build channel: ${info.channel}`,
    `Update channel: ${channel}`,
  ];
  if (info.builtAt) lines.push(`Built: ${safe(info.builtAt)}`);
  if (info.source?.author) lines.push(`Source author: ${safe(info.source.author)}`);
  if (info.trigger?.actor) lines.push(`Workflow actor: ${safe(info.trigger.actor)}`);
  if (info.source?.branch) lines.push(`Branch: ${safe(info.source.branch)}`);
  if (info.source?.commit) lines.push(`Commit: ${safe(info.source.commit)}${info.source.commitUrl ? ` (${safe(info.source.commitUrl)})` : ""}`);
  if (info.source?.pullRequest) lines.push(`Pull request: #${info.source.pullRequest}${info.source.pullRequestUrl ? ` (${safe(info.source.pullRequestUrl)})` : ""}`);
  if (info.runner) {
    const runner = [info.runner.name, info.runner.os, info.runner.architecture].filter(Boolean).map((part) => safe(String(part))).join(" / ");
    if (runner) lines.push(`Runner: ${runner}`);
  }
  if (info.workflow?.url) lines.push(`Workflow: ${safe(info.workflow.url)}`);
  if (info.releaseNotes) {
    lines.push("", `Release notes: ${safe(info.releaseNotes.title)}`);
    if (info.releaseNotes.body.trim()) lines.push(safe(info.releaseNotes.body.trim()));
    if (info.releaseNotes.url) lines.push(safe(info.releaseNotes.url));
  }
  if (candidate) {
    lines.push("", `Update available: ${info.version} → ${candidate.version}`);
    if (candidate.summary?.title) lines.push(safe(candidate.summary.title));
    if (candidate.summary?.summary) lines.push(safe(candidate.summary.summary));
    if (candidate.summary?.url) lines.push(safe(candidate.summary.url));
    lines.push(
      `For a global npm installation, run \`teams-cli version --upgrade\`. Otherwise update through the package manager and installation scope that installed the CLI, targeting ${PACKAGE_NAME}@${candidate.version}.`,
    );
  } else if (updateStatus === "current") {
    lines.push("", "No update is currently available.");
  }
  return `${lines.join("\n")}\n`;
}
