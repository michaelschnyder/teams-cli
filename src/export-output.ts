import type { StoredSession } from "./storage.js";
import type { PersonImage } from "./teams-client.js";
import { decodeJwtClaims } from "./jwt.js";
import { rawResult } from "./output.js";
export type TokenTarget = "all" | "access" | "skype" | "chat" | "search";
function selectedTokens(session: StoredSession, target: TokenTarget): Record<string, string> {
  const all = {
    access: session.accessToken.value,
    skype: session.skypeToken.value,
    chat: session.chatToken.value,
    search: session.searchToken.value,
  };
  return target === "all" ? all : { [target]: all[target] };
}

export function renderTokens(
  session: StoredSession,
  target: TokenTarget,
  decode: boolean,
): string {
  const selected = selectedTokens(session, target);
  if (decode) {
    const claims = Object.fromEntries(
      Object.entries(selected).map(([name, token]) => [name, decodeJwtClaims(token)]),
    );
    const output = target === "all" ? claims : Object.values(claims)[0];
    return `${JSON.stringify(output, null, 2)}\n`;
  }
  if (target !== "all") return `${Object.values(selected)[0]}\n`;
  return [
    `Access token:\n${selected.access}`,
    `Skype token:\n${selected.skype}`,
    `Chat token:\n${selected.chat}`,
    `Search token:\n${selected.search}`,
  ].join("\n\n") + "\n";
}

export function personImageOutput(
  image: PersonImage,
  base64: boolean,
  stdoutIsTTY: boolean,
): Buffer {
  if (!base64 && stdoutIsTTY) {
    throw new Error("Refusing to write a raw profile image to an interactive terminal. Pipe it to a file or use --base64.");
  }
  return base64 ? Buffer.from(`${image.data.toString("base64")}\n`, "utf8") : image.data;
}

export function tokenExport(session: StoredSession, target: TokenTarget) { return rawResult(Buffer.from(renderTokens(session, target, false))); }
export function imageExport(image: PersonImage, base64: boolean, stdoutIsTTY: boolean) { return rawResult(personImageOutput(image, base64, stdoutIsTTY)); }
