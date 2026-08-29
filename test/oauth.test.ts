import assert from "node:assert/strict";
import test from "node:test";
import { SKYPE_RESOURCE, TEAMS_CLIENT_ID } from "../src/constants.js";
import {
  createInitialTokenUrl,
  createResourceTokenUrl,
  browserChannel,
  completePasswordLogin,
  tokenFromRedirect,
} from "../src/oauth.js";

test("maps supported browsers to Playwright branded channels", () => {
  assert.equal(browserChannel("edge"), "msedge");
  assert.equal(browserChannel("chrome"), "chrome");
});

test("creates a first-party Teams authorization URL", () => {
  const url = new URL(createInitialTokenUrl("example-tenant"));
  assert.equal(url.pathname, "/example-tenant/oauth2/authorize");
  assert.equal(url.searchParams.get("client_id"), TEAMS_CLIENT_ID);
  assert.equal(url.searchParams.get("resource"), SKYPE_RESOURCE);
  assert.equal(url.searchParams.get("response_type"), "token");
});

test("creates an authorization URL for another Teams resource", () => {
  const resource = "https://chatsvcagg.teams.microsoft.com";
  const url = new URL(createResourceTokenUrl(resource));
  assert.equal(url.searchParams.get("resource"), resource);
});

test("can request silent authentication from a preserved profile", () => {
  const url = new URL(createResourceTokenUrl(SKYPE_RESOURCE, "organizations", "none"));
  assert.equal(url.searchParams.get("prompt"), "none");
});

test("extracts only an access token from the expected callback", () => {
  assert.equal(
    tokenFromRedirect("https://teams.microsoft.com/go#access_token=secret&token_type=Bearer"),
    "secret",
  );
  assert.equal(tokenFromRedirect("https://example.com/go#access_token=secret"), undefined);
});

test("submits Microsoft username and password forms by clicking their controls", async () => {
  const actions: string[] = [];
  const input = (name: string) => ({
    waitFor: async () => { actions.push(`wait:${name}`); },
    fill: async () => { actions.push(`fill:${name}`); },
  });
  const submit = {
    click: async () => { actions.push("click:submit"); },
  };
  const staySignedIn = {
    waitFor: async () => { actions.push("wait:stay-signed-in"); },
    click: async () => { actions.push("click:stay-signed-in"); },
  };
  const page = {
    locator: (selector: string) => ({
      first: () => selector.includes("loginfmt")
        ? input("username")
        : selector.includes("passwd")
          ? input("password")
          : selector.includes('value="Yes"')
            ? staySignedIn
            : submit,
    }),
  } as unknown as Parameters<typeof completePasswordLogin>[0];

  await completePasswordLogin(page, "alice@example.test", "not-a-real-password", 1_000);

  assert.deepEqual(actions, [
    "wait:username",
    "fill:username",
    "click:submit",
    "wait:password",
    "fill:password",
    "click:submit",
    "wait:stay-signed-in",
    "click:stay-signed-in",
  ]);
});
