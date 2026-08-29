import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { chmod, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { stringify } from "yaml";
import { login, validateSession } from "../../src/auth.js";
import { createProgram } from "../../src/cli.js";
import { loadProfiles, saveProfile } from "../../src/config.js";
import { withDataSession } from "../../src/data.js";
import type { BrowserName } from "../../src/oauth.js";
import {
  activatePolicy,
  initializePolicy,
  resolvePolicyByName,
} from "../../src/policy.js";
import {
  loadSession,
  storagePaths,
  type Identity,
  type StoragePaths,
  type StoredSession,
} from "../../src/storage.js";
import {
  listChannels,
  listMessages,
  type ChannelSummary,
} from "../../src/teams-client.js";

const repository = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const environmentFile = join(repository, ".env.e2e.local");
const e2eStorageRoot = join(repository, ".e2e", "state");

// These are portable fixture names, not tenant-specific IDs or configuration.
const TEST_TEAM_NAME = "teams-cli-e2e";
const ALLOWED_CHANNEL_NAME = "allowed";
const DENIED_CHANNEL_NAME = "denied";
const ALICE_PROFILE = "e2e-alice";
const BOB_PROFILE = "e2e-bob";

type AccountConfiguration = { username: string; password: string };
type E2EConfiguration = {
  tenantId: string;
  browser: BrowserName;
  headless: boolean;
  alice: AccountConfiguration;
  bob: AccountConfiguration;
};

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is missing from ${environmentFile}`);
  if (/^(replace|change-me|todo|example)/i.test(value)) {
    throw new Error(`${name} still contains a placeholder in ${environmentFile}`);
  }
  return value;
}

function loadE2EConfiguration(): E2EConfiguration {
  try {
    process.loadEnvFile(environmentFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Create ${environmentFile} from .env.e2e.example before running E2E tests`);
    }
    throw error;
  }
  if (process.platform !== "win32" && (statSync(environmentFile).mode & 0o077) !== 0) {
    throw new Error(`Protect E2E secrets with: chmod 600 ${environmentFile}`);
  }
  const browserValue = process.env.TEAMS_CLI_E2E_BROWSER?.trim() || "edge";
  if (browserValue !== "edge" && browserValue !== "chrome") {
    throw new Error("TEAMS_CLI_E2E_BROWSER must be edge or chrome");
  }
  const configuration: E2EConfiguration = {
    tenantId: requiredEnvironment("TEAMS_CLI_E2E_TENANT_ID"),
    browser: browserValue,
    headless: process.env.TEAMS_CLI_E2E_HEADLESS?.trim().toLowerCase() !== "false",
    alice: {
      username: requiredEnvironment("TEAMS_CLI_E2E_ALICE_USERNAME"),
      password: requiredEnvironment("TEAMS_CLI_E2E_ALICE_PASSWORD"),
    },
    bob: {
      username: requiredEnvironment("TEAMS_CLI_E2E_BOB_USERNAME"),
      password: requiredEnvironment("TEAMS_CLI_E2E_BOB_PASSWORD"),
    },
  };
  if (configuration.alice.username === configuration.bob.username) {
    throw new Error("Alice and Bob must use different Microsoft login names");
  }
  return configuration;
}

async function reusableSession(
  paths: StoragePaths,
  profileName: string,
  configuration: E2EConfiguration,
  account: AccountConfiguration,
): Promise<StoredSession | null> {
  const profile = (await loadProfiles(paths)).profiles[profileName];
  if (
    profile?.tenantId !== configuration.tenantId ||
    !profile.userId ||
    profile.username !== account.username
  ) return null;
  const identity = { tenantId: profile.tenantId, userId: profile.userId };
  try {
    await loadSession(paths, identity);
    return await validateSession(paths, identity, configuration.browser);
  } catch {
    return null;
  }
}

async function ensureAccountSession(
  paths: StoragePaths,
  profileName: string,
  configuration: E2EConfiguration,
  account: AccountConfiguration,
): Promise<StoredSession> {
  const existing = await reusableSession(paths, profileName, configuration, account);
  if (existing) return existing;
  const session = await login(paths, {
    browser: configuration.browser,
    tenant: configuration.tenantId,
    username: account.username,
    password: account.password,
    headless: configuration.headless,
  });
  await saveProfile(paths, profileName, {
    tenantId: session.tenantId,
    userId: session.userId,
    username: account.username,
    browser: configuration.browser,
  });
  return session;
}

