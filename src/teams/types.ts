import type { MessageTarget } from "../policy.js";

export type DataTokenTarget = "access" | "skype" | "chat" | "search";

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
  team: { id: string; name: string; };
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

export type PersonPhone = { type: string | null; number: string; };

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
  tenantId: string | null;
  tenantName: string | null;
  userType: string | null;
  accountEnabled: boolean | null;
  teamsEnabled: boolean | null;
};

export type PersonResult = { person: PersonProfile; };

export type DirectMessageTarget = {
  target: MessageTarget;
  person: PersonProfile;
  existingChat: boolean;
  sameTenantMember: boolean;
};

export type PersonImage = { data: Buffer; contentType: string; };

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

export type PageInfo = { nextCursor: string | null; };

export type ChatPage = { chats: ChatSummary[]; page: PageInfo; };

export type ChatSearchResult = { query: string; chats: ChatSummary[]; page: PageInfo; };

export type ChannelList = { channels: ChannelSummary[]; };

export type ChatResult = { chat: ChatSummary; };

export type ChannelResult = { channel: ChannelSummary; };

export type MessagePage = { target: MessageTarget; messages: MessageSummary[]; page: PageInfo; };

export type MessageResult = { target: MessageTarget; message: MessageSummary; };

export type MessageSendResult = { target: MessageTarget; message: MessageSummary | null; };

export type MessagePageOptions = {
  cursor?: string;
  pageSize?: number;
};
