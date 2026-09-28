# Team4C — Frontend / Product

Next.js (App Router) application: the student-facing product. Owns
authentication, workspace/material management, the chat UI, and its own
MongoDB schemas. Consumes Team4A (ingestion) and Team4B (RAG/query) as
clients — it does not implement retrieval, generation, embeddings, or
chunking.

## Technology stack

| Layer | Technology | Version |
|---|---|---|
| Framework | Next.js, App Router | 16.3.5 |
| UI | React, TypeScript | React 19.2.8, TypeScript 5 |
| Styling | Tailwind CSS v4, shadcn/ui ("new-york" style), lucide-react | |
| Chat/streaming | Vercel AI SDK (`ai`, `@ai-sdk/react`) | |
| Database | MongoDB via Mongoose | Mongoose 9.9.3 |
| Auth | Auth.js (NextAuth), Credentials provider | v5 beta |
| Markdown | `react-markdown` + `remark-gfm` | |
| Video | `video.js` + `videojs-youtube`, `react-player` | |
| State | React state by default; Zustand for the small amount of genuinely cross-component state (video timestamp seek, toasts) | Zustand 5 |
| Testing | Vitest + React Testing Library (unit/component), Playwright (E2E), `@axe-core/playwright` (accessibility) | Vitest 4.1.11, Playwright 1.62.1 |

## App Router structure

```
app/
  (auth)/           login, signup — unauthenticated route group
  (dashboard)/      dashboard, workspace/[id] — authenticated route group
  api/
    auth/           NextAuth handlers + signup
    chat/           POST — the AI Tutor's streaming chat endpoint
    workspaces/     workspace + file CRUD
    conversations/  source-scope updates
    local-storage/  local dev file-serving mock
  layout.tsx        root layout — forces `dark` as the default theme
  page.tsx          landing page
  globals.css       design tokens + premium visual system
components/
  ui/               shadcn primitives (button, dialog, alert-dialog, tooltip, …)
  shared/           app-level components (Sidebar, WorkspaceSwitcher, MaterialCard, TiltCard, Spotlight, StatusBadge, toaster, …)
  chat/             ChatPanel, MarkdownContent, SourceAttribution
  video/             VideoPlayer
lib/                DB connection, auth config, ownership checks, service JWT signing, source-scope resolution
models/             Mongoose schemas (User, Workspace, File, Conversation, Message)
services/           teamA/ and teamB/ clients — each has client.ts (real), mock.ts, index.ts (env-flag swap)
hooks/              useChatStream, useActiveConversation, useWorkspaceInit, …
store/              Zustand stores (appStore, useToastStore)
tests/              unit/, component/ (Vitest + RTL), e2e/ (Playwright)
```

## Authentication and authorization

- **Authentication**: Auth.js v5, Credentials provider, bcrypt-hashed
  passwords, session cookie. `middleware`/`proxy.ts` redirects an
  unauthenticated request to a protected route (`/dashboard`,
  `/workspace/[id]`) to `/login`.
