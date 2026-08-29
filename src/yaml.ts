import { parseDocument } from "yaml";

export function parseStrictYaml(raw: string, label: string): unknown {
  const document = parseDocument(raw, {
    version: "1.2",
    uniqueKeys: true,
    merge: false,
    prettyErrors: true,
  });
  if (document.errors.length > 0) {
    throw new Error(`${label} is invalid YAML: ${document.errors[0]?.message ?? "unknown error"}`);
  }
  if (document.warnings.length > 0) {
    throw new Error(`${label} uses unsupported YAML: ${document.warnings[0]?.message ?? "unknown warning"}`);
  }
  try {
    return document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} uses unsupported YAML: ${detail}`);
  }
}

export function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function rejectUnknownKeys(
  object: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const unknown = Object.keys(object).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`${label} contains unknown field ${unknown}`);
}
