import type { StoredSession } from "../storage.js";

import { discoveryPayload, stringValue } from "./transport.js";
import type { ChannelList, ChannelResult, ChannelSummary } from "./types.js";

type RawChannel = { id?: unknown; threadId?: unknown; name?: unknown; displayName?: unknown; description?: unknown; };

type RawTeam = { id?: unknown; threadId?: unknown; name?: unknown; displayName?: unknown; channels?: unknown; };

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
