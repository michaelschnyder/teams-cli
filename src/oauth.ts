import { randomUUID } from "node:crypto";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import {
  SKYPE_RESOURCE,
  TEAMS_CLIENT_ID,
  TEAMS_REDIRECT_URI,
} from "./constants.js";

export type LoginOptions = {
  profileDirectory: string;
  browser: BrowserName;
  interactive: boolean;
  tenant?: string;
  timeoutMs?: number;
};

export type BrowserName = "edge" | "chrome";

export function browserChannel(browser: BrowserName): "msedge" | "chrome" {
  return browser === "edge" ? "msedge" : "chrome";
}

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
  try {
    context = await chromium.launchPersistentContext(options.profileDirectory, {
      channel: browserChannel(options.browser),
      headless: !options.interactive,
      viewport: null,
      args: ["--no-first-run"],
    });
  } catch (error) {
    const label = options.browser === "edge" ? "Microsoft Edge" : "Google Chrome";
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not launch ${label}. Confirm it is installed and available: ${message}`);
  }
  const close = () => context.close();

  const page = context.pages()[0] ?? (await context.newPage());
  const tokenPromise = waitForToken(page, options.timeoutMs ?? 5 * 60_000);
  try {
    await page.goto(
      createResourceTokenUrl(
        SKYPE_RESOURCE,
        options.tenant,
        options.interactive ? "select_account" : "none",
      ),
      { waitUntil: "domcontentloaded" },
    );
    return { close, token: await tokenPromise };
  } catch (error) {
    await close();
    await tokenPromise.catch(() => undefined);
    throw error;
  }
}
