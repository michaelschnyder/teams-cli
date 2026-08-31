import { randomUUID } from "node:crypto";
import { OUTLOOK_SEARCH_URL, TEAMS_WEB_ORIGIN } from "./constants.js";
import { readJwtMetadata } from "./jwt.js";
import type { StoredSession } from "./storage.js";
import { observedFetch } from "./diagnostics.js";
import type { MessageTarget } from "./policy.js";

type DataTokenTarget = "access" | "skype" | "chat" | "search";

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

export type ChannelSummary = {
  id: string;
  name: string;
  description: string | null;
  team: { id: string; name: string };
};

export type PersonSummary = {
  id: string;
  mri: string | null;
  displayName: string | null;
  email: string | null;
  jobTitle: string | null;
};

export type PersonSearchResult = {
  query: string;
  people: PersonSummary[];
};

export type PersonPhone = { type: string | null; number: string };

export type PersonProfile = {
  id: string;
  mri: string | null;
  displayName: string | null;
  givenName: string | null;
  surname: string | null;
  email: string | null;
  mail: string | null;
  userPrincipalName: string | null;
  smtpAddresses: string[];
  jobTitle: string | null;
  department: string | null;
  officeLocation: string | null;
  mobile: string | null;
  telephoneNumber: string | null;
  phones: PersonPhone[];
  tenantName: string | null;
  userType: string | null;
  accountEnabled: boolean | null;
  teamsEnabled: boolean | null;
};

export type PersonResult = { person: PersonProfile };
export type PersonImage = { data: Buffer; contentType: string };
export type PersonImageSize = "48" | "64" | "96" | "120" | "240" | "360" | "432" | "504" | "648" | "max";

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
export type ChannelList = { channels: ChannelSummary[] };
export type ChatResult = { chat: ChatSummary };
export type ChannelResult = { channel: ChannelSummary };
export type MessagePage = { target: MessageTarget; messages: MessageSummary[]; page: PageInfo };
export type MessageResult = { target: MessageTarget; message: MessageSummary };
export type MessageSendResult = { target: MessageTarget; message: MessageSummary | null };

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

type RawChannel = { id?: unknown; threadId?: unknown; name?: unknown; displayName?: unknown; description?: unknown };
type RawTeam = { id?: unknown; threadId?: unknown; name?: unknown; displayName?: unknown; channels?: unknown };

type RawPerson = RawParticipant & {
  Id?: unknown;
  ObjectId?: unknown;
  objectId?: unknown;
  DisplayName?: unknown;
  displayName?: unknown;
  GivenName?: unknown;
  givenName?: unknown;
  Surname?: unknown;
  surname?: unknown;
  Email?: unknown;
  email?: unknown;
  Mail?: unknown;
  mail?: unknown;
  EmailAddress?: unknown;
  emailAddress?: unknown;
  EmailAddresses?: unknown;
  emailAddresses?: unknown;
  UserPrincipalName?: unknown;
  userPrincipalName?: unknown;
  SmtpAddresses?: unknown;
  smtpAddresses?: unknown;
  JobTitle?: unknown;
  jobTitle?: unknown;
  Department?: unknown;
  department?: unknown;
  PhysicalDeliveryOfficeName?: unknown;
  physicalDeliveryOfficeName?: unknown;
  UserLocation?: unknown;
  userLocation?: unknown;
  Mobile?: unknown;
  mobile?: unknown;
  TelephoneNumber?: unknown;
  telephoneNumber?: unknown;
  Phones?: unknown;
  phones?: unknown;
  TenantName?: unknown;
  tenantName?: unknown;
  UserType?: unknown;
  userType?: unknown;
  AccountEnabled?: unknown;
  accountEnabled?: unknown;
  SkypeTeamsInfo?: unknown;
  skypeTeamsInfo?: unknown;
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

function nullableBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
}

function firstEmailAddress(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  for (const entry of value) {
    if (typeof entry === "string" && entry.length > 0) return entry;
    if (!entry || typeof entry !== "object") continue;
    const email = entry as Record<string, unknown>;
    const address = stringValue(email.Address) ?? stringValue(email.address) ??
      stringValue(email.EmailAddress) ?? stringValue(email.emailAddress);
    if (address) return address;
  }
  return null;
}

function personIdentifiers(person: RawPerson): { id: string; mri: string | null } | null {
  const mri = stringValue(person.mri) ?? stringValue(person.MRI);
  const objectId = stringValue(person.objectId) ?? stringValue(person.ObjectId) ??
    stringValue(person.ExternalDirectoryObjectId) ??
    stringValue(person.Id) ?? stringValue(person.id);
  const id = objectId ?? (mri?.startsWith("8:orgid:") ? mri.slice("8:orgid:".length) : mri);
  return id ? { id, mri } : null;
}

