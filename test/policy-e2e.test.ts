import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stringify } from "yaml";
import { createProgram } from "../src/cli.js";
import { activatePolicy, initializePolicy } from "../src/policy.js";
import { saveSession, storagePaths, type StoredSession } from "../src/storage.js";

function jwt(payload: object): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

test("inactive policies audit while active policy denials make zero message POSTs", async () => {
  const root = await mkdtemp(join(tmpdir(), "teams-cli-policy-e2e-"));
  const subjectPath = await mkdtemp(join(tmpdir(), "teams-cli-subject-"));
  const otherSubject = await mkdtemp(join(tmpdir(), "teams-cli-other-subject-"));
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end();
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.hostname === "teams.microsoft.com" && url.pathname.startsWith("/api/csa/api/v1/teams/users/me")) {
      return Promise.resolve(new Response(JSON.stringify({
        chats: ["audit-chat", "denied-chat", "allowed-chat", "unrestricted-chat"].map((id) => ({ id, title: id, isOneOnOne: false, members: [] })),
        users: [],
        metadata: { hasMoreChats: false },
      }), { status: 200, headers: { "content-type": "application/json" } }));
    }
    return originalFetch(input, init);
  };
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Loopback server did not bind");
    const paths = storagePaths(root);
    const identity = { tenantId: "tenant", userId: "user" };
    const token = jwt({ tid: identity.tenantId, oid: identity.userId, exp: 2_000_000_000 });
    const session: StoredSession = {
      version: 3,
      browser: "edge",
      ...identity,
      savedAt: new Date().toISOString(),
      region: "test",
      accessToken: { value: token, expiresAt: "2033-05-18T03:33:20.000Z" },
      skypeToken: { value: token, expiresAt: "2033-05-18T03:33:20.000Z" },
      chatToken: { value: token, expiresAt: "2033-05-18T03:33:20.000Z" },
      searchToken: { value: token, expiresAt: "2033-05-18T03:33:20.000Z" },
      endpoints: { chatService: `http://127.0.0.1:${address.port}` },
    };
    await saveSession(paths, session);
    const policy = await initializePolicy(paths, "e2e", {
      profileName: "default",
      ...identity,
      browser: "edge",
    }, [], subjectPath);

    let auditWarnings = "";
    const originalErrorWrite = process.stderr.write;
    const originalWrite = process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      auditWarnings += chunk.toString();
      return true;
    }) as typeof process.stderr.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      await createProgram({ storageRoot: root, subjectPath }).parseAsync([
        "node", "teams-cli", "--tenant", identity.tenantId, "--user", identity.userId,
        "message", "send", "--chat", "audit-chat", "--body", "allowed in audit mode",
      ]);
    } finally {
      process.stderr.write = originalErrorWrite;
      process.stdout.write = originalWrite;
    }
    assert.match(auditWarnings, /inactive and not enforcing restrictions/);
    assert.match(auditWarnings, /would deny operation/);
    assert.equal(requests, 1);

    await activatePolicy(policy);
    if (process.platform !== "win32") await chmod(policy.file, 0o400);
    if (process.platform !== "win32") assert.equal((await stat(policy.file)).mode & 0o777, 0o400);

    const denied = createProgram({ storageRoot: root, subjectPath });
    await assert.rejects(
      denied.parseAsync([
        "node", "teams-cli", "--tenant", identity.tenantId, "--user", identity.userId,
        "message", "send", "--chat", "denied-chat", "--body", "must not be sent",
      ]),
      /Policy e2e denied operation/,
    );
    assert.equal(requests, 1);

    await assert.rejects(
      createProgram({ storageRoot: root, subjectPath }).parseAsync([
        "node", "teams-cli", "--tenant", identity.tenantId, "--user", identity.userId,
        "message", "list", "--chat", "denied-chat",
      ]),
      /read messages in chat denied-chat/,
    );
    assert.equal(requests, 1);

    await assert.rejects(
      createProgram({ storageRoot: root, subjectPath }).parseAsync([
        "node", "teams-cli", "--tenant", identity.tenantId, "--user", identity.userId,
        "auth", "tokens", "access",
      ]),
      /Policy e2e denied operation: raw token export/,
    );

    await chmod(policy.file, 0o600);
    await writeFile(policy.file, "version: [invalid\n", "utf8");
    await assert.rejects(
      createProgram({ storageRoot: root, subjectPath }).parseAsync([
        "node", "teams-cli", "--tenant", identity.tenantId, "--user", identity.userId,
        "message", "send", "--chat", "denied-chat", "--body", "must not be sent",
      ]),
      /Policy denied operation/,
    );
    assert.equal(requests, 1);

    await writeFile(policy.file, stringify({
      version: 1,
      name: "e2e",
      active: true,
      subject: { paths: [subjectPath] },
      identity: { allowed: [identity] },
      allow: {
        chats: { "allowed-chat": ["post"] },
        channels: {},
        rawTokenExport: false,
      },
    }), "utf8");
    if (process.platform !== "win32") await chmod(policy.file, 0o400);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      await createProgram({ storageRoot: root, subjectPath }).parseAsync([
        "node", "teams-cli", "--tenant", identity.tenantId, "--user", identity.userId,
        "message", "send", "--chat", "allowed-chat", "--body", "allowed by policy",
      ]);
    } finally {
      process.stdout.write = originalWrite;
    }
    assert.equal(requests, 2);

    await chmod(policy.file, 0o600).catch(() => undefined);
    await rm(policy.file, { force: true });
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      await createProgram({ storageRoot: root, subjectPath }).parseAsync([
        "node", "teams-cli", "--tenant", identity.tenantId, "--user", identity.userId,
        "message", "send", "--chat", "unrestricted-chat", "--body", "allowed without policy",
      ]);
    } finally {
      process.stdout.write = originalWrite;
    }
    assert.equal(requests, 3);

    const unrelated = await initializePolicy(paths, "unrelated", {
      profileName: "default",
      ...identity,
      browser: "edge",
    }, [], otherSubject);
    await writeFile(unrelated.file, "version: [invalid\n", "utf8");
    await assert.rejects(
      createProgram({ storageRoot: root, subjectPath }).parseAsync([
        "node", "teams-cli", "--tenant", identity.tenantId, "--user", identity.userId,
        "message", "send", "--chat", "unrestricted-chat", "--body", "must not be sent",
      ]),
      /Policy denied operation/,
    );
    assert.equal(requests, 3);
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
    await rm(subjectPath, { recursive: true, force: true });
    await rm(otherSubject, { recursive: true, force: true });
  }
});
