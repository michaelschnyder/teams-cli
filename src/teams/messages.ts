import { observedFetch } from "../diagnostics.js";
import { readJwtMetadata } from "../jwt.js";
import type { MessageTarget } from "../policy.js";
import type { StoredSession } from "../storage.js";

import { decodeCursor, encodeCursor, requireCursorTenant } from "./cursors.js";
import { jsonResponse, stringValue, TeamsApiError } from "./transport.js";
import type { MessagePage, MessagePageOptions, MessageResult, MessageSendResult, MessageSummary } from "./types.js";

type RawMessage = Record<string, unknown> & {
  id?: unknown;
  conversationid?: unknown;
  sequenceId?: unknown;
  version?: unknown;
  type?: unknown;
  messagetype?: unknown;
  contenttype?: unknown;
  content?: unknown;
  from?: unknown;
  imdisplayname?: unknown;
  composetime?: unknown;
  originalarrivaltime?: unknown;
  properties?: unknown;
};

function normalizeMessage(value: unknown, fallbackChatId: string): MessageSummary | null {
  if (!value || typeof value !== "object") return null;
  const message = value as RawMessage;
  const id = stringValue(message.id);
  if (!id) return null;
  const properties = message.properties && typeof message.properties === "object" &&
    !Array.isArray(message.properties)
    ? message.properties as Record<string, unknown>
    : {};
  const numericOrString = (input: unknown): number | string | null =>
    typeof input === "number" || typeof input === "string" ? input : null;
  return {
    id,
    chatId: stringValue(message.conversationid) ?? fallbackChatId,
    sequenceId: numericOrString(message.sequenceId),
    version: numericOrString(message.version),
    type: stringValue(message.type),
    messageType: stringValue(message.messagetype),
    contentType: stringValue(message.contenttype),
    content: typeof message.content === "string" ? message.content : null,
    sender: {
      id: stringValue(message.from),
      displayName: stringValue(message.imdisplayname),
    },
    composedAt: stringValue(message.composetime),
    originalArrivalAt: stringValue(message.originalarrivaltime),
    properties,
  };
}

function messagePath(chatId: string): string {
  return `/v1/users/ME/conversations/${encodeURIComponent(chatId)}/messages`;
}

function initialMessageUrl(session: StoredSession, chatId: string, options: MessagePageOptions): URL {
  const url = new URL(messagePath(chatId), session.endpoints.chatService);
  url.searchParams.set("view", "msnp24Equivalent|supportsMessageProperties");
  url.searchParams.set("pageSize", String(options.pageSize ?? 200));
  url.searchParams.set("startTime", "1");
  return url;
}

function continuedMessageUrl(session: StoredSession, chatId: string, encoded: string): URL {
  const cursor = decodeCursor(encoded);
  if (cursor.kind !== "messages") throw new Error("Expected a message paging cursor");
  requireCursorTenant(cursor, session);
  if (cursor.chatId !== chatId) throw new Error("Paging cursor belongs to a different chat");
  const url = new URL(cursor.url);
  const endpoint = new URL(session.endpoints.chatService);
  if (url.protocol !== "https:" || url.origin !== endpoint.origin) {
    throw new Error("Message paging cursor points to an untrusted host");
  }
  if (decodeURIComponent(url.pathname) !== decodeURIComponent(messagePath(chatId))) {
    throw new Error("Message paging cursor has an invalid path");
  }
  return url;
}

export async function listMessages(
  session: StoredSession,
  target: MessageTarget,
  options: MessagePageOptions,
  fetchImplementation: typeof fetch = fetch,
  authorize: () => Promise<void> = async () => undefined,
): Promise<MessagePage> {
  const url = options.cursor
    ? continuedMessageUrl(session, target.id, options.cursor)
    : initialMessageUrl(session, target.id, options);
  await authorize();
  const response = await observedFetch(fetchImplementation, url, {
    headers: {
      authentication: `skypetoken=${session.skypeToken.value}`,
      accept: "application/json",
    },
  });
  const payload = await jsonResponse(response, "Message listing", "skype") as {
    messages?: unknown;
    _metadata?: { backwardLink?: unknown; };
  };
  const messages = Array.isArray(payload.messages)
    ? payload.messages
      .map((message) => normalizeMessage(message, target.id))
      .filter((message): message is MessageSummary => message !== null)
    : [];
  const backwardLink = stringValue(payload._metadata?.backwardLink);
  const nextCursor = backwardLink
    ? encodeCursor({
      version: 1,
      kind: "messages",
      tenantId: session.tenantId,
      chatId: target.id,
      url: backwardLink,
    })
    : null;
  return { target, messages, page: { nextCursor } };
}

export async function getMessage(
  session: StoredSession,
  target: MessageTarget,
  messageId: string,
  fetchImplementation: typeof fetch = fetch,
  authorize: () => Promise<void> = async () => undefined,
): Promise<MessageResult> {
  const url = new URL(
    `${messagePath(target.id)}/${encodeURIComponent(messageId)}`,
    session.endpoints.chatService,
  );
  await authorize();
  const response = await observedFetch(fetchImplementation, url, {
    headers: {
      authentication: `skypetoken=${session.skypeToken.value}`,
      accept: "application/json",
    },
  });
  const payload = await jsonResponse(response, "Message lookup", "skype") as { message?: unknown; };
  const message = normalizeMessage(payload.message ?? payload, target.id);
  if (!message) throw new Error("Message lookup returned no message");
  return { target, message };
}

export async function sendMessage(
  session: StoredSession,
  target: MessageTarget,
  content: string,
  requestId: string,
  sessionId: string,
  authorize: () => Promise<void>,
  fetchImplementation: typeof fetch = fetch,
): Promise<MessageSendResult> {
  const plainTextAsHtml = content
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll(/\r?\n/g, "<br>");
  const displayName = readJwtMetadata(session.accessToken.value).name ?? "";
  await authorize();
  const response = await observedFetch(fetchImplementation, new URL(messagePath(target.id), session.endpoints.chatService), {
    method: "POST",
    headers: {
      authentication: `skypetoken=${session.skypeToken.value}`,
      "x-ms-session-id": sessionId,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      clientmessageid: requestId,
      content: `<p>${plainTextAsHtml}</p>`,
      contenttype: "text",
      messagetype: "RichText/Html",
      amsreferences: [],
      imdisplayname: displayName,
      properties: { importance: "", subject: "" },
    }),
  });
  if (!response.ok) {
    throw new TeamsApiError(
      response.status,
      `Message send failed (${response.status} ${response.statusText})`,
      "skype",
    );
  }
  const raw = await response.text();
  if (!raw.trim()) return { target, message: null };
  let payload: { message?: unknown; };
  try {
    payload = JSON.parse(raw) as { message?: unknown; };
  } catch {
    return { target, message: null };
  }
  const message = normalizeMessage(payload.message ?? payload, target.id);
  return { target, message };
}
