import assert from "node:assert/strict";
import test from "node:test";
import { getChannel, getChat, getMessage, listChannels, listChats, listMessages } from "../src/teams-client.js";
import type { StoredSession } from "../src/storage.js";

const session: StoredSession = {
  version: 2,
  browser: "edge",
  tenantId: "tenant",
  savedAt: "2026-08-18T00:00:00.000Z",
  region: "emea",
  accessToken: { value: "access", expiresAt: "2027-01-01T00:00:00.000Z" },
  skypeToken: { value: "skype", expiresAt: "2027-01-01T00:00:00.000Z" },
  chatToken: { value: "chat", expiresAt: "2027-01-01T00:00:00.000Z" },
  searchToken: { value: "search", expiresAt: "2027-01-01T00:00:00.000Z" },
  endpoints: { chatService: "https://emea.ng.msg.teams.microsoft.com" },
};

const discovery = {
  teams: [{ id: "team-1", displayName: "Testing", channels: [{ id: "channel-1", displayName: "General" }] }],
  chats: [{ id: "chat-1", title: "Vlad", members: [{ mri: "8:orgid:vlad", displayName: "Vlad" }] }],
  users: [],
  metadata: {},
};

const discoveryFetch: typeof fetch = async () => Response.json(discovery);

test("normalizes chat and channel discovery from a mocked API", async () => {
  const chats = await listChats(session, undefined, discoveryFetch);
  assert.equal(chats.chats[0]?.title, "Vlad");
  assert.equal((await getChat(session, "chat-1", discoveryFetch)).chat.id, "chat-1");
  const channels = await listChannels(session, discoveryFetch);
  assert.deepEqual(channels.channels[0], {
    id: "channel-1",
    name: "General",
    description: null,
    team: { id: "team-1", name: "Testing" },
  });
  assert.equal((await getChannel(session, "channel-1", discoveryFetch)).channel.team.name, "Testing");
});

test("lists and gets messages for chat and channel targets from a mocked API", async () => {
  const message = { id: "message-1", content: "hello", imdisplayname: "Vlad" };
  const listFetch: typeof fetch = async () => Response.json({ messages: [message], _metadata: {} });
  const page = await listMessages(session, { kind: "channel", id: "channel-1" }, {}, listFetch);
  assert.equal(page.target.kind, "channel");
  assert.equal(page.messages[0]?.content, "hello");
  const getFetch: typeof fetch = async () => Response.json({ message });
  const result = await getMessage(session, { kind: "chat", id: "chat-1" }, "message-1", getFetch);
  assert.equal(result.target.id, "chat-1");
  assert.equal(result.message.id, "message-1");
});