function normalizePersonSummary(value: unknown): PersonSummary | null {
  if (!value || typeof value !== "object") return null;
  const person = value as RawPerson;
  const identifiers = personIdentifiers(person);
  if (!identifiers) return null;
  return {
    ...identifiers,
    displayName: stringValue(person.displayName) ?? stringValue(person.DisplayName) ??
      stringValue(person.friendlyName),
    email: stringValue(person.email) ?? stringValue(person.Email) ??
      stringValue(person.mail) ?? stringValue(person.Mail) ??
      stringValue(person.emailAddress) ?? stringValue(person.EmailAddress) ??
      firstEmailAddress(person.emailAddresses) ?? firstEmailAddress(person.EmailAddresses) ??
      stringValue(person.userPrincipalName) ?? stringValue(person.UserPrincipalName),
    jobTitle: stringValue(person.jobTitle) ?? stringValue(person.JobTitle),
  };
}

function normalizePhones(value: unknown): PersonPhone[] {
  if (!Array.isArray(value)) return [];
  const phones: PersonPhone[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const phone = entry as Record<string, unknown>;
    const number = stringValue(phone.number) ?? stringValue(phone.Number);
    if (!number) continue;
    phones.push({ type: stringValue(phone.type) ?? stringValue(phone.Type), number });
  }
  return phones;
}

function normalizePersonProfile(value: unknown): PersonProfile | null {
  if (!value || typeof value !== "object") return null;
  const person = value as RawPerson;
  const identifiers = personIdentifiers(person);
  if (!identifiers) return null;
  const mail = stringValue(person.mail) ?? stringValue(person.Mail);
  const userPrincipalName = stringValue(person.userPrincipalName) ??
    stringValue(person.UserPrincipalName);
  const email = stringValue(person.email) ?? stringValue(person.Email) ?? mail ?? userPrincipalName;
  const skypeTeamsInfo = person.skypeTeamsInfo ?? person.SkypeTeamsInfo;
  const teamsEnabled = skypeTeamsInfo && typeof skypeTeamsInfo === "object"
    ? nullableBoolean(
      (skypeTeamsInfo as Record<string, unknown>).isSkypeTeamsUser ??
      (skypeTeamsInfo as Record<string, unknown>).IsSkypeTeamsUser,
    )
    : null;
  return {
    ...identifiers,
    displayName: stringValue(person.displayName) ?? stringValue(person.DisplayName) ??
      stringValue(person.friendlyName),
    givenName: stringValue(person.givenName) ?? stringValue(person.GivenName),
    surname: stringValue(person.surname) ?? stringValue(person.Surname),
    email,
    mail,
    userPrincipalName,
    smtpAddresses: stringArray(person.smtpAddresses ?? person.SmtpAddresses),
    jobTitle: stringValue(person.jobTitle) ?? stringValue(person.JobTitle),
    department: stringValue(person.department) ?? stringValue(person.Department),
    officeLocation: stringValue(person.physicalDeliveryOfficeName) ??
      stringValue(person.PhysicalDeliveryOfficeName) ??
      stringValue(person.userLocation) ?? stringValue(person.UserLocation),
    mobile: stringValue(person.mobile) ?? stringValue(person.Mobile),
    telephoneNumber: stringValue(person.telephoneNumber) ?? stringValue(person.TelephoneNumber),
    phones: normalizePhones(person.phones ?? person.Phones),
    tenantName: stringValue(person.tenantName) ?? stringValue(person.TenantName),
    userType: stringValue(person.userType) ?? stringValue(person.UserType),
    accountEnabled: nullableBoolean(person.accountEnabled ?? person.AccountEnabled),
    teamsEnabled,
  };
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

function normalizeChannels(value: unknown): ChannelSummary[] {
  if (!Array.isArray(value)) return [];
  const channels: ChannelSummary[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const team = entry as RawTeam;
    const teamId = stringValue(team.id) ?? stringValue(team.threadId);
    const teamName = stringValue(team.name) ?? stringValue(team.displayName) ?? teamId;
    if (!teamId || !teamName || !Array.isArray(team.channels)) continue;
    for (const item of team.channels) {
      if (!item || typeof item !== "object") continue;
      const channel = item as RawChannel;
      const id = stringValue(channel.id) ?? stringValue(channel.threadId);
      const name = stringValue(channel.name) ?? stringValue(channel.displayName) ?? id;
      if (!id || !name) continue;
      channels.push({
        id,
        name,
        description: stringValue(channel.description),
        team: { id: teamId, name: teamName },
      });
    }
  }
  return channels;
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

function csaUrl(updates: boolean): URL {
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
      `${operation} failed (${response.status} ${response.statusText})`,
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

export async function searchPeople(
  session: StoredSession,
  query: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<PersonSearchResult> {
  const trimmed = query.trim();
  if (!trimmed) throw new Error("Person search query must not be empty");
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
      EntityRequests: [{
        Query: {
          QueryString: trimmed,
          DisplayQueryString: trimmed,
          NormalizedQueryString: trimmed,
        },
        EntityType: "People",
        Size: 25,
      }],
      Scenario: { Name: "powerbar", Dimensions: [] },
      Cvid: randomUUID(),
      AppName: "Microsoft Teams",
      LogicalId: randomUUID(),
      dataSource: "personScoped",
    }),
  });
  const payload = await jsonResponse(response, "People search", "search") as {
    Groups?: Array<{ Type?: unknown; Suggestions?: unknown }>;
  };
  const group = payload.Groups?.find((candidate) => candidate.Type === "People");
  const people = Array.isArray(group?.Suggestions)
    ? group.Suggestions
      .map(normalizePersonSummary)
      .filter((person): person is PersonSummary => person !== null)
    : [];
  return { query: trimmed, people };
}

