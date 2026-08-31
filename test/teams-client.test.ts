import assert from "node:assert/strict";
import test from "node:test";
import {
  getChannel,
  getChat,
  getMessage,
  getPerson,
  getPersonImage,
  listChannels,
  listChats,
  listMessages,
  searchPeople,
} from "../src/teams-client.js";
import type { StoredSession } from "../src/storage.js";

const session: StoredSession = {
  version: 3,
  browser: "edge",
  tenantId: "tenant",
  userId: "user-id",
  savedAt: "2026-08-18T00:00:00.000Z",
  region: "emea",
  accessToken: { value: "access", expiresAt: "2027-01-01T00:00:00.000Z" },
  skypeToken: { value: "skype", expiresAt: "2027-01-01T00:00:00.000Z" },
  chatToken: { value: "chat", expiresAt: "2027-01-01T00:00:00.000Z" },
  searchToken: { value: "search", expiresAt: "2027-01-01T00:00:00.000Z" },
  endpoints: {
    chatService: "https://emea.ng.msg.teams.microsoft.com",
    middleTier: "https://teams.microsoft.com/api/mt/part/emea-01",
  },
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

test("searches people with the search token and preserves server ranking", async () => {
  const requests: Array<{ url: URL; init: RequestInit | undefined }> = [];
  const searchFetch: typeof fetch = async (input, init) => {
    requests.push({ url: new URL(input.toString()), init });
    return Response.json({
      Groups: [{
        Type: "People",
        Suggestions: [
          {
            MRI: "8:orgid:person-2",
            Id: "legacy-person-2@tenant",
            ExternalDirectoryObjectId: "person-2",
            DisplayName: "Grace Hopper",
            EmailAddresses: [{ Address: "grace@example.com" }],
            JobTitle: "Rear Admiral",
          },
          {
            mri: "8:orgid:person-1",
            objectId: "person-1",
            displayName: "Ada Lovelace",
            email: "ada@example.com",
          },
        ],
      }],
    });
  };
  const result = await searchPeople(session, "  engineer  ", searchFetch);
  assert.equal(result.query, "engineer");
  assert.deepEqual(result.people.map((person) => person.id), ["person-2", "person-1"]);
  assert.deepEqual(result.people[0], {
    id: "person-2",
    mri: "8:orgid:person-2",
    displayName: "Grace Hopper",
    email: "grace@example.com",
    jobTitle: "Rear Admiral",
  });
  assert.equal(requests[0]?.init?.method, "POST");
  assert.equal((requests[0]?.init?.headers as Record<string, string>).authorization, "Bearer search");
  const body = JSON.parse(String(requests[0]?.init?.body)) as {
    EntityRequests: Array<{ EntityType: string; Size: number; Query: { QueryString: string } }>;
  };
  assert.deepEqual(body.EntityRequests.map(({ EntityType, Size }) => ({ EntityType, Size })), [
    { EntityType: "People", Size: 25 },
  ]);
  assert.equal(body.EntityRequests[0]?.Query.QueryString, "engineer");
  await assert.rejects(() => searchPeople(session, "  ", searchFetch), /must not be empty/);
});

test("gets a detailed person by email or MRI through middle tier", async () => {
  const urls: URL[] = [];
  const profileFetch: typeof fetch = async (input, init) => {
    urls.push(new URL(input.toString()));
    assert.equal((init?.headers as Record<string, string>).authorization, "Bearer access");
    return Response.json({
      value: {
        objectId: "person-1",
        mri: "8:orgid:person-1",
        displayName: "Ada Lovelace",
        givenName: "Ada",
        surname: "Lovelace",
        email: "ada@example.com",
        mail: "ada@example.com",
        userPrincipalName: "ada@example.com",
        smtpAddresses: ["ada@example.com"],
        jobTitle: "Programmer",
        department: "Research",
        physicalDeliveryOfficeName: "London",
        mobile: "+44 7000",
        telephoneNumber: "+44 2000",
        phones: [{ type: "Mobile", number: "+44 7000" }],
        tenantName: "Example",
        userType: "Member",
        accountEnabled: true,
        skypeTeamsInfo: { isSkypeTeamsUser: true },
      },
    });
  };
  const result = await getPerson(session, "ada@example.com", profileFetch);
  assert.equal(result.person.jobTitle, "Programmer");
  assert.equal(result.person.department, "Research");
  assert.deepEqual(result.person.phones, [{ type: "Mobile", number: "+44 7000" }]);
  assert.equal(urls[0]?.pathname, "/api/mt/part/emea-01/beta/users/ada%40example.com/");
  assert.equal(urls[0]?.searchParams.get("isMailAddress"), "true");
  await getPerson(session, "8:orgid:person-1", profileFetch);
  assert.equal(urls[1]?.searchParams.get("isMailAddress"), "false");
});

test("uses the regional middle-tier fallback when auth returned no endpoint", async () => {
  const fallbackSession: StoredSession = { ...session, endpoints: { chatService: session.endpoints.chatService } };
  let requested: URL | undefined;
  await getPerson(fallbackSession, "person-1", async (input) => {
    requested = new URL(input.toString());
    return Response.json({ value: { objectId: "person-1" } });
  });
  assert.equal(requested?.pathname, "/api/mt/emea/beta/users/person-1/");
  await assert.rejects(
    () => getPerson(
      { ...session, endpoints: { ...session.endpoints, middleTier: "https://example.test/api/mt/emea" } },
      "person-1",
      async () => Response.json({}),
    ),
    /not trusted/,
  );
});

test("decodes authenticated base64 profile images and accepts binary images", async () => {
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  let requestedSize: string | null = null;
  const encoded = await getPersonImage(session, "person-1", "240", async (input) => {
    requestedSize = new URL(input.toString()).searchParams.get("size");
    return new Response(bytes.toString("base64"), { status: 200 });
  });
  assert.deepEqual(encoded.data, bytes);
  assert.equal(encoded.contentType, "image/jpeg");
  assert.equal(requestedSize, "HR240x240");

  const binary = await getPersonImage(session, "person-1", "max", async () =>
    new Response(bytes, { status: 200, headers: { "content-type": "image/png" } }));
  assert.deepEqual(binary.data, bytes);
  assert.equal(binary.contentType, "image/png");

  await assert.rejects(
    () => getPersonImage(session, "missing", "max", async () => new Response(null, { status: 404 })),
    /No profile image found/,
  );
});
