import { randomUUID } from "node:crypto";
import {
  OUTLOOK_SEARCH_URL,
  TEAMS_WEB_ORIGIN,
} from "./constants.js";
import { readJwtMetadata } from "./jwt.js";
import type { StoredSession } from "./storage.js";

type DataTokenTarget = "skype" | "chat" | "search";

export class TeamsApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly tokenTarget?: DataTokenTarget,
  ) {
    super(message);
    this.name = "TeamsApiError";
  }
}

export type Participant = {
  id: string;
  displayName: string | null;
  tenantId: string | null;
  objectId: string | null;
  role: string | null;
};

export type ChatSummary = {
  id: string;
  title: string;
  type: string | null;
  oneOnOne: boolean;
  hidden: boolean;
  disabled: boolean;
  read: boolean | null;
  lastActivity: string | null;
  participants: Participant[];
  participantCount: number;
};

export type MessageSummary = {
  id: string;
  chatId: string;
  sequenceId: number | string | null;
  version: number | string | null;
  type: string | null;
  messageType: string | null;
  contentType: string | null;
  content: string | null;
  sender: {
    id: string | null;
    displayName: string | null;
  };
  composedAt: string | null;
  originalArrivalAt: string | null;
  properties: Record<string, unknown>;
};

export type PageInfo = { nextCursor: string | null };
export type ChatPage = { chats: ChatSummary[]; page: PageInfo };
export type ChatSearchResult = { query: string; chats: ChatSummary[]; page: PageInfo };
export type MessagePage = { chatId: string; messages: MessageSummary[]; page: PageInfo };
export type MessageResult = { chatId: string; message: MessageSummary };

type Cursor =
  | { version: 1; kind: "chats"; tenantId: string; syncToken: string }
  | { version: 1; kind: "messages"; tenantId: string; chatId: string; url: string };

type RawParticipant = {
  mri?: unknown;
  id?: unknown;
  MRI?: unknown;
  displayName?: unknown;
  friendlyName?: unknown;
  DisplayName?: unknown;
  tenantId?: unknown;
  TenantId?: unknown;
  objectId?: unknown;
  ExternalDirectoryObjectId?: unknown;
  role?: unknown;
  Role?: unknown;
};

type RawChat = {
  id?: unknown;
  ThreadId?: unknown;
  title?: unknown;
  Name?: unknown;
  chatType?: unknown;
  ThreadType?: unknown;
  isOneOnOne?: unknown;
  hidden?: unknown;
  isDisabled?: unknown;
  isRead?: unknown;
  members?: unknown;
  ChatMembers?: unknown;
  MatchingMembers?: unknown;
  TotalChatMembersCount?: unknown;
  lastMessage?: { composeTime?: unknown; originalArrivalTime?: unknown };
  LastMessageTime?: unknown;
};

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

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeParticipant(value: unknown): Participant | null {
  if (typeof value === "string") {
    return { id: value, displayName: null, tenantId: null, objectId: null, role: null };
  }
  if (!value || typeof value !== "object") return null;
  const participant = value as RawParticipant;
  const id = stringValue(participant.mri) ?? stringValue(participant.MRI) ?? stringValue(participant.id);
  if (!id) return null;
  return {
    id,
    displayName:
      stringValue(participant.friendlyName) ??
      stringValue(participant.displayName) ??
      stringValue(participant.DisplayName),
    tenantId: stringValue(participant.tenantId) ?? stringValue(participant.TenantId),
    objectId:
      stringValue(participant.objectId) ?? stringValue(participant.ExternalDirectoryObjectId),
    role: stringValue(participant.role) ?? stringValue(participant.Role),
  };
}

