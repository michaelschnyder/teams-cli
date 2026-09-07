import { type RefreshResult } from "./auth.js";
import { formatDuration } from "./jwt.js";
import type { View } from "./presentation.js";
import { renderView } from "./presentation.js";
import { renderDoctor } from "./presenters/doctor.js";
import { renderVersion } from "./presenters/version.js";
import { safeRefresh, type Results, type SafeSession } from "./results.js";
import type { PersonResult, PersonSearchResult } from "./teams-client.js";

function label(key: string): string {
  if (key === "id") return "ID";
  if (key === "mri") return "MRI";
  const spaced = key.replace(/([a-z])([A-Z])/g, (_, left: string, right: string) => `${left} ${right.toLowerCase()}`).replace(/\bid\b/g, "ID");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
const fields = (record: object): Array<[string, unknown]> => Object.entries(record).map(([key, value]) => [label(key), value]);
function details(title: string, record: object): View {
  const simple: Array<[string, unknown]> = [];
  const sections: View[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (value && typeof value === "object") {
      if (Array.isArray(value) && value.every(item => item === null || typeof item !== "object")) simple.push([label(key), value.join(", ")]);
      else sections.push(details(label(key), value));
    } else simple.push([label(key), value]);
  }
  const base: View = { kind: "details", title, fields: simple };
  return sections.length ? { kind: "sections", title, sections: [...(simple.length ? [{ ...base, title: "" }] : []), ...sections] } : base;
}
function table(title: string, headers: string[], rows: unknown[][], cursor?: string | null): View { return { kind: "table", title, headers, rows, ...(cursor ? { footer: `Next cursor: ${cursor}` } : {}) }; }
const presenters: { [K in keyof Results]: (data: Results[K]) => View } = {
  doctor: data => ({ kind: "text", text: renderDoctor(data) }),
  version: data => ({ kind: "text", text: renderVersion(data.installed, data.updateChannel, data.update.candidate, data.update.status) }),
  skills: data => ({ kind: "text", text: [...data.installations.map(item => `${item.status === "installed" ? "Installed" : "Already installed"} ${item.label}: ${item.destination}${item.status === "conflict" ? " (existing files differ; use --force to replace them)" : ""}`), ...(data.cowork ? [`Upload ${data.cowork.file}`, data.cowork.instruction] : [])].join("\n") }),
  people: data => table(`People (${data.people.length})`, ["Name", "Job title", "Email", "Person ID"], data.people.map(p => [p.displayName, p.jobTitle, p.email, p.id])),
  person: data => details(data.person.displayName ?? "Person", data.person),
  chats: data => table(`Chats (${data.chats.length})`, ["Chat", "Participants", "Last activity", "Chat ID"], data.chats.map(c => [c.title, c.participants.map(p => p.displayName ?? p.id).join(", "), c.lastActivity, c.id]), data.page.nextCursor),
  chat: data => details(data.chat.title, { id: data.chat.id, participants: data.chat.participants.map(p => p.displayName ?? p.id).join(", ") }),
  channels: data => table(`Channels (${data.channels.length})`, ["Channel", "Team", "Channel ID"], data.channels.map(c => [c.name, c.team.name, c.id])),
  channel: data => details(data.channel.name, data.channel),
  messages: data => ({ kind: "messages", title: `Messages (${data.messages.length}) for ${data.target.kind} ${data.target.id}`, messages: data.messages.map(message => ({ heading: `${message.composedAt ?? message.originalArrivalAt ?? "unknown time"} ${message.sender.displayName ?? message.sender.id ?? "unknown"} [${message.id}]`, content: message.content ?? "" })), ...(data.page.nextCursor ? { footer: `Next cursor: ${data.page.nextCursor}` } : {}) }),
  message: data => presenters.messages({ target: data.target, messages: [data.message], page: { nextCursor: null } }),
  sent: data => ({ kind: "text", text: `Sent message${data.message ? ` ${data.message.id}` : ""} to ${data.target.kind} ${data.target.id}.` }),
  session: data => {
    const view: View = { kind: "details", title: "Authenticated", fields: [...fields(data.user), ...Object.entries(data.tokens).flatMap(([name, token]): Array<[string, unknown]> => [[`${name} audience`, token.audience], [`${name} expires`, `${token.expiresAt} (${token.expiresInSeconds}s remaining)`]])] };
    return data.skillInstallation ? { kind: "sections", title: "Sign-in complete", sections: [presenters.skills(data.skillInstallation), view] } : view;
  },
  refresh: data => {
    const targets = data.target === "all" ? ["access", "skype", "chat", "search"] as const : [data.target];
    return {
      kind: "sections", title: `Refreshed ${data.target} tokens`, sections: targets.map(target => {
        const key = `${target}Token` as keyof SafeSession["tokens"];
        const before = data.before.tokens[key], after = data.after.tokens[key];
        return {
          kind: "details", title: `${label(target)} token`, fields: [
            ["Before audience", before.audience ?? "unknown"],
            ["Before expiry", `${before.expiresAt} (${formatDuration(before.expiresInSeconds)} remaining)`],
            ["After audience", after.audience ?? "unknown"],
            ["After expiry", `${after.expiresAt} (${formatDuration(after.expiresInSeconds)} remaining)`],
          ]
        };
      })
    };
  },
  ack: data => details(data.action, Object.fromEntries(Object.entries(data).filter(([key]) => key !== "action"))),
  record: data => details("Details", data),
  list: data => { const headers = [...new Set(data.items.flatMap(item => Object.keys(item)))]; return table(`${data.title} (${data.items.length})`, headers, data.items.map(item => headers.map(key => Object.fromEntries(Object.entries(item))[key]))); },
  image: data => details("Image", data),
  tokens: data => details("Tokens", data),
};
export function present<K extends keyof Results>(kind: K, data: Results[K]): View { return presenters[kind](data); }

// Pure presenter entrypoints for focused renderer tests.
export function renderPeople(data: PersonSearchResult): string { return renderView(present("people", data), {}); }
export function renderPerson(data: PersonResult): string { return renderView(present("person", data), {}); }
export function renderRefreshResult(data: RefreshResult, now = new Date()): string { return renderView(present("refresh", safeRefresh(data, now)), {}); }
