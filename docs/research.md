# Teams CLI research log

This document records tools, projects, and web pages consulted while investigating
a mostly read-only Microsoft Teams CLI that cannot register its own Entra application,
Teams app, or bot. It was last updated on 2026-08-14.

## Applicability legend

- **Applicable**: directly informed or can support the current implementation.
- **Reference only**: useful context, but does not meet the project's authentication
  constraints.
- **Not applicable**: addresses Teams application development rather than reading a
  user's existing Teams data.

## Unofficial Teams clients and private APIs

### [fossteams/teams-cli](https://github.com/fossteams/teams-cli/tree/master)

**Applicability:** Applicable as prior art.

An unofficial Go CLI/TUI aimed primarily at browsing Teams, channels, chats, and
recent messages. Its current CLI consumes token files and delegates private endpoint
access to `fossteams/teams-api`. It motivated the read-oriented scope of this project.

### [fossteams/teams-token](https://github.com/fossteams/teams-token)

**Applicability:** Applicable as authentication prior art.

An Electron helper that uses Microsoft's first-party Teams client identity, requests
resource-specific tokens, intercepts the `https://teams.microsoft.com/go` OAuth
callback, and writes tokens to disk. This project adapted the basic redirect-capture
idea but keeps tokens in memory and uses a dedicated Edge profile.

### [fossteams/teams-api](https://github.com/fossteams/teams-api)

**Applicability:** Applicable as private API prior art.

An unofficial Go library documenting the Teams `authsvc` token exchange, ChatSvcAgg
conversation discovery, middle-tier services, and regional message endpoints. Its
private API implementation is old and unsupported, so current behavior must always
be verified against the live Teams web client.

## Graph-based user-data tools

The following options use Microsoft Graph. They are not currently usable because
the project cannot register an application or obtain the required delegated Graph
permissions. They remain the preferred supported direction if that constraint changes.

### [Microsoft Teams CLI authentication overview](https://msteamscli.com/getting-started/auth-overview)

**Applicability:** Reference only; Graph/app registration required.

Documents supported authentication choices for a Teams CLI. These rely on an Entra
application identity and therefore do not fit the current environment.

### [zadjii-msft/ms-cli](https://github.com/zadjii-msft/ms-cli)

**Applicability:** Reference only; Graph-based.

A command-line interface for Microsoft Graph with Teams chat/channel operations as
well as OneDrive and Outlook features. Its repository contains an `msgraph` layer and
describes Graph as the integration surface.

### [Composio Microsoft Teams CLI](https://composio.dev/toolkits/microsoft_teams/framework/cli)

**Applicability:** Reference only; managed OAuth and Graph-based Teams actions.

Composio's Universal CLI provides managed authentication and a large Teams action
catalog. Its chat-message documentation explicitly describes Microsoft Graph usage.
It transfers authentication and execution to a third-party managed integration, which
does not satisfy the current no-app/no-Graph constraint and may introduce additional
organizational approval and data-governance requirements.

### [Microsoft Graph Teams API overview](https://learn.microsoft.com/en-us/graph/api/resources/teams-api-overview?view=graph-rest-1.0)

**Applicability:** Reference only under current constraints; authoritative supported API.

Microsoft's official overview of Teams resources exposed through Graph, including
teams, channels, chats, messages, meetings, and related workloads. This is the API
surface the project would prefer if an approved application registration became
available.

### [Microsoft Graph Explorer](https://developer.microsoft.com/en-us/graph/graph-explorer)

**Applicability:** Reference only; Graph-based interactive exploration.

Microsoft's browser tool for trying Graph requests with an authenticated identity.
It is useful for understanding supported resources and payloads, but it does not
provide a reusable authentication solution for this CLI.

## Teams application development tools

### [@microsoft/teamsapp-cli](https://www.npmjs.com/package/@microsoft/teamsapp-cli)

**Applicability:** Not applicable to reading an existing user's chats.

The Teams Toolkit CLI scaffolds, validates, provisions, and deploys Teams applications.
The package is deprecated in favor of `@microsoft/m365agentstoolkit-cli`. It is an app
lifecycle tool, requires tenant/application provisioning for relevant workflows, and
is not a general-purpose CLI for reading a user's Teams conversations.

## Authentication and client architecture

