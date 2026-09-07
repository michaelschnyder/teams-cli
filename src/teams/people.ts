import { randomUUID } from "node:crypto";
import { OUTLOOK_SEARCH_URL, TEAMS_WEB_ORIGIN } from "../constants.js";
import { observedFetch } from "../diagnostics.js";
import type { StoredSession } from "../storage.js";

import type { RawParticipant } from "./chats.js";
import { jsonResponse, nullableBoolean, stringArray, stringValue, TeamsApiError } from "./transport.js";
import type { PersonImage, PersonImageSize, PersonPhone, PersonProfile, PersonResult, PersonSearchResult, PersonSummary } from "./types.js";

type RawPerson = RawParticipant & {
  Id?: unknown;
  ObjectId?: unknown;
  objectId?: unknown;
  DisplayName?: unknown;
  displayName?: unknown;
  GivenName?: unknown;
  givenName?: unknown;
  Surname?: unknown;
  surname?: unknown;
  Email?: unknown;
  email?: unknown;
  Mail?: unknown;
  mail?: unknown;
  EmailAddress?: unknown;
  emailAddress?: unknown;
  EmailAddresses?: unknown;
  emailAddresses?: unknown;
  UserPrincipalName?: unknown;
  userPrincipalName?: unknown;
  SmtpAddresses?: unknown;
  smtpAddresses?: unknown;
  JobTitle?: unknown;
  jobTitle?: unknown;
  Department?: unknown;
  department?: unknown;
  PhysicalDeliveryOfficeName?: unknown;
  physicalDeliveryOfficeName?: unknown;
  UserLocation?: unknown;
  userLocation?: unknown;
  Mobile?: unknown;
  mobile?: unknown;
  TelephoneNumber?: unknown;
  telephoneNumber?: unknown;
  Phones?: unknown;
  phones?: unknown;
  TenantName?: unknown;
  tenantName?: unknown;
  UserType?: unknown;
  userType?: unknown;
  AccountEnabled?: unknown;
  accountEnabled?: unknown;
  SkypeTeamsInfo?: unknown;
  skypeTeamsInfo?: unknown;
};

function firstEmailAddress(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  for (const entry of value) {
    if (typeof entry === "string" && entry.length > 0) return entry;
    if (!entry || typeof entry !== "object") continue;
    const email = entry as Record<string, unknown>;
    const address = stringValue(email.Address) ?? stringValue(email.address) ??
      stringValue(email.EmailAddress) ?? stringValue(email.emailAddress);
    if (address) return address;
  }
  return null;
}

function personIdentifiers(person: RawPerson): { id: string; mri: string | null; } | null {
  const mri = stringValue(person.mri) ?? stringValue(person.MRI);
  const objectId = stringValue(person.objectId) ?? stringValue(person.ObjectId) ??
    stringValue(person.ExternalDirectoryObjectId) ??
    stringValue(person.Id) ?? stringValue(person.id);
  const id = objectId ?? (mri?.startsWith("8:orgid:") ? mri.slice("8:orgid:".length) : mri);
  return id ? { id, mri } : null;
}

function normalizePersonSummary(value: unknown): PersonSummary | null {
  if (!value || typeof value !== "object") return null;
  const person = value as RawPerson;
  const identifiers = personIdentifiers(person);
  if (!identifiers) return null;
  return {
    ...identifiers,
    displayName: stringValue(person.displayName) ?? stringValue(person.DisplayName) ??
      stringValue(person.friendlyName),
    email: stringValue(person.email) ?? stringValue(person.Email) ??
      stringValue(person.mail) ?? stringValue(person.Mail) ??
      stringValue(person.emailAddress) ?? stringValue(person.EmailAddress) ??
      firstEmailAddress(person.emailAddresses) ?? firstEmailAddress(person.EmailAddresses) ??
      stringValue(person.userPrincipalName) ?? stringValue(person.UserPrincipalName),
    jobTitle: stringValue(person.jobTitle) ?? stringValue(person.JobTitle),
  };
}

function normalizePhones(value: unknown): PersonPhone[] {
  if (!Array.isArray(value)) return [];
  const phones: PersonPhone[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const phone = entry as Record<string, unknown>;
    const number = stringValue(phone.number) ?? stringValue(phone.Number);
    if (!number) continue;
    phones.push({ type: stringValue(phone.type) ?? stringValue(phone.Type), number });
  }
  return phones;
}

function normalizePersonProfile(value: unknown): PersonProfile | null {
  if (!value || typeof value !== "object") return null;
  const person = value as RawPerson;
  const identifiers = personIdentifiers(person);
  if (!identifiers) return null;
  const mail = stringValue(person.mail) ?? stringValue(person.Mail);
  const userPrincipalName = stringValue(person.userPrincipalName) ??
    stringValue(person.UserPrincipalName);
  const email = stringValue(person.email) ?? stringValue(person.Email) ?? mail ?? userPrincipalName;
  const skypeTeamsInfo = person.skypeTeamsInfo ?? person.SkypeTeamsInfo;
  const teamsEnabled = skypeTeamsInfo && typeof skypeTeamsInfo === "object"
    ? nullableBoolean(
      (skypeTeamsInfo as Record<string, unknown>).isSkypeTeamsUser ??
      (skypeTeamsInfo as Record<string, unknown>).IsSkypeTeamsUser,
    )
    : null;
  return {
    ...identifiers,
    displayName: stringValue(person.displayName) ?? stringValue(person.DisplayName) ??
      stringValue(person.friendlyName),
    givenName: stringValue(person.givenName) ?? stringValue(person.GivenName),
    surname: stringValue(person.surname) ?? stringValue(person.Surname),
    email,
    mail,
    userPrincipalName,
    smtpAddresses: stringArray(person.smtpAddresses ?? person.SmtpAddresses),
    jobTitle: stringValue(person.jobTitle) ?? stringValue(person.JobTitle),
    department: stringValue(person.department) ?? stringValue(person.Department),
    officeLocation: stringValue(person.physicalDeliveryOfficeName) ??
      stringValue(person.PhysicalDeliveryOfficeName) ??
      stringValue(person.userLocation) ?? stringValue(person.UserLocation),
    mobile: stringValue(person.mobile) ?? stringValue(person.Mobile),
    telephoneNumber: stringValue(person.telephoneNumber) ?? stringValue(person.TelephoneNumber),
    phones: normalizePhones(person.phones ?? person.Phones),
    tenantId: stringValue(person.tenantId) ?? stringValue(person.TenantId),
    tenantName: stringValue(person.tenantName) ?? stringValue(person.TenantName),
    userType: stringValue(person.userType) ?? stringValue(person.UserType),
    accountEnabled: nullableBoolean(person.accountEnabled ?? person.AccountEnabled),
    teamsEnabled,
  };
}