function findNamedChannel(channels: ChannelSummary[], name: string): ChannelSummary {
  const matches = channels.filter((channel) =>
    channel.team.name === TEST_TEAM_NAME && channel.name === name);
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one ${TEST_TEAM_NAME}/${name} channel, found ${matches.length}. ` +
      `Create team ${TEST_TEAM_NAME} with channels ${ALLOWED_CHANNEL_NAME} and ${DENIED_CHANNEL_NAME}.`,
    );
  }
  return matches[0] as ChannelSummary;
}

async function discoverFixtureChannels(
  paths: StoragePaths,
  session: StoredSession,
  browser: BrowserName,
): Promise<{ allowed: ChannelSummary; denied: ChannelSummary }> {
  const identity = { tenantId: session.tenantId, userId: session.userId };
  const result = await withDataSession(paths, identity, browser, ["chat", "skype"], (current) =>
    listChannels(current));
  return {
    allowed: findNamedChannel(result.channels, ALLOWED_CHANNEL_NAME),
    denied: findNamedChannel(result.channels, DENIED_CHANNEL_NAME),
  };
}

async function configureActivePolicy(
  paths: StoragePaths,
  identity: Identity,
  browser: BrowserName,
  allowedChannelId: string,
): Promise<void> {
  await rm(paths.policiesDirectory, { recursive: true, force: true });
  const initialized = await initializePolicy(paths, "e2e", {
    profileName: ALICE_PROFILE,
    ...identity,
    browser,
  }, [], repository);
  await writeFile(initialized.file, stringify({
    version: 2,
    name: "e2e",
    active: false,
    subject: { paths: [repository] },
    identity,
    allow: {
      messageSend: { chats: [], channels: [allowedChannelId] },
      rawTokenExport: false,
    },
  }), "utf8");
  const activated = await activatePolicy(await resolvePolicyByName(paths, "e2e"));
  if (process.platform !== "win32") await chmod(activated.file, 0o400);
}

async function runCli(args: string[]): Promise<string> {
  const program = createProgram({ storageRoot: e2eStorageRoot, subjectPath: repository });
  let output = "";
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    await program.parseAsync(["node", "teams-cli", ...args]);
    return output;
  } finally {
    process.stdout.write = originalWrite;
  }
}

async function channelContains(
  paths: StoragePaths,
  identity: Identity,
  browser: BrowserName,
  channelId: string,
  marker: string,
): Promise<boolean> {
  const page = await withDataSession(paths, identity, browser, "skype", (session) =>
    listMessages(session, { kind: "channel", id: channelId }, { pageSize: 200 }));
  return page.messages.some((message) => message.content?.includes(marker));
}

async function waitUntilVisible(
  paths: StoragePaths,
  identity: Identity,
  browser: BrowserName,
  channelId: string,
  marker: string,
): Promise<void> {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    if (await channelContains(paths, identity, browser, channelId, marker)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`Message ${marker} did not become visible to Bob within 30 seconds`);
}

test("live Teams login, identity isolation, channel discovery, and policy enforcement", {
  timeout: 10 * 60_000,
}, async (context) => {
  const configuration = loadE2EConfiguration();
  const paths = storagePaths(e2eStorageRoot);

  await context.test("loads both passwords from the ignored environment file", () => {
    assert.ok(configuration.alice.password.length > 0);
    assert.ok(configuration.bob.password.length > 0);
  });

  const alice = await ensureAccountSession(paths, ALICE_PROFILE, configuration, configuration.alice);
  const bob = await ensureAccountSession(paths, BOB_PROFILE, configuration, configuration.bob);
  assert.equal(alice.tenantId, configuration.tenantId);
  assert.equal(bob.tenantId, configuration.tenantId);
  assert.notEqual(alice.userId, bob.userId);

  const aliceChannels = await discoverFixtureChannels(paths, alice, configuration.browser);
  const bobChannels = await discoverFixtureChannels(paths, bob, configuration.browser);
  assert.equal(aliceChannels.allowed.id, bobChannels.allowed.id);
  assert.equal(aliceChannels.denied.id, bobChannels.denied.id);

  const aliceIdentity = { tenantId: alice.tenantId, userId: alice.userId };
  const bobIdentity = { tenantId: bob.tenantId, userId: bob.userId };
  await configureActivePolicy(paths, aliceIdentity, configuration.browser, aliceChannels.allowed.id);

  const allowedMarker = `teams-cli-e2e-allowed-${Date.now()}-${randomUUID()}`;
  await runCli([
    "--profile", ALICE_PROFILE,
    "message", "send",
    "--channel", aliceChannels.allowed.id,
    "--body", allowedMarker,
  ]);
  await waitUntilVisible(
    paths,
    bobIdentity,
    configuration.browser,
    bobChannels.allowed.id,
    allowedMarker,
  );

  const deniedMarker = `teams-cli-e2e-denied-${Date.now()}-${randomUUID()}`;
  await assert.rejects(
    runCli([
      "--profile", ALICE_PROFILE,
      "message", "send",
      "--channel", aliceChannels.denied.id,
      "--body", deniedMarker,
    ]),
    /Policy e2e denied operation/,
  );
  assert.equal(
    await channelContains(paths, bobIdentity, configuration.browser, bobChannels.denied.id, deniedMarker),
    false,
  );
});