### [Microsoft identity platform: OAuth 2.0 implicit grant flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-implicit-grant-flow)

**Applicability:** Applicable as security and lifecycle context.

Explains the legacy implicit flow used by the first-party authorization route.
Microsoft recommends authorization code with PKCE for new registered applications.
The current project does not claim that its first-party private flow is a supported
pattern.

### [Microsoft Teams for Web overview](https://learn.microsoft.com/en-us/microsoftteams/teams-client-web)

**Applicability:** Applicable as architectural context.

Documents the Teams web client and its cross-client infrastructure. The functioning
web client supports the decision to use Edge as the authentication boundary and then
call the same private services required by that client.

## Local findings

- Modern Teams on macOS uses Edge/Chromium-style web profiles and encrypted cookies.
- The installed client contained cookie names associated with Teams authentication,
  but the implementation deliberately does not decrypt or reuse the desktop client's
  credential store.
- Live testing confirmed that conversation discovery requires a token whose audience
  is `https://chatsvcagg.teams.microsoft.com`; the Skype resource token cannot replace
  it.
- Live testing also confirmed that the Skype resource token can be exchanged through
  Teams `authsvc` for a regional Skype token and endpoint map.
- A preserved Edge profile can acquire both resource tokens silently until Microsoft
  requires account selection, MFA, or another Conditional Access step.
- Live inspection of the current Teams web client confirmed that CSA v3 returns chat
  pages with embedded members, `hasMoreChats`, and a sync token. The next request uses
  `/updates` and passes that token in `x-ms-synctoken`.
- Cookie-free live validation confirmed that the existing CSA v1 endpoint accepts the
  ChatSvcAgg bearer token and returns the complete chat collection. The current v3 web
  proxy rejects the same bearer credentials without the browser's cookie context, so
  the CLI retains v1 while preserving its server continuation fields when present.
- A follow-up against a tenant with 2,346 chats returned `hasMoreChats: false`.
  `pageSize`, `chatListPageSize`, `limit`, and ordering query parameters did not alter
  the response cardinality or order. The server order was not descending by last
  activity. A CLI limit, pagination, or last-activity sort would therefore be local
  processing and is intentionally not implemented.
- The chat-list text box labeled “Filter by person, chat or channel name” made no
  search request and is a client-side filter. It is not reproduced by the CLI.
- Teams GoTo sends server-side Substrate suggestions requests with an OAuth token
  whose audience is `https://outlook.office.com/search`. Live probing showed that a
  Chat request size of 25 returned 13 results for `Vlad`, rather than the five returned
  when five were requested. The matching participant is in `MatchingMembers`, outside
  the sampled `ChatMembers` roster.
- One-to-one conversations are absent from Chat suggestions. A People request returns
  the matching identity MRI. Live conversations use both possible orderings of the
  current and other tenant object IDs, so both candidate one-to-one IDs must be read
  from the regional conversation endpoint. A `200` identifies the existing direct
  chat; two `404` responses confirm there is none. This provides a read-only,
  server-verified direct result without filtering the complete CSA collection locally.
- An old regional message-service description advertises `sortOrderAsc`, `startId`,
  `endId`, and `queryOnProperty`, but live production requests ignored those values
  and retained the default order and unfiltered page. The CLI does not expose them.
  Live requests do honor `pageSize`, and `_metadata.backwardLink` is the continuation
  for older messages while retaining that page size.

## CLI design and agent ergonomics

These sources inform how the Teams proof of concept should evolve from a working
script into a predictable CLI for both humans and coding agents.

### [Agentic CLI Guidelines](https://www.aclig.dev/)

**Applicability:** Applicable as the primary agent-friendly CLI design reference.

Treats a CLI as a stable protocol rather than formatted terminal prose. The relevant
themes for this project are deterministic commands, structured output, non-interactive
operation, explicit schemas or discoverability, useful exit codes, and a clean split
between stdout results and stderr diagnostics. The Teams CLI already has `--json`, but
should eventually standardize output selection and machine-readable errors across all
commands.

### [rnwolfe/agent-cli-guidelines](https://github.com/rnwolfe/agent-cli-guidelines/blob/main/README.md)

**Applicability:** Applicable as concise implementation guidance for agent-operated CLIs.