export async function searchPeople(
  session: StoredSession,
  query: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<PersonSearchResult> {
  const trimmed = query.trim();
  if (!trimmed) throw new Error("Person search query must not be empty");
  const url = new URL(OUTLOOK_SEARCH_URL);
  url.searchParams.set("scenario", "powerbar");
  const response = await observedFetch(fetchImplementation, url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${session.searchToken.value}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      EntityRequests: [{
        Query: {
          QueryString: trimmed,
          DisplayQueryString: trimmed,
          NormalizedQueryString: trimmed,
        },
        EntityType: "People",
        Size: 25,
      }],
      Scenario: { Name: "powerbar", Dimensions: [] },
      Cvid: randomUUID(),
      AppName: "Microsoft Teams",
      LogicalId: randomUUID(),
      dataSource: "personScoped",
    }),
  });
  const payload = await jsonResponse(response, "People search", "search") as {
    Groups?: Array<{ Type?: unknown; Suggestions?: unknown; }>;
  };
  const group = payload.Groups?.find((candidate) => candidate.Type === "People");
  const people = Array.isArray(group?.Suggestions)
    ? group.Suggestions
      .map(normalizePersonSummary)
      .filter((person): person is PersonSummary => person !== null)
    : [];
  return { query: trimmed, people };
}

function middleTierBaseUrl(session: StoredSession): URL {
  if (!session.endpoints.middleTier) {
    return new URL(`/api/mt/${encodeURIComponent(session.region)}/beta/`, TEAMS_WEB_ORIGIN);
  }
  const url = new URL(session.endpoints.middleTier);
  if (
    url.protocol !== "https:" ||
    (url.hostname !== "teams.microsoft.com" && !url.hostname.endsWith(".teams.microsoft.com"))
  ) {
    throw new Error("Stored Teams middle-tier endpoint is not trusted");
  }
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = `${path.endsWith("/beta") ? path : `${path}/beta`}/`;
  url.search = "";
  url.hash = "";
  return url;
}

function personUrl(session: StoredSession, identifier: string, suffix = ""): URL {
  const trimmed = identifier.trim();
  if (!trimmed) throw new Error("Person identifier must not be empty");
  const url = new URL(`users/${encodeURIComponent(trimmed)}/${suffix}`, middleTierBaseUrl(session));
  url.searchParams.set("isMailAddress", String(trimmed.includes("@")));
  url.searchParams.set("enableGuest", "true");
  url.searchParams.set("includeIBBarredUsers", "true");
  url.searchParams.set("skypeTeamsInfo", "true");
  return url;
}

export async function getPerson(
  session: StoredSession,
  identifier: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<PersonResult> {
  const response = await observedFetch(fetchImplementation, personUrl(session, identifier), {
    headers: {
      authorization: `Bearer ${session.accessToken.value}`,
      accept: "application/json",
    },
  });
  const payload = await jsonResponse(response, "Person lookup", "access") as { value?: unknown; };
  const person = normalizePersonProfile(payload.value ?? payload);
  if (!person) throw new Error("Person lookup returned no person");
  return { person };
}

function decodeBase64Image(raw: Buffer): Buffer {
  const encoded = raw.toString("utf8").trim();
  if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 === 1) {
    throw new Error("Person image lookup returned invalid image data");
  }
  const decoded = Buffer.from(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "="), "base64");
  if (!decoded.length) throw new Error("Person image lookup returned an empty image");
  return decoded;
}

export async function getPersonImage(
  session: StoredSession,
  identifier: string,
  size: PersonImageSize = "max",
  fetchImplementation: typeof fetch = fetch,
): Promise<PersonImage> {
  const url = personUrl(session, identifier, "profilepicture");
  url.searchParams.set("displayname", identifier.trim());
  url.searchParams.set("size", `HR${size === "max" ? "648" : size}x${size === "max" ? "648" : size}`);
  const response = await observedFetch(fetchImplementation, url, {
    headers: { authorization: `Bearer ${session.accessToken.value}` },
  });
  if (response.status === 404) {
    throw new TeamsApiError(404, `No profile image found for: ${identifier}`, "access");
  }
  if (!response.ok) {
    throw new TeamsApiError(
      response.status,
      `Person image lookup failed (${response.status} ${response.statusText})`,
      "access",
    );
  }
  const raw = Buffer.from(await response.arrayBuffer());
  if (!raw.length) throw new Error("Person image lookup returned an empty image");
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
  return contentType?.startsWith("image/")
    ? { data: raw, contentType }
    : { data: decodeBase64Image(raw), contentType: "image/jpeg" };
}
