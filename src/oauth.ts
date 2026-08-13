import { randomUUID } from "node:crypto";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import {
  SKYPE_RESOURCE,
  TEAMS_CLIENT_ID,
  TEAMS_REDIRECT_URI,
} from "./constants.js";

export type LoginOptions = {
  profileDirectory?: string;
  tenant?: string;
  timeoutMs?: number;
};

export class OAuthRedirectError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "OAuthRedirectError";
  }
}

export function createResourceTokenUrl(
  resource: string,
  tenant = "organizations",
  prompt: "none" | "select_account" = "select_account",
): string {
  const url = new URL(`https://login.microsoftonline.com/${tenant}/oauth2/authorize`);
  url.searchParams.set("client_id", TEAMS_CLIENT_ID);
  url.searchParams.set("response_type", "token");
  url.searchParams.set("redirect_uri", TEAMS_REDIRECT_URI);
  url.searchParams.set("resource", resource);
  url.searchParams.set("state", `${randomUUID()}|${resource}`);
  url.searchParams.set("client-request-id", randomUUID());
  url.searchParams.set("nonce", randomUUID());
  url.searchParams.set("prompt", prompt);
  return url.toString();
}

export function createInitialTokenUrl(tenant = "organizations"): string {
  return createResourceTokenUrl(SKYPE_RESOURCE, tenant);
}

export function tokenFromRedirect(urlString: string): string | undefined {
  const url = new URL(urlString);
  if (url.origin !== "https://teams.microsoft.com" || url.pathname !== "/go") {
    return undefined;
  }
  const params = new URLSearchParams(url.hash.slice(1));
  const error = params.get("error");
  if (error) {
    throw new OAuthRedirectError(error, params.get("error_description") ?? error);
  }
  return params.get("access_token") ?? undefined;
}

async function waitForToken(page: Page, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      page.off("framenavigated", onNavigation);
      page.off("close", onClose);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Login timed out after ${Math.round(timeoutMs / 1000)} seconds`));
    }, timeoutMs);

    const inspect = (url: string) => {
      try {
        const token = tokenFromRedirect(url);
        if (token) {
          cleanup();
          resolve(token);
        }
      } catch (error) {
        cleanup();
        reject(error);
      }
    };

    const onNavigation = (frame: import("playwright-core").Frame) => {
      if (frame === page.mainFrame()) inspect(frame.url());
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Edge was closed before login completed"));
    };
    page.on("framenavigated", onNavigation);
    page.on("close", onClose);
  });
}

export async function acquireInitialToken(
  options: LoginOptions,
): Promise<{ close: () => Promise<void>; token: string }> {
  let context: BrowserContext;
  let close: () => Promise<void>;

  if (options.profileDirectory) {
    context = await chromium.launchPersistentContext(options.profileDirectory, {
      channel: "msedge",
      headless: false,
      viewport: null,
      args: ["--no-first-run"],
    });
    close = () => context.close();
  } else {
    const browser = await chromium.launch({
      channel: "msedge",
      headless: false,
      args: ["--no-first-run"],
    });
    context = await browser.newContext({ viewport: null });
    close = () => browser.close();
  }

  const page = context.pages()[0] ?? (await context.newPage());
  const tokenPromise = waitForToken(page, options.timeoutMs ?? 5 * 60_000);
  await page.goto(createInitialTokenUrl(options.tenant), { waitUntil: "domcontentloaded" });

  try {
    return { close, token: await tokenPromise };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function acquireResourceTokens(
  resources: readonly string[],
  options: LoginOptions,
): Promise<{ close: () => Promise<void>; tokens: Map<string, string> }> {
  if (resources.length === 0) throw new Error("At least one resource is required");

  let context: BrowserContext;
  let close: () => Promise<void>;
  if (options.profileDirectory) {
    context = await chromium.launchPersistentContext(options.profileDirectory, {
      channel: "msedge",
      headless: false,
      viewport: null,
      args: ["--no-first-run"],
    });
    close = () => context.close();
  } else {
    const browser = await chromium.launch({
      channel: "msedge",
      headless: false,
      args: ["--no-first-run"],
    });
    context = await browser.newContext({ viewport: null });
    close = () => browser.close();
  }

  const page = context.pages()[0] ?? (await context.newPage());
  const tokens = new Map<string, string>();
  const navigateForToken = async (
    resource: string,
    prompt: "none" | "select_account",
  ): Promise<string> => {
    const tokenPromise = waitForToken(page, options.timeoutMs ?? 5 * 60_000);
    await page.goto(createResourceTokenUrl(resource, options.tenant, prompt), {
      waitUntil: "domcontentloaded",
    });
    return tokenPromise;
  };
  try {
    for (const resource of resources) {
      if (options.profileDirectory) {
        try {
          tokens.set(resource, await navigateForToken(resource, "none"));
          continue;
        } catch (error) {
          if (!(error instanceof OAuthRedirectError) || error.code !== "interaction_required") {
            throw error;
          }
        }
      }
      tokens.set(resource, await navigateForToken(resource, "select_account"));
    }
    return { close, tokens };
  } catch (error) {
    await close();
    throw error;
  }
}
