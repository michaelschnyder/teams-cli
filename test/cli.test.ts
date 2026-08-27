import assert from "node:assert/strict";
import test from "node:test";
import {
  createProgram,
  personImageOutput,
  renderPeople,
  renderPerson,
  renderRefreshResult,
  renderTokens,
  selectedTarget,
} from "../src/cli.js";
import type { StoredSession } from "../src/storage.js";

function jwt(payload: object): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

const session: StoredSession = {
  version: 2,
  browser: "edge",
  tenantId: "tenant",
  savedAt: "2026-08-14T00:00:00.000Z",
  region: "emea",
  accessToken: { value: jwt({ kind: "access" }), expiresAt: "2027-01-01T00:00:00.000Z" },
  skypeToken: { value: jwt({ kind: "skype" }), expiresAt: "2027-01-01T00:00:00.000Z" },
  chatToken: { value: jwt({ kind: "chat" }), expiresAt: "2027-01-01T00:00:00.000Z" },
  searchToken: { value: jwt({ kind: "search" }), expiresAt: "2027-01-01T00:00:00.000Z" },
  endpoints: { chatService: "https://emea.ng.msg.teams.microsoft.com" },
};

test("exposes the final auth, person, chat, channel, and message command groups", () => {
  const program = createProgram();
  assert.deepEqual(program.commands.map((command) => command.name()), ["auth", "person", "chat", "channel", "message"]);
  assert.deepEqual(
    program.commands[0]?.commands.map((command) => command.name()),
    ["login", "refresh", "whoami", "tokens", "logout"],
  );
  assert.deepEqual(program.commands[1]?.commands.map((command) => command.name()), ["search", "get", "image"]);
  const imageCommand = program.commands[1]?.commands.find((command) => command.name() === "image");
  assert.equal(imageCommand?.options.find((option) => option.long === "--size")?.defaultValue, "max");
  assert.deepEqual(program.commands[2]?.commands.map((command) => command.name()), ["list", "get"]);
  assert.deepEqual(program.commands[3]?.commands.map((command) => command.name()), ["list", "get"]);
  assert.deepEqual(program.commands[4]?.commands.map((command) => command.name()), ["list", "get", "send"]);
  assert.equal(program.commands.some((command) => command.name() === "chats"), false);
});

test("renders compact people and detailed person output", () => {
  const summary = {
    id: "person-1",
    mri: "8:orgid:person-1",
    displayName: "Ada Lovelace",
    email: "ada@example.com",
    jobTitle: "Programmer",
  };
  const search = renderPeople({ query: "Ada", people: [summary] });
  assert.match(search, /Ada Lovelace/);
  assert.match(search, /Programmer/);
  assert.match(search, /ada@example.com/);
  const profile = renderPerson({
    person: {
      ...summary,
      givenName: "Ada",
      surname: "Lovelace",
      mail: "ada@example.com",
      userPrincipalName: "ada@example.com",
      smtpAddresses: ["ada@example.com"],
      department: "Research",
      officeLocation: "London",
      mobile: null,
      telephoneNumber: null,
      phones: [],
      tenantName: "Example",
      userType: "Member",
      accountEnabled: true,
      teamsEnabled: true,
    },
  });
  assert.match(profile, /Department: Research/);
  assert.match(profile, /Account enabled: true/);
});

test("formats profile image output safely for raw and base64 modes", () => {
  const image = { data: Buffer.from([1, 2, 3]), contentType: "image/jpeg" };
  assert.deepEqual(personImageOutput(image, false, false), image.data);
  assert.equal(personImageOutput(image, true, true).toString("utf8"), "AQID\n");
  assert.throws(() => personImageOutput(image, false, true), /interactive terminal/);
});

test("shows an individual raw token without labels for piping", () => {
  assert.equal(renderTokens(session, "access", false), `${session.accessToken.value}\n`);
});

test("requires exactly one direct message target", () => {
  assert.deepEqual(selectedTarget({ chat: "chat-1" }), { kind: "chat", id: "chat-1" });
  assert.deepEqual(selectedTarget({ channel: "channel-1" }), { kind: "channel", id: "channel-1" });
  assert.throws(() => selectedTarget({}), /Exactly one/);
  assert.throws(() => selectedTarget({ chat: "chat-1", channel: "channel-1" }), /Exactly one/);
});

test("decodes JWT claims without showing the header or signature", () => {
  const rendered = renderTokens(session, "skype", true);
  assert.deepEqual(JSON.parse(rendered), { kind: "skype" });
  assert.doesNotMatch(rendered, /header|signature/);
});

test("shows audience and expiry before and after a token refresh", () => {
  const after: StoredSession = {
    ...session,
    accessToken: {
      value: jwt({ aud: "new-audience" }),
      expiresAt: "2027-02-01T00:00:00.000Z",
    },
  };
  const rendered = renderRefreshResult(
    { target: "access", before: session, after },
    new Date("2026-12-31T23:00:00.000Z"),
  );
  assert.match(rendered, /Before audience: unknown/);
  assert.match(rendered, /Before expiry: 2027-01-01T00:00:00.000Z \(1h remaining\)/);
  assert.match(rendered, /After audience: new-audience/);
  assert.match(rendered, /After expiry: 2027-02-01T00:00:00.000Z/);
  assert.doesNotMatch(rendered, /Skype token/);
});