- **Authorization (ownership)**: every workspace-scoped page/route
  re-verifies, server-side, that the authenticated user owns the
  workspace being accessed (`lib/ownership.ts`'s `assertOwnership()`) —
  a workspace that exists but belongs to someone else returns the same
  404 as one that doesn't exist, so the ID space isn't probeable.
- **Service-to-service auth**: Team4C is the only holder of the private
  service-JWT signing key (`lib/serviceJwt.ts`). It mints a fresh,
  short-lived, ES256-signed token from server-verified identity
  immediately before each call to Team4A/Team4B — never a client-supplied
  value, never a long-lived static credential. See
  [INTEGRATION.md](INTEGRATION.md).

## Workspace and material flow

A workspace is a course/subject container, owned by exactly one user.
Materials (PDF, MP4, or a YouTube URL) belong to exactly one workspace.
Adding a material creates a `File` document (`status: "uploading"`), hands
off to Team4A (see [ARCHITECTURE.md](ARCHITECTURE.md) for the full
ingestion flow), and the UI reflects `uploading` → `processing` → `ready`
(or `failed`, with the real error message) as Team4A's pipeline runs.
YouTube material uses the same `File` model and the same ingestion
hand-off as PDF, just with a URL instead of an uploaded file.

## AI Tutor

`ChatPanel` (`components/chat/ChatPanel.tsx`) is a virtualized
(`@tanstack/react-virtual`) message list over a real streaming connection
to `/api/chat`, which itself calls Team4B and streams the answer back
word-by-word as it arrives. Team4C does **not** generate or alter the
answer's content or structure in any way — it only renders whatever
Markdown Team4B's LLM produced. See [TEAM4B.md](TEAM4B.md) for what
actually decides an answer's structure.

- **Chat history**: persisted per-`Conversation`/`Message` in MongoDB;
  Team4B's own Redis-backed session history (`ragSessionId`) is the
  system Team4B uses for prompting continuity — Team4C's Mongo store is
  the durable system of record for the UI.
- **Markdown rendering** (`components/chat/MarkdownContent.tsx`): headings,
  paragraphs, ordered/unordered/nested lists, bold/italic, inline code,
  fenced code blocks (with a language label and copy button), tables,
  blockquotes, and links, all through `react-markdown` + `remark-gfm` —
  never `dangerouslySetInnerHTML`, never a raw-HTML-rendering plugin, so
  literal HTML/script tags in an LLM's output render as inert text, not
  live DOM.
- **Citations** (`components/chat/SourceAttribution.tsx`): rendered from
  the same `data-citations` part of each message that Team4B returned,
  after Team4C independently re-filters them against the real files in
  the authenticated user's workspace (`lib/workspaceFilter.ts`) — a
  citation is never rendered as clickable/trusted just because Team4B
  said so. Long titles truncate (full title still in the DOM/tooltip);
  multiple citations on one answer are grouped under a "Sources (n)"
  label.
- **Source scope**: a conversation can be scoped to the whole workspace or
  to one specific material (`lib/sourceScope.ts`, re-validated against
  current `File` state on every chat request — a stale scope pointing at a
  deleted/not-ready file is never silently widened back to "everything").

## Team4A / Team4B clients

`services/teamA/client.ts` and `services/teamB/client.ts` are the only
places Team4C calls out to those services. Each has a real client, a mock
(`USE_MOCK_TEAM_A`/`USE_MOCK_TEAM_B`, for local development without both
Python services running), and an `index.ts` that swaps between them based
on the environment flag — the rest of the app never knows which one it's
talking to.

## UI system

Dark-first design (the `.dark` token set is the default and only
identity a real visitor sees — see `app/globals.css`): deep navy/near-black
background, indigo/violet primary, cyan secondary accent, restrained glow,
subtle glass surfaces used sparingly. Reusable primitives:
`TiltCard`/`Spotlight` (CSS-only pointer-driven depth, mouse-only, disabled
under `prefers-reduced-motion: reduce`), `StatusBadge` (material lifecycle
states, with a pulsing dot only on in-progress states), a shared toast
system (`store/useToastStore.ts` + `components/shared/toaster.tsx`).

## Responsive behavior

Verified at 375/390/768/1024/1280/1440px. The workspace page switches
between a tab-based single-panel mobile layout and a two-column
Video/AI-Tutor desktop grid at the `md`/`lg` breakpoints — mobile is a
distinct layout, not a shrunk desktop one.

## Accessibility

WCAG 2A/2AA checked via `@axe-core/playwright` on every major page
(landing, login, signup, dashboard, workspace). Keyboard navigation,
visible focus rings, semantic headings, and accessible names on every
interactive element are maintained as a standing requirement, not a
one-time pass. `prefers-reduced-motion: reduce` globally disables the
decorative tilt/spotlight/aurora effects.

## Environment variables

Full reference: [ENVIRONMENT.md](ENVIRONMENT.md). Copy
`team4c/.env.example` to `team4c/.env.local` (or `.env` — both are
git-ignored) and fill in real values.

## Startup

```powershell
cd team4c
npm install
npm run dev
```

Open http://localhost:3000.

## Available commands

| Command | Purpose |
|---|---|
| `npm run dev` | Local development server (Turbopack) |
| `npm run build` | Production build |
| `npm run start` | Run the production build locally |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest (unit + component), single run |
| `npm run test:watch` | Vitest, watch mode |
| `npm run test:e2e` | Playwright E2E (builds and serves the app first) |

## Testing

Full detail: [TESTING.md](TESTING.md). Current real baseline: 669 Vitest
tests (unit + component) passing, a 13-test Playwright E2E suite across 7 spec files covering
real signup/login/logout, workspace CRUD and isolation, a full real
upload → ingest → ask → grounded-answer → citation flow, cross-source/
cross-workspace isolation, and axe-core accessibility on 5 pages — all
against the real, running Team4A/Team4B services, not mocks, for the
integration-level specs.

## Build

```powershell
npm run build
```

Clean production build is a standing requirement before any change is
considered complete.
