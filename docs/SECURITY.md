# Security

A product-wide security reference. For Team4B's specific prompt-injection
threat model and defenses (fixed vs. mitigated vs. open, with real
validation numbers), see [SECURITY_ARCHITECTURE.md](SECURITY_ARCHITECTURE.md)
— that document is not duplicated here. **Nothing below is claimed unless
it is actually implemented and verifiable in the running code.**

## Authentication

Team4C: Auth.js (NextAuth v5), Credentials provider, bcrypt-hashed
passwords, session cookie. `middleware`/`proxy.ts` redirects an
unauthenticated request to any protected route (`/dashboard`,
`/workspace/[id]`) to `/login` — enforced server-side, not just hidden by
client-side UI state. See [TEAM4C.md](TEAM4C.md).

## Authorization

Every workspace-scoped request re-verifies, server-side, that the
authenticated user owns the specific workspace being accessed
(`assertOwnership()`). A workspace belonging to another account returns
the same 404 as a nonexistent one — the ID space is not probeable to
distinguish "doesn't exist" from "exists but isn't yours."

## Workspace isolation

Two independent layers, neither depending on the other:

1. Team4C's ownership check (a user can only act on workspaces they own).
2. Team4B's mandatory `workspace_id` scoping on every retrieval call — a
   cross-workspace document never contributes to ranking statistics, let
   alone appears in results (BM25 rebuilds a fresh, workspace-scoped
   index per query, not a shared one filtered afterward).

## Account isolation

Every workspace has exactly one owner; every request is authenticated to
one user, whose own workspaces are the only ones ever resolvable
server-side.

## Document scoping

An optional `document_ids` filter narrows retrieval to specific material
within an already-authorized workspace. An explicitly-empty list
deliberately narrows to zero results — never silently treated as "no
restriction," which would be a fail-open bug.

## Service-to-service authentication (JWT)

Team4C mints a fresh, short-lived (default 300s), ES256-signed internal
JWT immediately before each call to Team4A or Team4B — never a long-lived
shared API key, never a client-supplied value. Team4C is the only service
holding the private signing key; Team4A/Team4B hold only the
corresponding public verification key, and each checks the token's
audience/scope claims (a token minted for Team4A is rejected by Team4B
and vice versa). Full claim table: [INTEGRATION.md](INTEGRATION.md).

## Secrets and environment files

- Real `.env`/`.env.local` files and `*.pem` key files are git-ignored at
  the repository root and per-service — verified via `git status --ignored`
  during this documentation pass: every real credential file is marked
  ignored, none are trackable.
- `.env.example`/`.env.docker.example` templates were directly inspected
  and contain only placeholders, safe local URLs, booleans, or numbers —
  no real secret material.
- The repository was scanned for private-key markers
  (`-----BEGIN ... PRIVATE KEY-----`), credentialed MongoDB URIs, and
  common API-key patterns (AWS, OpenAI, Google) across every tracked file
  type — zero matches.
- Full variable-by-variable reference: [ENVIRONMENT.md](ENVIRONMENT.md).

### What must never be committed

- Real `.env` / `.env.local` files (any service)
- `*.pem` private or public key files
- Passwords, in any form (real account credentials, database passwords)
- API keys, tokens, or session secrets
- A real MongoDB connection string containing embedded credentials
- Any file a `.gitignore` in this repository already excludes — if you
  ever need to force-add one of those paths, stop and ask why first

### `.gitignore` coverage

Both the repository root's `.gitignore` and `team4c/.gitignore` exclude:
`.env`/`.env.*` (except `*.example`/`*.docker.example`), `*.pem`, Python
caches and virtual environments (`__pycache__/`, `.pytest_cache/`,
`.venv/`, `venv/`), `node_modules/`, `.next/`, `*.log`,
`team4c/.gitignore`'s `/test-results` and `/playwright-report`
(generated Playwright artifacts), and OS/editor junk
(`.vscode/`, `.idea/`, `.DS_Store`, `Thumbs.db`). Verified current and
correct as of this audit — no changes were needed.

## Input validation

- Team4A's canonical ingestion route validates `file_url` against an
  explicit trusted-origin allowlist (`FILE_URL_TRUSTED_ORIGINS_JSON`),
  rejects redirects by default (`file_url_max_redirects: 0` — the single
  most common SSRF-allowlist-bypass vector), and enforces size/duration
  limits on uploaded PDF/video content.
- Team4C's API routes validate request bodies with Zod/TypeScript-checked
  shapes before acting on them (see the route handlers under
  `team4c/app/api/`), and never trust a client-supplied `workspace_id` or
  user id — both are always re-derived from server-verified session
  state.

## API security

Every Team4A/Team4B endpoint that isn't a bare health check requires a
valid internal service JWT. Every Team4C API route that touches
workspace/material/conversation data requires an authenticated session
and re-verifies ownership — see "Authorization" above.

## File handling

Uploaded PDFs/videos are processed by Team4A (extraction, chunking,
embedding) and never executed as code. Team4C's local-storage development
mock serves files from a local directory; a real deployment would use
object storage with its own access-control configuration (not yet wired
up — see [ROADMAP.md](ROADMAP.md)).

## Prompt/data trust boundary

Retrieved document/transcript content is treated as **untrusted data**,
never as a trusted instruction to the LLM, regardless of how it's
phrased. Full detail, including the two-layer defense and real validation
numbers: [SECURITY_ARCHITECTURE.md](SECURITY_ARCHITECTURE.md).

## Logging considerations

Team4A/Team4B use structured logging (configurable `LOG_LEVEL`); neither
service logs full request bodies containing user-identifying information
by default. Team4C's server-side logs (e.g., a security-relevant warning
when a citation referencing a file outside the caller's workspace is
filtered) never log full session tokens or passwords. No centralized log
aggregation exists in this project — see [ROADMAP.md](ROADMAP.md).

## Known security limitations

- **Prompt injection is mitigated for one specific, validated attack pattern (Phase
  5K's output-side guard, closing a forced-fixed-output hijack) — it is not
  eliminated.** A later attempt (query-text neutralization) was implemented and
  unit-tested but did **not** prevent a direct instruction-override attack against the
  live model — that attack still fully succeeded on retest. A separate, lower-severity
  residual also remains open (`REPRO-SPOOF-5` — a retrieved instruction asking the
  model to "reveal your system prompt" can produce a longer response echoing visible
  prompt-scaffold text; no real secret exists in the prompt to leak). See
  [SECURITY_ARCHITECTURE.md](SECURITY_ARCHITECTURE.md) for the dated record and exact
  test evidence.
- Rate limiting exists only on Team4B's three most expensive routes
  (`POST /api/v1/query`, `POST /api/v1/query/stream`, `POST /api/v1/evaluate`) — 30
  requests per 60-second window, keyed by the verified caller identity
  (`sub:workspace_id`, never IP), Redis-backed. It is a defense-in-depth control, not the
  primary authorization boundary, and it **fails open** on a Redis outage (unlike the
  JWT check, which fails closed). Every other route in the project — all of Team4A, all
  of Team4C, and Team4B's own session/health/metrics routes — has no rate limiting at
  all. See [LIMITATIONS.md](LIMITATIONS.md) and [ROADMAP.md](ROADMAP.md) for what a
  system-wide scheme would still need to add.
- No production secret-management system is wired up — `.env` files are
  appropriate for local development only, never for a real deployment.
- No independent third-party security audit has been performed on this
  codebase.

**Nothing above is claimed to make the system invulnerable.** It
describes what is actually implemented and verified, and points at what
is explicitly deferred.