function normalizeChat(value: unknown, userNames = new Map<string, string>()): ChatSummary | null {
  if (!value || typeof value !== "object") return null;
  const chat = value as RawChat;
  const id = stringValue(chat.id) ?? stringValue(chat.ThreadId);
  if (!id) return null;
  const rawParticipants = Array.isArray(chat.members)
    ? chat.members
    : Array.isArray(chat.ChatMembers)
      ? chat.ChatMembers
      : [];
  // Search suggestions separate the matched person from the sampled chat roster.
  // Put matches first so the reason for the server result remains visible.
  const matchingParticipants = Array.isArray(chat.MatchingMembers) ? chat.MatchingMembers : [];
  const participants = [...matchingParticipants, ...rawParticipants]
    .map(normalizeParticipant)
    .filter((participant): participant is Participant => participant !== null);
  const seenParticipantIds = new Set<string>();
  const uniqueParticipants = participants.filter((participant) => {
    if (seenParticipantIds.has(participant.id)) return false;
    seenParticipantIds.add(participant.id);
    return true;
  });
  for (const participant of uniqueParticipants) {
    participant.displayName ??= userNames.get(participant.id) ?? null;
  }
  const explicitTitle = stringValue(chat.title) ?? stringValue(chat.Name);
  const participantTitle = uniqueParticipants
    .map((participant) => participant.displayName)
    .filter((name): name is string => name !== null)
    .join(", ");
  const lastActivity = stringValue(chat.LastMessageTime) ??
    stringValue(chat.lastMessage?.composeTime) ??
    stringValue(chat.lastMessage?.originalArrivalTime);
  return {
    id,
    title: explicitTitle ?? (participantTitle || id),
    type: stringValue(chat.chatType) ?? stringValue(chat.ThreadType),
    oneOnOne: booleanValue(chat.isOneOnOne, false),
    hidden: booleanValue(chat.hidden, false),
    disabled: booleanValue(chat.isDisabled, false),
    read: typeof chat.isRead === "boolean" ? chat.isRead : null,
    lastActivity,
    participants: uniqueParticipants,
    participantCount:
      typeof chat.TotalChatMembersCount === "number"
        ? chat.TotalChatMembersCount
        : uniqueParticipants.length,
  };
}

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

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(encoded: string): Cursor {
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

function requireCursorTenant(cursor: Cursor, session: StoredSession): void {
  if (cursor.tenantId !== session.tenantId) {
    throw new Error("Paging cursor belongs to a different Teams tenant");
  }
}

function csaUrl(session: StoredSession, updates: boolean): URL {
  const url = new URL(
    `/api/csa/api/v1/teams/users/me${updates ? "/updates" : ""}`,
    TEAMS_WEB_ORIGIN,
  );
  url.searchParams.set("isPrefetch", "false");
  url.searchParams.set("enableMembershipSummary", "true");
  url.searchParams.set("supportsAdditionalSystemGeneratedFolders", "true");
  url.searchParams.set("supportsSliceItems", "true");
  return url;
}

async function jsonResponse(
  response: Response,
  operation: string,
  tokenTarget?: DataTokenTarget,
): Promise<unknown> {
  const raw = await response.text();
  if (!response.ok) {
    throw new TeamsApiError(
      response.status,
      `${operation} failed (${response.status} ${response.statusText}): ${raw.slice(0, 300)}`,
      tokenTarget,
    );
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${operation} returned invalid JSON`);
  }
}

export async function listChats(
  session: StoredSession,
  cursorValue?: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<ChatPage> {
  let syncToken: string | undefined;
  if (cursorValue) {
    const cursor = decodeCursor(cursorValue);
    if (cursor.kind !== "chats") throw new Error("Expected a chat paging cursor");
    requireCursorTenant(cursor, session);
    syncToken = cursor.syncToken;
  }
  const response = await fetchImplementation(csaUrl(session, Boolean(syncToken)), {
    headers: {
      authorization: `Bearer ${session.chatToken.value}`,
      "x-skypetoken": session.skypeToken.value,
      ...(syncToken ? { "x-ms-synctoken": syncToken } : {}),
      accept: "application/json",
    },
  });
  const payload = await jsonResponse(response, "Chat discovery", "chat") as {
    chats?: unknown;
    users?: unknown;
    metadata?: { hasMoreChats?: unknown; syncToken?: unknown };
  };
  const userNames = new Map<string, string>();
  if (Array.isArray(payload.users)) {
    for (const value of payload.users) {
      if (!value || typeof value !== "object") continue;
      const user = value as {
        mri?: unknown;
        MRI?: unknown;
        displayName?: unknown;
        DisplayName?: unknown;
        email?: unknown;
        userPrincipalName?: unknown;
      };
      const id = stringValue(user.mri) ?? stringValue(user.MRI);
      const name = stringValue(user.displayName) ?? stringValue(user.DisplayName) ??
        stringValue(user.email) ?? stringValue(user.userPrincipalName);
      if (id && name) userNames.set(id, name);
    }
  }
  const chats = Array.isArray(payload.chats)
    ? payload.chats
      .map((chat) => normalizeChat(chat, userNames))
      .filter((chat): chat is ChatSummary => chat !== null)
    : [];
  const nextSyncToken = stringValue(payload.metadata?.syncToken);
  const nextCursor = payload.metadata?.hasMoreChats === true && nextSyncToken
    ? encodeCursor({ version: 1, kind: "chats", tenantId: session.tenantId, syncToken: nextSyncToken })
    : null;
  return { chats, page: { nextCursor } };
}

export async function findChats(
  session: StoredSession,
  query: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<ChatSearchResult> {
  const trimmed = query.trim();
  if (!trimmed) throw new Error("Chat search query must not be empty");
  const url = new URL(OUTLOOK_SEARCH_URL);
  url.searchParams.set("scenario", "powerbar");
  const response = await fetchImplementation(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${session.searchToken.value}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      EntityRequests: ["People", "Chat"].map((EntityType) => ({
        Query: {
          QueryString: trimmed,
          DisplayQueryString: trimmed,
          NormalizedQueryString: trimmed,
        },
        EntityType,
        Size: 25,
      })),
      Scenario: { Name: "powerbar", Dimensions: [] },
      Cvid: randomUUID(),
      AppName: "Microsoft Teams",
      LogicalId: randomUUID(),
      dataSource: "personScoped",
    }),
  });
  const payload = await jsonResponse(response, "Chat search", "search") as {
    Groups?: Array<{ Type?: unknown; Suggestions?: unknown }>;
  };
  const chatGroup = payload.Groups?.find((candidate) => candidate.Type === "Chat");
  const chats = Array.isArray(chatGroup?.Suggestions)
    ? chatGroup.Suggestions
      .map((chat) => normalizeChat(chat))
      .filter((chat): chat is ChatSummary => chat !== null)
    : [];
  const peopleGroup = payload.Groups?.find((candidate) => candidate.Type === "People");
  const people = Array.isArray(peopleGroup?.Suggestions) ? peopleGroup.Suggestions : [];
  const directChats = await Promise.all(people.map(async (value): Promise<ChatSummary | null> => {
    if (!value || typeof value !== "object") return null;
    const person = value as RawParticipant;
    const participant = normalizeParticipant(person);
    if (!participant || !participant.id.startsWith("8:orgid:")) return null;
    const ownObjectId = readJwtMetadata(session.accessToken.value).userId;
    if (!ownObjectId) throw new Error("The saved access token has no user object ID");
    const otherObjectId = participant.id.slice("8:orgid:".length);
    const candidateIds = [
      `19:${otherObjectId}_${ownObjectId}@unq.gbl.spaces`,
      `19:${ownObjectId}_${otherObjectId}@unq.gbl.spaces`,
    ];
    for (const chatId of candidateIds) {
      const url = new URL(
        `/v1/users/ME/conversations/${encodeURIComponent(chatId)}`,
        session.endpoints.chatService,
      );
      const lookup = await fetchImplementation(url, {
        headers: {
          authentication: `skypetoken=${session.skypeToken.value}`,
          accept: "application/json",
        },
      });
      if (lookup.status === 404) continue;
      const conversation = await jsonResponse(lookup, "Direct chat lookup", "skype") as {
        lastMessage?: { composetime?: unknown; originalarrivaltime?: unknown };
      };
      return {
        id: chatId,
        title: participant.displayName ?? participant.id,
        type: "Chat",
        oneOnOne: true,
        hidden: false,
        disabled: false,
        read: null,
        lastActivity: stringValue(conversation.lastMessage?.composetime) ??
          stringValue(conversation.lastMessage?.originalarrivaltime),
        participants: [participant],
        participantCount: 2,
      };
    }
    return null;
  }));
  return {
    query: trimmed,
    chats: [...directChats.filter((chat): chat is ChatSummary => chat !== null), ...chats],
    page: { nextCursor: null },
  };
}

export type MessagePageOptions = {
  cursor?: string;
  pageSize?: number;
};

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
  chatId: string,
  options: MessagePageOptions,
  fetchImplementation: typeof fetch = fetch,
): Promise<MessagePage> {
  const url = options.cursor
    ? continuedMessageUrl(session, chatId, options.cursor)
    : initialMessageUrl(session, chatId, options);
  const response = await fetchImplementation(url, {
    headers: {
      authentication: `skypetoken=${session.skypeToken.value}`,
      accept: "application/json",
    },
  });
  const payload = await jsonResponse(response, "Message listing", "skype") as {
    messages?: unknown;
    _metadata?: { backwardLink?: unknown };
  };
  const messages = Array.isArray(payload.messages)
    ? payload.messages
      .map((message) => normalizeMessage(message, chatId))
      .filter((message): message is MessageSummary => message !== null)
    : [];
  const backwardLink = stringValue(payload._metadata?.backwardLink);
  const nextCursor = backwardLink
    ? encodeCursor({
      version: 1,
      kind: "messages",
      tenantId: session.tenantId,
      chatId,
      url: backwardLink,
    })
    : null;
  return { chatId, messages, page: { nextCursor } };
}

export async function getMessage(
  session: StoredSession,
  chatId: string,
  messageId: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<MessageResult> {
  const url = new URL(
    `${messagePath(chatId)}/${encodeURIComponent(messageId)}`,
    session.endpoints.chatService,
  );
  const response = await fetchImplementation(url, {
    headers: {
      authentication: `skypetoken=${session.skypeToken.value}`,
      accept: "application/json",
    },
  });
  const payload = await jsonResponse(response, "Message lookup", "skype") as { message?: unknown };
  const message = normalizeMessage(payload.message ?? payload, chatId);
  if (!message) throw new Error("Message lookup returned no message");
  return { chatId, message };
}
