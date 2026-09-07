import type { StoredSession } from "../storage.js";

type Cursor =
  | { version: 1; kind: "chats"; tenantId: string; syncToken: string; }
  | { version: 1; kind: "messages"; tenantId: string; chatId: string; url: string; };

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeCursor(encoded: string): Cursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid paging cursor");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("Invalid paging cursor");
  const cursor = parsed as Partial<Cursor>;
  if (cursor.version !== 1 || (cursor.kind !== "chats" && cursor.kind !== "messages")) {
    throw new Error("Unsupported paging cursor");
  }
  if (typeof cursor.tenantId !== "string") throw new Error("Invalid paging cursor");
  if (cursor.kind === "chats" && typeof cursor.syncToken === "string") return cursor as Cursor;
  if (
    cursor.kind === "messages" &&
    typeof cursor.chatId === "string" &&
    typeof cursor.url === "string"
  ) return cursor as Cursor;
  throw new Error("Invalid paging cursor");
}

export function requireCursorTenant(cursor: Cursor, session: StoredSession): void {
  if (cursor.tenantId !== session.tenantId) {
    throw new Error("Paging cursor belongs to a different Teams tenant");
  }
}
