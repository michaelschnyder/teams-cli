import assert from "node:assert/strict";
import test from "node:test";
import { summarizeConversations } from "../src/teams-client.js";

test("summarizes conversations without exposing unresolved member identifiers", () => {
  const result = summarizeConversations({
    users: [{ mri: "8:orgid:known", displayName: "Ada Lovelace" }],
    chats: [
      {
        id: "19:chat@thread.v2",
        isOneOnOne: true,
        members: [{ mri: "8:orgid:known" }, { mri: "8:orgid:unknown" }],
        lastMessage: { composeTime: "2026-08-07T10:00:00Z" },
      },
    ],
    teams: [
      {
        id: "team-1",
        displayName: "Engineering",
        channels: [{ id: "channel-1", displayName: "General" }],
      },
    ],
  });

  assert.equal(result.chats[0]?.title, "Ada Lovelace");
  assert.deepEqual(result.chats[0]?.members, ["Ada Lovelace"]);
  assert.deepEqual(result.teams[0]?.channels, [{ id: "channel-1", name: "General" }]);
});
