import assert from "node:assert/strict";
import test from "node:test";
import { clearStatus, configureDiagnostics, observedFetch, showStatus } from "../src/diagnostics.js";

async function captureStderr(operation: () => Promise<void> | void): Promise<string> {
  const original = process.stderr.write;
  let output = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    output += chunk.toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    await operation();
  } finally {
    process.stderr.write = original;
    configureDiagnostics({ progress: false, debug: false });
  }
  return output;
}

test("debug request output redacts identifiers and query values", async () => {
  const output = await captureStderr(async () => {
    configureDiagnostics({ progress: false, debug: true });
    await observedFetch(
      async () => new Response("{}", { status: 200 }),
      "https://example.test/v1/users/ME/conversations/secret-chat/messages/secret-message?token=secret",
    );
  });
  assert.match(output, /method=GET/);
  assert.match(output, /status=200/);
  assert.match(output, /conversations\/<redacted>\/messages\/<redacted>/);
  assert.doesNotMatch(output, /secret-chat|secret-message|token=secret/);
});

test("debug request output redacts person identifiers", async () => {
  const output = await captureStderr(async () => {
    configureDiagnostics({ progress: false, debug: true });
    await observedFetch(
      async () => new Response("{}", { status: 200 }),
      "https://teams.microsoft.com/api/mt/emea/beta/users/ada%40example.com/profilepicture?displayname=Ada",
    );
  });
  assert.match(output, /users\/<redacted>\/profilepicture/);
  assert.doesNotMatch(output, /ada|displayname/i);
});

test("disabled progress writes no status output", async () => {
  const output = await captureStderr(() => {
    configureDiagnostics({ progress: false, debug: false });
    showStatus("secret status");
  });
  assert.equal(output, "");
});

test("enabled progress updates and clears one stderr line", async () => {
  const output = await captureStderr(() => {
    configureDiagnostics({ progress: true, debug: false });
    showStatus("Loading channels…");
    showStatus("Refreshing Skype token…");
    clearStatus();
  });
  assert.match(output, /Loading channels/);
  assert.match(output, /Refreshing Skype token/);
  assert.match(output, /\x1b\[2K/);
});
