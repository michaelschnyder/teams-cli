import { describeSession, type RefreshResult, type WhoamiResult } from "./auth.js";
import type { DoctorReport } from "./doctor.js";
import { readJwtMetadata, secondsUntil } from "./jwt.js";
import type { UpdateChannel } from "./settings.js";
import type { SkillInstallResult } from "./skill-installation.js";
import type { StoredSession, StoredToken } from "./storage.js";
import type { ChannelList, ChannelResult, ChatPage, ChatResult, MessagePage, MessageResult, MessageSendResult, PersonResult, PersonSearchResult } from "./teams-client.js";
import type { UpdateCandidate } from "./update.js";
import type { BuildInfo } from "./version.js";

import type { Profile } from "./config.js";
import type { PolicyEditorResult } from "./policy-editor.js";
import type { Policy } from "./policy.js";
export type TokenMetadata = { audience: string | null; expiresAt: string; expiresInSeconds: number; };
export function tokenMetadata(token: StoredToken, now = new Date()): TokenMetadata {
  return { audience: readJwtMetadata(token.value).audience ?? null, expiresAt: token.expiresAt, expiresInSeconds: secondsUntil(token.expiresAt, now) };
}
export type SafeSession = { skillInstallation?: SkillInstallResult; authenticated: true; user: WhoamiResult["user"]; tokens: Record<"accessToken" | "skypeToken" | "chatToken" | "searchToken", TokenMetadata>; };
export function safeSession(session: StoredSession, now = new Date()): SafeSession {
  const { user } = describeSession(session);
  return { authenticated: true, user, tokens: { accessToken: tokenMetadata(session.accessToken, now), skypeToken: tokenMetadata(session.skypeToken, now), chatToken: tokenMetadata(session.chatToken, now), searchToken: tokenMetadata(session.searchToken, now) } };
}
export function safeRefresh(result: RefreshResult, now = new Date()) {
  return { target: result.target, before: safeSession(result.before, now), after: safeSession(result.after, now) };
}
export type Acknowledgement =
  | { action: "Logged out"; removed: string[]; }
  | { action: "Saved profile"; name: string; }
  | { action: "Removed profile"; name: string; authenticationRetained: true; }
  | { action: "Created inactive policy" | "Activated policy"; name: string; file: string; }
  | { action: "Policy editor closed"; reason: PolicyEditorResult["reason"]; activePolicies: number; subjectPath: string; }
  | { action: "Reinstalled skills"; installations: number; filesWritten: number; }
  | { action: "Upgraded teams-cli and recorded skill installations"; version: string; }
  | { action: "Changed update channel"; channel: UpdateChannel; version: string; };
export type ProfileResult = Profile & { name: string; };
export type NamedPolicyResult = { file: string; policy: Policy; };
export type AppliedPoliciesResult = { subjectPath: string; policies: NamedPolicyResult[]; };
export type PolicyDecisionResult = { allowed: true; activePolicies: number; subjectPath: string; };
export type LocalListResult =
  | { title: "Profiles"; items: Array<{ name: string; }>; }
  | { title: "Policies"; items: Array<{ name: string; active: boolean; file: string; }>; }
  | { title: "Skills"; items: Array<{ name: string; description: string; }>; }
  | { title: "Skill paths"; items: Array<{ platform: string; path: string; }>; };
export type Results = {
  doctor: DoctorReport;
  skills: SkillInstallResult;
  version: { installed: BuildInfo; updateChannel: UpdateChannel; update: { status: "available" | "current" | "pinned" | "npx" | "disabled" | "unavailable"; candidate: UpdateCandidate | null; }; };
  people: PersonSearchResult; person: PersonResult; chats: ChatPage; chat: ChatResult; channels: ChannelList; channel: ChannelResult;
  messages: MessagePage; message: MessageResult; sent: MessageSendResult;
  session: SafeSession; refresh: ReturnType<typeof safeRefresh>;
  ack: Acknowledgement; record: ProfileResult | NamedPolicyResult | AppliedPoliciesResult | PolicyDecisionResult; list: LocalListResult;
  image: { contentType: string; data: string; }; tokens: Record<string, unknown>;
};
