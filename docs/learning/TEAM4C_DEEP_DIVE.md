# Team4C Deep Dive — Frontend, Backend-for-Frontend, and Product

A from-scratch, code-verified explanation of Team4C: the Next.js application students actually
use. Pairs with [docs/TEAM4C.md](../TEAM4C.md) (concise reference) and
[docs/SECURITY.md](../SECURITY.md). Every claim cites its source; verify before quoting as
current fact.

## Table of contents

1. [What Team4C is, in one paragraph](#what-team4c-is-in-one-paragraph)
2. [App Router structure](#app-router-structure)
3. [Authentication](#authentication)
4. [Workspace ownership — the single shared check](#workspace-ownership--the-single-shared-check)
5. [Workspace and material management](#workspace-and-material-management)
6. [The AI Tutor chat](#the-ai-tutor-chat)
7. [Conversations](#conversations)
8. [Citations, and the second layer of trust](#citations-and-the-second-layer-of-trust)
9. [Service clients and the service JWT](#service-clients-and-the-service-jwt)
10. [MongoDB schemas](#mongodb-schemas)
11. [State management](#state-management)
12. [Error handling and offline behavior](#error-handling-and-offline-behavior)
13. [UI system and accessibility](#ui-system-and-accessibility)
14. [Testing](#testing)
15. [Environment configuration](#environment-configuration)
16. [Examiner questions](#examiner-questions)

---

## What Team4C is, in one paragraph

Team4C is the only part of EduCopilot a student ever directly touches: sign up, create a
workspace, upload a PDF or link a YouTube video, watch it become "ready," and ask the AI Tutor
questions about it. It also quietly does the backend-for-frontend job of authenticating every
call to Team4A/Team4B with a signed service token, so the browser itself never needs to know
those services exist.

## App Router structure

Two route groups plus an API layer, all under `app/`:

- `(auth)/` — `login`, `signup` (unauthenticated layout).
- `(dashboard)/` — `dashboard` (workspace list) and `workspace/[id]` (the main chat +
  materials + video view) — authenticated layout.
- `app/api/` — the backend-for-frontend layer: `auth/[...nextauth]`, `auth/signup`, `chat`
  (streaming), `workspaces` (list/create), `workspaces/[id]` (get/delete, cascading),
  `workspaces/[id]/files` (list/upload), `.../files/[fileId]` (delete), `.../files/[fileId]/retry`,
  `workspaces/[id]/conversations` (list/create), `conversations/[id]` (delete),
  `conversations/[id]/messages`, `conversations/[id]/scope`, and
  `local-storage/[...path]` (file serving).

## Authentication

Auth.js v5 (`lib/auth.ts:19-88`), `session.strategy: "jwt"` (stateless — no server-side session
store), a single `Credentials` provider. `authorize()` normalizes the email, looks up the user
**with the password hash explicitly re-selected** (the schema marks `passwordHash` as
`select: false` by default — line 27-31 — so a normal query never accidentally returns it), and
compares with `bcrypt.compare()`. Only `{id, name, email}` ever leaves `authorize()` — a code
comment explicitly flags that the password hash must never reach the JWT.

**Signup** (`app/api/auth/signup/route.ts`) validates input, checks for an existing email,
hashes with `bcrypt.hash(password, 12)`, and returns only the safe `{id, name, email}` triple —
never the hash — with a 201.

**Route guard**: `proxy.ts` (Next.js 16's renamed convention for what used to be
`middleware.ts`) wraps `auth()` and redirects an unauthenticated request to `/login`, but its
`matcher` only covers `/dashboard/*` and `/workspace/*` — it is **not** what protects the API
routes. Every `app/api/*` route other than `/api/auth/*` independently calls `auth()` itself
and returns 401 if there's no session — protection is enforced **per-route**, redundantly with
the page-level guard, not solely by it. This matters: even if `proxy.ts` were ever
misconfigured, the API routes would still refuse an unauthenticated caller on their own.

## Workspace ownership — the single shared check

`assertOwnership(workspaceId, userId)` (`lib/ownership.ts:32-47`) is the one function nearly
every protected route calls before doing anything else. Mechanism: reject a syntactically
invalid ID immediately; otherwise look the workspace up and check `workspace.userId === userId`.
**Both failure branches — "doesn't exist" and "exists but belongs to someone else" — throw the
same error type**, which every caller maps to an identical 404.

The reasoning is spelled out directly in the file: if a wrong-owner ID produced a *different*
response than a nonexistent one, the ID space itself becomes probeable — an attacker could
learn "this ID belongs to *someone*" without ever seeing that someone's data. This exact
pattern repeats through every workspace-scoped route, and layers a second time for
conversation-scoped routes via `assertConversationOwnership` (`lib/conversationAuth.ts`) — a
"workspace, then child resource" two-step check.

## Workspace and material management

**Workspaces**: list/create always scope by `session.user.id` — a `GET` never trusts a
client-supplied filter, and a `userId` field in a `POST` body, even if sent, is never read.
Delete cascades in a deliberate order: stored file bytes, then File docs, then Messages (looked
up via this workspace's Conversation IDs), then Conversations, then the Workspace itself last —
so a failure partway through the cascade leaves the workspace still visible rather than
orphaning unreachable children.

**Materials**: one upload endpoint handles all three material kinds (`pdf`/`video`/
`youtube_url`) via a `type` field. A client-generated idempotency key
(`crypto.randomUUID()`) routes creation through `resolveUploadedFile()`
(`lib/ingestion.ts:199-232`) — a real retry-safety mechanism: a repeated request with the same
key reuses the existing File record instead of re-storing bytes (a `ready`/`failed` record is
handed back as-is or re-attempted; an in-flight `uploading`/`processing` record returns a 409
rather than racing itself).

**Storage**: `services/storage.ts` abstracts where bytes actually live.
`STORAGE_PROVIDER` unset → a local-disk dev mock; any other value → throws loudly rather than
silently no-opping (no real cloud provider is wired up yet). The local mock builds a
fully-qualified URL (`${AUTH_URL}/api/local-storage/...`) because Team4A's canonical ingest
contract requires an absolute URL it can fetch from. YouTube materials need no storage write at
all — the URL itself is the reference.

**Hand-off to Team4A** (`lib/ingestion.ts:103-149`): mints a short-lived, capability-scoped
retrieval URL (separate from the permanent citation-click URL, and never persisted) so Team4A
can fetch the file server-to-server with no browser session available to it, calls
`teamA.submit()`, and persists the resulting status. Any thrown error maps through
`describeIngestionFailure()`, which translates HTTP status codes (409/404/422/401/403/502) into
fixed, safe user-facing strings — **never forwarding raw error text** to the client.

**Retry** (`.../files/[fileId]/retry/route.ts`) only accepts an already-`failed` File (409
otherwise), reuses the same File record (never creates a new one), and relies entirely on
Team4A's own lock/generation mechanism for concurrent-retry safety — the route comment is
explicit that it "does not reimplement, and never weakens, that lock."

**File serving** (`app/api/local-storage/[...path]/route.ts`) has **two independent auth
paths**: a capability-token query param for Team4A's own server-to-server fetch (no browser
session exists for that caller), and the normal session+ownership path for a student clicking a
citation. Either way, the resolved path is checked to stay inside that workspace's own storage
root — `path.join()` alone normalizes but does not reject `../`, so this is a real, deliberate
defense against path traversal, not an incidental side effect.

**Status tracking**: `File.status` is restricted to exactly four values
(`uploading|processing|ready|failed`) — no fifth "uploaded" state — reflected in the UI via a
shared `StatusBadge` component (pulsing dot only for the two active states) and a `MaterialCard`
that only shows "Retry" when the status is `failed`.

## The AI Tutor chat

`ChatPanel.tsx` virtualizes the message list (`@tanstack/react-virtual`) specifically to handle
long scrollback (500+ messages) without mounting a DOM node per message. `useChatStream.ts`
wraps the Vercel AI SDK's `useChat()` (parts-based `UIMessage` API, not the older flat-content
shape) via a `DefaultChatTransport` pointed at `/api/chat`.

**The stuck-stream watchdog, precisely**: `useChat()`'s `id` option is
`` `${conversationId}#${streamGeneration}` `` — a fixed identifier plus an incrementing counter.
A `useEffect` starts a 240-second timer whenever streaming begins; if it fires first, it bumps
`streamGeneration` (which forces the SDK's own documented mechanism to construct a brand-new,
un-orphaned chat instance), stops the stuck spinner, and shows an amber "this response took too
long" banner.

**Why this exists — the actual root cause**: a Next.js dev-server Hot Module Reload / Fast
Refresh remount occurring *mid-stream* leaves the old `useChat()` instance permanently stuck
reporting `status: "streaming"`, even though Team4B actually finished and produced a real
answer — the UI simply never receives it, because the instance that was listening got orphaned
by the remount. This is dev-mode-only (Fast Refresh doesn't exist in a production build) but,
without the watchdog, leaves the UI stuck forever when it does trigger. The orphaned request
was never persisted server-side, so recovering it loses nothing beyond that one attempt, which
the student can simply retry.

**Streaming mechanism on the server**: `app/api/chat/route.ts` builds the response with the
Vercel AI SDK's `createUIMessageStream`, forwarding Team4B's real token-by-token deltas when its
streaming client is available, or falling back to a simulated word-by-word replay of one
complete answer otherwise.

## Conversations

`ConversationSidebar.tsx` lists conversations via React Query, sorted server-side by
`updatedAt`. Conversation CRUD (`app/api/workspaces/[id]/conversations/route.ts`) is
cursor-paginated (not offset-based) and computes "does this conversation have messages" in one
batched query rather than one-query-per-conversation, specifically to avoid an N+1 pattern.
Every new conversation gets a server-generated `ragSessionId` — never derived from title or
content.

`useActiveConversation.ts` checks for a reusable, still-empty, most-recently-created
conversation before creating a new one on mount, and re-reads the store's current state right
before committing a new selection — a deliberate defense against a race where the user manually
picks a different conversation while that check is still in flight.

**Restoration** (`lib/restoreSession.ts`) bridges Team4B's short-lived Redis session against
Team4C's durable MongoDB message history: it reads the most recent messages (capped at 20), and
if Team4B's session is confirmed missing while real history genuinely exists, it re-seeds
Team4B before the next query — and if that re-seed is both *necessary* and *fails* (Team4B
unavailable), the request now fails loudly (502) instead of silently proceeding with lost
context, a deliberate correction over an earlier version that swallowed this failure.

**Mobile sidebar default-collapse**: on mount, if the viewport is under 640px wide, the sidebar
starts collapsed — but this is strictly one-directional (collapse-only, never force-expand), so
a user who manually collapsed the sidebar on a wide screen (a preference the store persists)
never has that choice silently overridden on a later visit.

## Citations, and the second layer of trust

Citation chips render from a `data-citations` message part, distinguishing a document citation
from a video citation purely by which optional fields are populated (there's no explicit "type"
field on the wire). A PDF chip opens `fileUrl#page=N`; a video chip calls the existing
`setVideoTimestamp` store action.

**Server-side re-verification, precisely (`app/api/chat/route.ts`'s `finalizeAnswer()`)**:
before any attribution reaches the browser, Team4C independently re-fetches the *active
workspace's own* file list and disables (never removes — `disabled: true`) any citation whose
`fileId` isn't in that list. The code calls this out explicitly as "a defense-in-depth UI-layer
safety net" — Team4B's own scoping is the real authorization boundary; this is a second,
independent check specifically against what Team4B *returned*, not blind trust in it. A second,
separate suppression also applies whenever Team4B's own response signals zero retrieved chunks
or `grounded: false` — citations are only ever suppressed by this signal, never widened by it.
The visible citation label always prefers Team4C's own `File.originalName` over Team4B's
`document_title` (which is an internal storage identifier, not a human-friendly name).

## Service clients and the service JWT

`services/teamA/client.ts` / `services/teamB/client.ts` mint a **fresh** service JWT per call
(never reused across requests) and send it as a bearer token. Team4A's request body is
minimal and exact (`document_id`, `file_type`, `file_url` — nothing else merged in); Team4B's
is similarly minimal (`query`, `session_id`, `retrieval_config`).

`lib/serviceJwt.ts`'s `mintServiceJwt()` sets exactly nine fields: `sub`, `workspace_id`,
`scope`, `aud`, `iss`, `iat`, `exp`, `jti` (payload), plus `kid` (header) — ES256 signed. TTL
defaults to 300 seconds. **The private key exists only inside this server-only module**,
imported only by the two service clients — the module's own docstring states Team4C holds the
*only* private signing key in the entire system, and this module deliberately contains no
verify function at all (it only ever mints, never checks, since Team4A/4B are the verifiers).
Configuration loading **fails closed**: if the private key, `kid`, or issuer env vars are
missing, it throws rather than proceeding with an unsigned or partially-configured signer.

## MongoDB schemas

Five models (`models/*.ts`):

- **User** — `email` (unique), `passwordHash` (`select: false`).
- **Workspace** — `userId` (indexed; "every workspace has exactly one owning user"), `name`.
- **File** — `workspaceId` + a denormalized `userId` (both indexed, so ownership checks run in
  a single query rather than a join), `type`, `status`, `storageUrl`, `uploadIdempotencyKey`
  (unique+sparse), and **`currentIngestionGeneration`** (default 0) — the field Team4A's
  `MongoAuthorityClient` atomically claims (see
  [TEAM4A_DEEP_DIVE.md](TEAM4A_DEEP_DIVE.md#the-canonical-path--identity-locking-and-generations)).
  Team4C never writes to this field directly anywhere in its own codebase — it's Team4A's
  generation-locking mechanism, treated as foreign territory.
- **Conversation** — `workspaceId`, `ragSessionId` (unique+sparse, server-generated only),
  `sourceScopeDocumentIds` (`null` = whole-workspace scope; `[]` is a distinct, deliberate
  "explicitly scoped to nothing yet" state, set only via the scope-patch route).
- **Message** — `conversationId`, `role`, `content`, embedded `citations` (each with `fileId`,
  a 2-value `type` of `video|pdf` — a deliberate subset of File's 3-value type enum, since both
  MP4 and YouTube seek the same way in the player).

## State management

A single Zustand store (`store/appStore.ts`) with `persist` middleware, `partialize`d to save
only `workspace`, `ui`, and a narrowed slice of `video` state to localStorage — session data,
full chat history, and in-flight uploads are deliberately excluded from persistence.
`logout()` resets most domains but **not** `ui` (a sidebar-collapsed preference isn't
session-scoped, so it survives logout). React Query handles server-cache concerns
(conversation list, conversation messages) separately, with a 10-second stale time.

## Error handling and offline behavior

Upload failures surface through `File.processingError` (always a safe, fixed string — never
raw error text) driving a visible Retry button. A dedicated offline-queue mechanism
distinguishes a genuine network failure (no connection — safe to queue and replay later) from
an application-level error (a real 401/404/500 — shown as an immediate inline error instead of
silently queued). Queued messages replay strictly in order, one at a time, with a re-entrancy
guard so two "back online" events firing close together can't double-send; a failed replay
stops the queue rather than skipping ahead out of order.

## UI system and accessibility

Tailwind CSS v4, shadcn/ui components ("new-york" style) built on Radix UI primitives, dark-mode
via CSS custom properties with explicit `dark:` variants. Accessibility work is measured, not
just claimed: an automated `@axe-core/playwright` sweep runs against 5 key pages for WCAG
2A/2AA violations, and at least one specific color-contrast fix is documented with its actual
before/after ratio (a citation chip's text color changed from roughly 2.7:1 to a verified
~4.7:1 to clear the 4.5:1 AA threshold) — a real, measured fix, not an assumed one. A pulsing
status-dot animation is explicitly suppressed under `prefers-reduced-motion`.

## Testing

45 unit test files, 17 component test files, 7 Playwright E2E spec files (smoke, auth-workspace,
accessibility, workspace-isolation, source-isolation, core-rag, youtube-rag) — see
[TESTING.md](../TESTING.md) for current pass counts. The E2E suite exercises real
signup/login, real cross-account isolation, and a genuine upload → wait-for-ready → ask →
grounded-answer-with-citation flow against the live backend, not mocks.

## Environment configuration

Key variables from `.env.example`: `MONGODB_URI`, `AUTH_SECRET`/`AUTH_URL`/`AUTH_TRUST_HOST`
(Auth.js), `STORAGE_PROVIDER` (blank → local dev mock), `USE_MOCK_TEAM_A`/`TEAM_A_API_URL`,
`USE_MOCK_TEAM_B`/`TEAM_B_API_URL`, and the `SERVICE_JWT_*` signing variables (private key,
kid, issuer, TTL). See [ENVIRONMENT.md](../ENVIRONMENT.md) for the full, authoritative list
including the cross-service invariants that must match Team4A/4B's own configuration.

## Examiner questions

**"If `proxy.ts` already redirects unauthenticated users, why does every API route check the
session again?"** Because `proxy.ts`'s matcher only covers page routes, not the API layer — an
API route called directly (not through a page navigation) would otherwise be unprotected.
Defense happens at the layer that actually receives the request, not only at the layer that
happens to be in front of it in the common case.

**"Why does 'not found' and 'not yours' return the same 404?"** So the workspace-ID space isn't
probeable — a different response for each would let an attacker distinguish "this ID exists but
isn't mine" from "this ID doesn't exist," leaking information about what IDs are in use.

**"How does a student's citation click stay safe even if Team4B's response is somehow wrong?"**
Team4C independently re-checks every citation's file against the *current* workspace's own file
list before ever rendering it — this doesn't require trusting Team4B's scoping to be correct in
every case, only that this second check runs on every response.

**"Why not just let the browser call Team4A/Team4B directly?"** The service JWT that
authenticates those calls is signed with a private key that must never reach client-side code —
only a server (Team4C's own API routes) can safely mint it.
