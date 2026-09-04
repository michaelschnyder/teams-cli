import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createProgram,
  personImageOutput,
  renderPeople,
  renderPerson,
  renderRefreshResult,
  renderTokens,
  selectedSendTarget,
  selectedTarget,
} from "../src/cli.js";
import { initializePolicy, resolvePolicyByName } from "../src/policy.js";
import { storagePaths, type StoredSession } from "../src/storage.js";
import { saveSession } from "../src/storage.js";
import { loadProfiles } from "../src/config.js";

function jwt(payload: object): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

const session: StoredSession = {
  version: 3,
  browser: "edge",
  tenantId: "tenant",
  userId: "user-id",
  savedAt: "2026-08-14T00:00:00.000Z",
  region: "emea",
  accessToken: { value: jwt({ kind: "access" }), expiresAt: "2027-01-01T00:00:00.000Z" },
  skypeToken: { value: jwt({ kind: "skype" }), expiresAt: "2027-01-01T00:00:00.000Z" },
  chatToken: { value: jwt({ kind: "chat" }), expiresAt: "2027-01-01T00:00:00.000Z" },
  searchToken: { value: jwt({ kind: "search" }), expiresAt: "2027-01-01T00:00:00.000Z" },
  endpoints: { chatService: "https://emea.ng.msg.teams.microsoft.com" },
};

test("exposes login plus the grouped CLI commands", () => {
  const program = createProgram();
  assert.ok(program.options.some((option) => option.long === "--version"));
  assert.match(program.options.find((option) => option.long === "--tenant")?.description ?? "", /Optional/);
  assert.match(program.options.find((option) => option.long === "--user")?.description ?? "", /Optional/);
  assert.deepEqual(program.commands.map((command) => command.name()), ["version", "skills", "login", "auth", "profile", "policy", "person", "chat", "channel", "message"]);
  const command = (name: string) => program.commands.find((candidate) => candidate.name() === name);
  assert.deepEqual(
    command("auth")?.commands.map((child) => child.name()),
    ["login", "refresh", "whoami", "tokens", "logout"],
  );
  assert.deepEqual(command("skills")?.commands.map((child) => child.name()), ["list", "path", "install", "reinstall"]);
  assert.deepEqual(command("profile")?.commands.map((child) => child.name()), ["list", "show", "save", "remove"]);
  assert.deepEqual(
    command("policy")?.commands.map((child) => child.name()),
    ["init", "list", "show", "check", "activate", "edit"],
  );
  assert.deepEqual(command("person")?.commands.map((child) => child.name()), ["search", "get", "image"]);
  const imageCommand = command("person")?.commands.find((child) => child.name() === "image");
  assert.equal(imageCommand?.options.find((option) => option.long === "--size")?.defaultValue, "max");
  assert.deepEqual(command("chat")?.commands.map((child) => child.name()), ["search", "list", "get"]);
  assert.ok(command("chat")?.commands.find((child) => child.name() === "list")?.options.some((option) => option.long === "--all"));
  assert.deepEqual(command("channel")?.commands.map((child) => child.name()), ["list", "get"]);
  assert.deepEqual(command("message")?.commands.map((child) => child.name()), ["list", "get", "send"]);
  assert.ok(command("message")?.commands.find((child) => child.name() === "send")?.options.some((option) => option.long === "--person"));
  assert.equal(program.commands.some((command) => command.name() === "chats"), false);
});

test("keeps piped --version terse and provides structured version metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "teams-cli-version-"));
  let stdout = "";
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    await createProgram({ storageRoot: root }).parseAsync(["node", "teams-cli", "--version"]);
    assert.equal(stdout, "0.1.0\n");
    stdout = "";
    await createProgram({
      storageRoot: root,
      fetcher: async () => new Response(JSON.stringify({ version: "0.1.0" }), { status: 200 }),
    }).parseAsync(["node", "teams-cli", "version", "--json"]);
    const output = JSON.parse(stdout) as { installed: { version: string; channel: string }; update: { status: string } };
    assert.equal(output.installed.version, "0.1.0");
    assert.equal(output.installed.channel, "local");
    assert.equal(output.update.status, "current");
  } finally {
    process.stdout.write = originalWrite;
    await rm(root, { recursive: true, force: true });
  }
});

