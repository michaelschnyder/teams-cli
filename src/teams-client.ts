import { TEAMS_CSA_URL } from "./constants.js";

type RawMember = {
  friendlyName?: string;
  mri?: string;
};

type RawChat = {
  id?: string;
  title?: string;
  chatType?: string;
  isOneOnOne?: boolean;
  hidden?: boolean;
  members?: RawMember[];
  lastMessage?: {
    composeTime?: string;
    originalArrivalTime?: string;
  };
};

type RawTeam = {
  id?: string;
  displayName?: string;
  channels?: Array<{ id?: string; displayName?: string }>;
};

type ConversationPayload = {
  chats?: RawChat[];
  teams?: RawTeam[];
  users?: Array<{
    mri?: string;
    displayName?: string;
    email?: string;
  }>;
};

export type ConversationSummary = {
  id: string;
  title: string;
  type?: string;
  oneOnOne: boolean;
  hidden: boolean;
  members: string[];
  lastActivity?: string;
};

export type TeamSummary = {
  id: string;
  name: string;
  channels: Array<{ id: string; name: string }>;
};

export async function listConversations(chatSvcAggToken: string): Promise<{
  chats: ConversationSummary[];
  teams: TeamSummary[];
}> {
  const url = new URL(TEAMS_CSA_URL);
  url.searchParams.set("isPrefetch", "false");
  url.searchParams.set("enableMembershipSummary", "true");

  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${chatSvcAggToken}`,
      accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Conversation discovery failed (${response.status} ${response.statusText})`);
  }

  const payload = (await response.json()) as ConversationPayload;
  return summarizeConversations(payload);
}

export function summarizeConversations(payload: ConversationPayload): {
  chats: ConversationSummary[];
  teams: TeamSummary[];
} {
  const userNames = new Map(
    (payload.users ?? [])
      .filter((user): user is { mri: string; displayName?: string; email?: string } =>
        Boolean(user.mri),
      )
      .map((user) => [user.mri, user.displayName ?? user.email] as const)
      .filter((entry): entry is readonly [string, string] => Boolean(entry[1])),
  );
  const chats = (payload.chats ?? [])
    .filter((chat): chat is RawChat & { id: string } => Boolean(chat.id))
    .map((chat) => ({
      id: chat.id,
      title:
        chat.title?.trim() ||
        chat.members
          ?.map((member) => member.friendlyName ?? (member.mri ? userNames.get(member.mri) : undefined))
          .filter(Boolean)
          .join(", ") ||
        chat.id,
      ...(chat.chatType ? { type: chat.chatType } : {}),
      oneOnOne: chat.isOneOnOne ?? false,
      hidden: chat.hidden ?? false,
      members: (chat.members ?? [])
        .map((member) => member.friendlyName ?? (member.mri ? userNames.get(member.mri) : undefined))
        .filter((member): member is string => Boolean(member)),
      ...(chat.lastMessage?.composeTime || chat.lastMessage?.originalArrivalTime
        ? { lastActivity: chat.lastMessage.composeTime ?? chat.lastMessage.originalArrivalTime }
        : {}),
    }));

  const teams = (payload.teams ?? [])
    .filter((team): team is RawTeam & { id: string } => Boolean(team.id))
    .map((team) => ({
      id: team.id,
      name: team.displayName?.trim() || team.id,
      channels: (team.channels ?? [])
        .filter((channel): channel is { id: string; displayName?: string } => Boolean(channel.id))
        .map((channel) => ({
          id: channel.id,
          name: channel.displayName?.trim() || channel.id,
        })),
    }));

  return { chats, teams };
}
