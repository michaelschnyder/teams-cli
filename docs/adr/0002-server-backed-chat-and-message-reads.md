# ADR 0002: Use server-backed private APIs for people, chat, and message reads

- **Status:** Accepted
- **Date:** 2026-08-14
- **Decision owners:** Project maintainers

## Context

The CLI needs to find people and inspect their profiles, enumerate a user's chats and
participants, page through messages, and retrieve an individual message. The project
still cannot register an Entra application, so the supported Microsoft Graph APIs
remain unavailable.

Teams exposes these capabilities to its web client through undocumented services.
Live inspection confirmed that chat discovery uses ChatSvcAgg, GoTo uses Substrate
suggestions, and chat history uses the regional messaging service returned by Teams
authentication. The sidebar text filter is client-side and therefore cannot satisfy
the requirement that search, paging, sorting, and filtering remain server-backed.

## Decision

Add read-only people, chat, and message commands using the same private services as Teams:

- A People-only Substrate suggestions request returns up to 25 server-ranked directory
  matches for `person search`. The CLI exposes a stable compact summary containing the
  object ID, MRI, display name, email, and job title without local ranking or paging.
- The Teams middle-tier user endpoint accepts an email address, object ID, or MRI and
  returns detailed directory fields for `person get`. Its authenticated profile-picture
  endpoint returns base64 image data; `person image` decodes and streams those bytes or
  emits base64 explicitly. Image requests default to the largest supported size and may
  select a standard Microsoft 365 photo resolution. The service falls back to the largest
  stored image. The private URL is not presented as a downloadable image URL.
- The cookie-free CSA v1 endpoint returns chats and embedded participant information.
  Initial discovery uses `/teams/users/me`; subsequent pages use `/updates` with the
  returned sync token in `x-ms-synctoken`. The web client's CSA v3 proxy was evaluated
  but rejects the saved bearer credentials without the web session's cookie context.
  Live requests to v1 returned the tenant's complete 2,346-chat collection with
  `hasMoreChats: false`. Common server paging parameters such as `pageSize`,
  `chatListPageSize`, and `limit` were ignored. Ordering parameters were also ignored,
  and the returned collection was not ordered by last activity. The CLI therefore
  cannot offer a chat-list limit, pagination, or last-activity ordering through this
  endpoint without violating the server-only query rule.
- Substrate suggestions receives `People` and `Chat` entity requests with a requested
  size of 25 each. Live requests showed that the previous size of five was only a
  client request choice: a `Vlad` query returned all 13 available Chat suggestions
  when 25 were requested. Chat suggestions expose the matched person separately in
  `MatchingMembers`; normalization includes those people before the sampled roster so
  the reason for a match is visible.
- Teams represents one-to-one GoTo matches as People suggestions rather than Chat
  suggestions. For each server-ranked People result, the CLI derives both observed
  one-to-one conversation-ID orderings from the two tenant object IDs and performs
  read-only regional conversation lookups until one exists. Teams does not use one
  canonical ordering: live conversations were found with both the other-user-first
  and current-user-first forms. Existing direct conversations are returned first in
  People ranking, followed by Chat suggestions in Chat ranking. Two `404` responses
  confirm that no existing direct conversation should be reported. No local text
  matching or sorting is performed.
- The regional chat service returns message pages and individual messages. Page size
  and continuation links are passed to the service without local reinterpretation.
  Although an old service description lists sort and ID-range parameters, live
  production requests ignore them; the CLI therefore exposes neither option.

The CLI may normalize response fields for stable output, but it must not locally
search, sort, or page service collections. Combining the distinct People and Chat
suggestion groups is permitted only for chat finding, in their documented group order
and with ranking preserved inside each group. Hidden chats are returned when the
service returns them. Unsupported server options are not simulated, including
chat-list limits and last-activity ordering.

Human-readable chat output is a table by default. `--json` returns stable envelopes
with the same collection order and an optional `page.nextCursor`.

## Authentication and session protocol

Session version 2 stores four credentials: the OAuth token for the Skype resource,
the derived Skype token, a ChatSvcAgg token, and an Outlook Search token. It also
stores the regional chat-service endpoint and region returned by `authsvc`.

Version 1 is deliberately not migrated during ordinary commands. It is treated as
outdated, and the user must run `auth refresh all`. That command may read the legacy
browser and tenant selection, silently reacquire all current resources, and replace
the session with version 2. Targeted refresh and data access require version 2.

An expired credential is refreshed before use. An API request rejected with `401` or
`403` refreshes only the relevant credential once and retries once. Authentication
that requires interaction remains exclusive to `auth login`.

The Outlook Search token currently carries the first-party
`SubstrateSearch-Internal.ReadWrite` scope even though this CLI performs only search
reads. This private first-party scope is a negative consequence of the selected
unsupported integration and must never be used for writes.

## Cursor protocol

Server sync tokens and message continuation links are wrapped in opaque, versioned
base64url cursors. Before following one, the CLI verifies its kind and tenant. Message
cursors must also match the requested chat, the stored regional HTTPS origin, and
the exact message-list path. This prevents a cursor from becoming an arbitrary URL
fetch.

When a message cursor is supplied, page size is rejected instead of modifying the
server continuation.

## Consequences

### Positive

- People ranking, results, and continuation behavior match the services used by Teams.
- Chat participants are available without secondary local joins.
- Agents can consume deterministic JSON while humans retain readable output.
- Cursor validation preserves upstream links without accepting arbitrary targets.

### Negative

- All endpoints and payloads are undocumented and can change without notice.
- Chat and People search have no continuation and may return fewer results than the
  requested size.
- People profile fields and images may be absent because of tenant data or policy.
- A saved session contains two additional sensitive bearer tokens.
- Version-1 users must explicitly refresh all tokens before reading data.

## Operational rules

- Keep all data operations read-only.
- Never log tokens, Authorization headers, raw search request identifiers, or cursor
  contents.
- Preserve server ranking within each search group and server collection order for
  all other operations.
- Do not add local paging, text search, sorting, collection filtering, caching, or
  offline indexing. The direct-chat `404` existence check described above is the sole
  filtering exception.
- Treat `429` and service errors as failures; do not bypass policy or throttling.
- Reverify private endpoint behavior against the current Teams web client when it
  changes.

## Revisit conditions

Revisit this decision if approved Microsoft Graph permissions become available, the
private token audiences or endpoints change, GoTo gains supported continuation, or
the CLI adds any write capability.