function middleTierBaseUrl(session: StoredSession): URL {
  if (!session.endpoints.middleTier) {
    return new URL(`/api/mt/${encodeURIComponent(session.region)}/beta/`, TEAMS_WEB_ORIGIN);
  }
  const url = new URL(session.endpoints.middleTier);
  if (
    url.protocol !== "https:" ||
    (url.hostname !== "teams.microsoft.com" && !url.hostname.endsWith(".teams.microsoft.com"))
  ) {
    throw new Error("Stored Teams middle-tier endpoint is not trusted");
  }
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = `${path.endsWith("/beta") ? path : `${path}/beta`}/`;
  url.search = "";
  url.hash = "";
  return url;
}

function personUrl(session: StoredSession, identifier: string, suffix = ""): URL {
  const trimmed = identifier.trim();
  if (!trimmed) throw new Error("Person identifier must not be empty");
  const url = new URL(`users/${encodeURIComponent(trimmed)}/${suffix}`, middleTierBaseUrl(session));
  url.searchParams.set("isMailAddress", String(trimmed.includes("@")));
  url.searchParams.set("enableGuest", "true");
  url.searchParams.set("includeIBBarredUsers", "true");
  url.searchParams.set("skypeTeamsInfo", "true");
  return url;
}

export async function getPerson(
  session: StoredSession,
  identifier: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<PersonResult> {
  const response = await observedFetch(fetchImplementation, personUrl(session, identifier), {
    headers: {
      authorization: `Bearer ${session.accessToken.value}`,
      accept: "application/json",
    },
  });
  const payload = await jsonResponse(response, "Person lookup", "access") as { value?: unknown };
  const person = normalizePersonProfile(payload.value ?? payload);
  if (!person) throw new Error("Person lookup returned no person");
  return { person };
}

function decodeBase64Image(raw: Buffer): Buffer {
  const encoded = raw.toString("utf8").trim();
  if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 === 1) {
    throw new Error("Person image lookup returned invalid image data");
  }
  const decoded = Buffer.from(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "="), "base64");
  if (!decoded.length) throw new Error("Person image lookup returned an empty image");
  return decoded;
}

export async function getPersonImage(
  session: StoredSession,
  identifier: string,
  size: PersonImageSize = "max",
  fetchImplementation: typeof fetch = fetch,
): Promise<PersonImage> {
  const url = personUrl(session, identifier, "profilepicture");
  url.searchParams.set("displayname", identifier.trim());
  url.searchParams.set("size", `HR${size === "max" ? "648" : size}x${size === "max" ? "648" : size}`);
  const response = await observedFetch(fetchImplementation, url, {
    headers: { authorization: `Bearer ${session.accessToken.value}` },
  });
  if (response.status === 404) {
    throw new TeamsApiError(404, `No profile image found for: ${identifier}`, "access");
  }
  if (!response.ok) {
    throw new TeamsApiError(
      response.status,
      `Person image lookup failed (${response.status} ${response.statusText})`,
      "access",
    );
  }
  const raw = Buffer.from(await response.arrayBuffer());
  if (!raw.length) throw new Error("Person image lookup returned an empty image");
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
  return contentType?.startsWith("image/")
    ? { data: raw, contentType }
    : { data: decodeBase64Image(raw), contentType: "image/jpeg" };
}

async function discoveryPayload(
  session: StoredSession,
  fetchImplementation: typeof fetch,
): Promise<{ chats?: unknown; users?: unknown; teams?: unknown }> {
  const response = await observedFetch(fetchImplementation, csaUrl(false), {
    headers: {
      authorization: `Bearer ${session.chatToken.value}`,
      "x-skypetoken": session.skypeToken.value,
      accept: "application/json",
    },
  });
  return await jsonResponse(response, "Teams discovery", "chat") as {
    chats?: unknown;
    users?: unknown;
    teams?: unknown;
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

export async function listChannels(
  session: StoredSession,
  fetchImplementation: typeof fetch = fetch,
): Promise<ChannelList> {
  const payload = await discoveryPayload(session, fetchImplementation);
  return { channels: normalizeChannels(payload.teams) };
}

export async function getChannel(
  session: StoredSession,
  channelId: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<ChannelResult> {
  const result = await listChannels(session, fetchImplementation);
  const channel = result.channels.find((candidate) => candidate.id === channelId);
  if (!channel) throw new Error(`Channel not found: ${channelId}`);
  return { channel };
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
    _metadata?: { backwardLink?: unknown };
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
  const payload = await jsonResponse(response, "Message lookup", "skype") as { message?: unknown };
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
  let payload: { message?: unknown };
  try {
    payload = JSON.parse(raw) as { message?: unknown };
  } catch {
    return { target, message: null };
  }
  const message = normalizeMessage(payload.message ?? payload, target.id);
  return { target, message };
}
