import type { MessageTarget } from "./policy.js";
import type { Identity } from "./storage.js";
export function parsePageSize(raw: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 200) {
    throw new Error("--page-size must be an integer from 1 to 200");
  }
  return value;
}

export type TargetOptions = { chat?: string; channel?: string; };
export type SendTargetOptions = TargetOptions & { person?: string; };

export function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function selectedTarget(options: TargetOptions): MessageTarget {
  if ((options.chat ? 1 : 0) + (options.channel ? 1 : 0) !== 1) {
    throw new Error("Exactly one of --chat or --channel is required");
  }
  return options.chat
    ? { kind: "chat", id: options.chat }
    : { kind: "channel", id: options.channel as string };
}

export function selectedSendTarget(options: SendTargetOptions): MessageTarget | string {
  if ((options.chat ? 1 : 0) + (options.channel ? 1 : 0) + (options.person ? 1 : 0) !== 1) {
    throw new Error("Exactly one of --person, --chat, or --channel is required");
  }
  return options.person ?? selectedTarget(options);
}

export function resolvePolicyMessageTarget(
  identity: Identity,
  target: MessageTarget,
): MessageTarget {
  if (target.kind === "channel" || target.category) return target;
  const encodedPeople = /^19:([^_@]+)_([^@]+)@unq\.gbl\.spaces$/i.exec(target.id)?.slice(1);
  if (!encodedPeople) return { ...target, category: "group" };
  const personIds = [...new Set(encodedPeople.flatMap((value) => {
    const decoded = decodeURIComponent(value);
    const objectId = decoded.startsWith("8:orgid:") ? decoded.slice("8:orgid:".length) : decoded;
    return objectId === identity.userId ? [] : [decoded, objectId, `8:orgid:${objectId}`];
  }))];
  return { ...target, category: "person", personIds };
}

export async function messageBody(body: string | undefined): Promise<string> {
  let value = body;
  if (value === undefined) {
    if (process.stdin.isTTY) throw new Error("Provide --body or pipe a message on stdin");
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    value = Buffer.concat(chunks).toString("utf8");
  }
  if (!value.trim()) throw new Error("Message body must not be empty");
  return value;
}