test("top-level login runs the default login flow", async () => {
  const root = await mkdtemp(join(tmpdir(), "teams-cli-login-alias-"));
  const loggedIn: StoredSession = {
    ...session,
    tenantId: "alias-tenant",
    userId: "alias-user",
    username: "alias@example.test",
  };
  let calls = 0;
  try {
    await createProgram({
      storageRoot: root,
      loginImplementation: async (paths, options) => {
        calls += 1;
        assert.equal(options.browser, "edge");
        await saveSession(paths, loggedIn);
        return loggedIn;
      },
    }).parseAsync(["node", "teams-cli", "login"]);
    assert.equal(calls, 1);
    assert.deepEqual((await loadProfiles(storagePaths(root))).profiles.default, {
      tenantId: "alias-tenant",
      userId: "alias-user",
      username: "alias@example.test",
      browser: "edge",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("chat collection commands require confirmation before an unpaged full enumeration", async () => {
  const questions: string[] = [];
  await assert.rejects(
    createProgram({
      confirm: async (question) => {
        questions.push(question);
        return false;
      },
    }).parseAsync(["node", "teams-cli", "chat", "list", "--json"]),
    /Use `teams-cli chat search <query>` first, or pass `--all`/,
  );
  assert.match(questions[0] ?? "", /complete chat history/);
  await assert.rejects(
    createProgram({
      confirm: async (question) => {
        questions.push(question);
        return false;
      },
    }).parseAsync(["node", "teams-cli", "chat", "get", "chat-id", "--json"]),
    /Use `teams-cli chat search <query>` first, or pass `--all`/,
  );
  assert.match(questions[1] ?? "", /complete chat history/);
});

test("activates a named policy and prints filesystem protection guidance", async () => {
  const root = await mkdtemp(join(tmpdir(), "teams-cli-policy-activate-"));
  const subjectPath = await mkdtemp(join(tmpdir(), "teams-cli-policy-subject-"));
  try {
    const paths = storagePaths(root);
    await initializePolicy(paths, "agent", {
      profileName: "default",
      tenantId: "tenant",
      userId: "user",
      browser: "edge",
    }, [], subjectPath);
    let stdout = "";
    let stderr = "";
    const originalWrite = process.stdout.write;
    const originalErrorWrite = process.stderr.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout += chunk.toString();
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr += chunk.toString();
      return true;
    }) as typeof process.stderr.write;
    try {
      await createProgram({ storageRoot: root, subjectPath }).parseAsync([
        "node", "teams-cli", "policy", "activate", "agent",
      ]);
    } finally {
      process.stdout.write = originalWrite;
      process.stderr.write = originalErrorWrite;
    }

    assert.equal((await resolvePolicyByName(paths, "agent")).policy.active, true);
    assert.match(stdout, /Activated policy agent/);
    assert.match(stderr, process.platform === "win32" ? /read-only ACL/ : /chmod 400/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(subjectPath, { recursive: true, force: true });
  }
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
      tenantId: "tenant",
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

test("accepts an email recipient as the only send target", () => {
  assert.equal(selectedSendTarget({ person: "ada@example.com" }), "ada@example.com");
  assert.deepEqual(selectedSendTarget({ chat: "chat-1" }), { kind: "chat", id: "chat-1" });
  assert.throws(() => selectedSendTarget({}), /Exactly one of --person, --chat, or --channel/);
  assert.throws(
    () => selectedSendTarget({ person: "ada@example.com", chat: "chat-1" }),
    /Exactly one of --person, --chat, or --channel/,
  );
});

test("offers first-time users an interactive login and saves the discovered default identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "teams-cli-first-command-login-"));
  const discovered: StoredSession = {
    ...session,
    tenantId: "discovered-tenant",
    userId: "discovered-user",
    username: "ada@example.test",
    accessToken: {
      value: jwt({ tid: "discovered-tenant", oid: "discovered-user", kind: "access" }),
      expiresAt: "2027-01-01T00:00:00.000Z",
    },
  };
  const questions: string[] = [];
  try {
    await createProgram({
      storageRoot: root,
      confirm: async (question) => {
        questions.push(question);
        return true;
      },
      loginImplementation: async (paths, options) => {
        assert.equal(options.tenant, undefined);
        assert.equal(options.user, undefined);
        await options.authorizeIdentity?.(discovered);
        await saveSession(paths, discovered);
        return discovered;
      },
    }).parseAsync(["node", "teams-cli", "auth", "tokens", "access", "--decode"]);

    assert.match(questions[0] ?? "", /No Teams session is configured/);
    assert.deepEqual((await loadProfiles(storagePaths(root))).profiles.default, {
      tenantId: "discovered-tenant",
      userId: "discovered-user",
      username: "ada@example.test",
      browser: "edge",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
