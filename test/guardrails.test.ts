import assert from "node:assert/strict";
import test from "node:test";
import { isTargetAllowed, parseGuardrails } from "../src/guardrails.js";

const guardrails = parseGuardrails({ chats: ["chat-1"], channels: ["channel-1"] });

test("allows only exact IDs under the selected target type", () => {
  assert.equal(isTargetAllowed(guardrails, { kind: "chat", id: "chat-1" }), true);
  assert.equal(isTargetAllowed(guardrails, { kind: "channel", id: "channel-1" }), true);
  assert.equal(isTargetAllowed(guardrails, { kind: "chat", id: "channel-1" }), false);
  assert.equal(isTargetAllowed(guardrails, { kind: "chat", id: "CHAT-1" }), false);
});

test("rejects guardrail fields beyond chats and channels", () => {
  assert.throws(
    () => parseGuardrails({ chats: [], channels: [], teams: [] }),
    /must contain only/,
  );
  assert.throws(() => parseGuardrails({ chats: [], channels: [1] }), /must contain only/);
});