Emphasizes interfaces that agents can discover and invoke without parsing interactive
terminal UI: stable command trees, complete flag-based inputs, structured responses,
non-interactive modes, bounded output, and actionable failure information. This is a
useful checklist for future `messages`, `profiles`, and diagnostic commands.

### [Node.js CLI Apps Best Practices](https://github.com/lirantal/nodejs-cli-apps-best-practices)

**Applicability:** Applicable to the TypeScript/Node.js implementation.

A broad collection covering command parsing, user experience, errors, output and
color behavior, configuration, security, performance, testing, packaging, and
distribution. For this project, the most important takeaways are predictable exit
codes, no accidental secret logging, TTY-aware presentation, testable command logic,
small dependencies, and verifying the contents of the npm package before publishing.

### [Getting Started with AI CLI Agents](https://www.jingnanliu.com/getting-started-with-ai-agents/)

**Applicability:** Applicable to onboarding and safety documentation.

An accessible introduction to terminals, shells, CLI agents, installation routes,
working-directory boundaries, approval modes, and isolation. It is a useful model for
explaining why this CLI uses Edge as a contained authentication boundary and why users
must treat the preserved browser profile as sensitive state rather than an ordinary
cache directory.

### [Automattic/cli-table](https://github.com/Automattic/cli-table)

**Applicability:** Reference for human-readable terminal output.

A Node.js library for rendering Unicode terminal tables. It demonstrates a compact
way to present conversations, Teams, timestamps, and profile state to humans. If a
table renderer is adopted, JSON must remain the stable automation format and table
formatting must degrade cleanly when stdout is not a TTY. The original project is old,
so a maintained successor should be evaluated before adding a dependency.

## Project-specific prior art: splitwise-cli

### [splitwise-cli on npm](https://www.npmjs.com/package/splitwise-cli)

### [michaelschnyder/splitwise-cli](https://github.com/michaelschnyder/splitwise-cli)

**Applicability:** Applicable as the closest existing design reference from the same
maintainer, particularly for profiles, safety controls, testing, and npm publishing.

Relevant patterns:

- **Named profiles:** profiles are stored separately, can be selected globally or for
  one command with `--profile`, and bind configuration such as credentials, endpoint,
  offline behavior, cache target, permissions, and data-scope restrictions.
- **Explicit resolution order:** command-line credential selection overrides the
  profile binding, which overrides active and default credentials. A similarly clear
  order would help Teams resolve `--profile`, the active profile, tenant, and browser
  state without ambiguity.
- **Profile locking:** locking is one-way from the CLI. Once locked, credential updates
  and profile switching are blocked, and recovery requires deliberately editing or
  removing the profile file. For Teams this is especially valuable: a locked work
  profile could pin the tenant and Edge profile directory, preventing accidental
  cross-tenant reads.
- **Least-privilege policy:** Splitwise profiles separately control create, update, and
  delete operations and can restrict visible groups or friends. Teams should initially
  define a read-only profile policy and require an explicit future decision before any
  send, edit, or delete command exists.
- **Test isolation:** tests use Node's test runner, temporary configuration directories,
  fixtures, and a local mock API server. They cover unit behavior, command integration,
  permissions, cache behavior, offline operation, and end-to-end parity without using
  production credentials.
- **Packaging discipline:** `build:package` compiles code, copies bundled skills, and
  synchronizes skill versions. The `prepack` hook runs this pipeline automatically for
  both `npm pack` and `npm publish`, while `npm run release` wraps publication. The npm
  package is published through GitHub Actions as a trusted publisher, avoiding a
  long-lived npm publish token.

Likely Teams CLI adaptations:

1. Introduce `profiles list|show|create|select|validate|lock`.
2. Store one Edge user-data directory per Teams profile instead of one global
   `.state/edge-profile`.
3. Bind and lock each profile to an expected tenant ID, then verify every acquired JWT
   and API response against that tenant before returning data.
4. Keep profiles read-only by policy for the MVP.
5. Move API normalization behind fixtures and a local mock server so most tests do not
   require Edge or a live Teams tenant.
6. Add package-content checks and a trusted-publisher release workflow before the CLI
   is distributed through npm.

## Maintenance

When another source materially affects the design, add it here with:

1. The URL and title.
2. Whether it is applicable under the no-registration constraint.
3. Its authentication/API dependency.
4. What conclusion or implementation choice it informed.
