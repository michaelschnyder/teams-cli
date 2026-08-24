import { readFile } from "node:fs/promises";
import type { StoragePaths } from "./storage.js";

export type Guardrails = { chats: string[]; channels: string[] };
export type MessageTarget = { kind: "chat" | "channel"; id: string };

export function parseGuardrails(value: unknown): Guardrails {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Guardrails file is invalid");
  }
  const object = value as Record<string, unknown>;
  if (
    Object.keys(object).some((key) => key !== "chats" && key !== "channels") ||
    !Array.isArray(object.chats) || !object.chats.every((item) => typeof item === "string") ||
    !Array.isArray(object.channels) || !object.channels.every((item) => typeof item === "string")
  ) {
    throw new Error("Guardrails file must contain only string arrays named chats and channels");
  }
  return { chats: object.chats, channels: object.channels };
}

export function isTargetAllowed(guardrails: Guardrails, target: MessageTarget): boolean {
  return (target.kind === "chat" ? guardrails.chats : guardrails.channels).includes(target.id);
}

export async function requireAllowedTarget(
  paths: StoragePaths,
  target: MessageTarget,
): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(paths.guardrailsFile, "utf8");
  } catch {
    throw new Error(`Message send denied: cannot read ${paths.guardrailsFile}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Message send denied: ${paths.guardrailsFile} is not valid JSON`);
  }
  let guardrails: Guardrails;
  try {
    guardrails = parseGuardrails(parsed);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Message send denied: ${detail}`);
  }
  if (!isTargetAllowed(guardrails, target)) {
    throw new Error(`Message send denied: ${target.kind} ${target.id} is not allowlisted`);
  }
}
