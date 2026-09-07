import { randomUUID } from "node:crypto";
import { OUTLOOK_SEARCH_URL } from "../constants.js";
import { observedFetch } from "../diagnostics.js";
import type { StoredSession } from "../storage.js";

import { decodeCursor, encodeCursor, requireCursorTenant } from "./cursors.js";
import { getPerson } from "./people.js";
import { booleanValue, csaUrl, jsonResponse, stringValue } from "./transport.js";
import type { ChatPage, ChatResult, ChatSearchResult, ChatSummary, DirectMessageTarget, Participant } from "./types.js";

export type RawParticipant = {
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
  lastMessage?: { composeTime?: unknown; originalArrivalTime?: unknown; };
  LastMessageTime?: unknown;
};

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
  const response = await observedFetch(fetchImplementation, csaUrl(Boolean(syncToken)), {
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
    metadata?: { hasMoreChats?: unknown; syncToken?: unknown; };
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

type DirectChatLookup = {
  id: string;
  payload: { lastMessage?: { composetime?: unknown; originalarrivaltime?: unknown; }; };
};

function directChatIds(ownObjectId: string, otherObjectId: string): [string, string] {
  return [
    `19:${otherObjectId}_${ownObjectId}@unq.gbl.spaces`,
    `19:${ownObjectId}_${otherObjectId}@unq.gbl.spaces`,
  ];
}

async function findExistingDirectChat(
  session: StoredSession,
  otherObjectId: string,
  fetchImplementation: typeof fetch,
): Promise<DirectChatLookup | null> {
  for (const id of directChatIds(session.userId, otherObjectId)) {
    const response = await observedFetch(fetchImplementation, new URL(
      `/v1/users/ME/conversations/${encodeURIComponent(id)}`,
      session.endpoints.chatService,
    ), {
      headers: {
        authentication: `skypetoken=${session.skypeToken.value}`,
        accept: "application/json",
      },
    });
    if (response.status === 404) continue;
    const payload = await jsonResponse(response, "Direct chat lookup", "skype") as DirectChatLookup["payload"];
    return { id, payload };
  }
  return null;
}

export async function searchChats(
  session: StoredSession,
  query: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<ChatSearchResult> {
  const trimmed = query.trim();
  if (!trimmed) throw new Error("Chat search query must not be empty");
  const url = new URL(OUTLOOK_SEARCH_URL);
  url.searchParams.set("scenario", "powerbar");
  const response = await observedFetch(fetchImplementation, url, {
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
    Groups?: Array<{ Type?: unknown; Suggestions?: unknown; }>;
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
    const participant = normalizeParticipant(value);
    const objectId = participant?.objectId ?? (participant?.id.startsWith("8:orgid:")
      ? participant.id.slice("8:orgid:".length)
      : null);
    if (!participant || !objectId || objectId === session.userId) return null;
    const direct = await findExistingDirectChat(session, objectId, fetchImplementation);
    if (!direct) return null;
    return {
      id: direct.id,
      title: participant.displayName ?? participant.id,
      type: "Chat",
      oneOnOne: true,
      hidden: false,
      disabled: false,
      read: null,
      lastActivity: stringValue(direct.payload.lastMessage?.composetime) ??
        stringValue(direct.payload.lastMessage?.originalarrivaltime),
      participants: [participant],
      participantCount: 2,
    };
  }));
  return {
    query: trimmed,
    chats: [...directChats.filter((chat): chat is ChatSummary => chat !== null), ...chats],
    page: { nextCursor: null },
  };
}

export async function getChat(
  session: StoredSession,
  chatId: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<ChatResult> {
  let cursor: string | undefined;
  do {
    const result = await listChats(session, cursor, fetchImplementation);
    const chat = result.chats.find((candidate) => candidate.id === chatId);
    if (chat) return { chat };
    cursor = result.page.nextCursor ?? undefined;
  } while (cursor);
  throw new Error(`Chat not found: ${chatId}`);
}

export async function resolveDirectMessageTarget(
  session: StoredSession,
  identifier: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<DirectMessageTarget> {
  const { person } = await getPerson(session, identifier, fetchImplementation);
  const otherObjectId = person.mri?.startsWith("8:orgid:")
    ? person.mri.slice("8:orgid:".length)
    : person.id.startsWith("8:orgid:")
      ? person.id.slice("8:orgid:".length)
      : person.id;
  if (!otherObjectId || otherObjectId === session.userId) {
    throw new Error("Choose another Teams user as the message recipient");
  }
  const direct = await findExistingDirectChat(session, otherObjectId, fetchImplementation);
  const chatId = direct?.id ?? directChatIds(session.userId, otherObjectId)[0];
  const personIds = [...new Set([
    person.id,
    person.mri,
    otherObjectId,
    `8:orgid:${otherObjectId}`,
  ].filter((value): value is string => Boolean(value)))];
  return {
    target: { kind: "chat", id: chatId, category: "person", personIds },
    person,
    existingChat: direct !== null,
    sameTenantMember: person.userType?.toLowerCase() === "member" &&
      (person.tenantId === null || person.tenantId === session.tenantId),
  };
}
