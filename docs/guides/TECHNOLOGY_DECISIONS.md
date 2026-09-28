# Technology Decisions

A reference for every major technology used in EduCopilot M6: what it is, where it's used,
why it was chosen, what the alternatives are, and how to talk about the trade-off in an
interview or viva. Where the codebase itself documents a reason (a comment, a docstring, a
decision record), that reason is quoted or cited. Where no such record exists, the entry says
so explicitly and gives an *inferred* rationale — a defensible trade-off argument, not a claim
about what the original decision-maker actually thought.

This document assumes you've read [PROJECT_OVERVIEW.md](../PROJECT_OVERVIEW.md) and
[ARCHITECTURE.md](../ARCHITECTURE.md) first. For *how* each technology is actually used in
this codebase (not just why it was picked), see the matching
[learning/](../learning/) deep-dive.

## How to use this document

Each entry follows the same shape: what it is, where in M6 it's used, why (verified or
inferred), how it works here, alternatives and why not, advantages, limitations, a short
interview answer, and a likely follow-up question. Skim the table below, then jump to the
entries relevant to what you're being asked about.

| Technology | Used for | Team |
|---|---|---|
| [Next.js 16 (App Router)](#nextjs-16-app-router) | Frontend framework + API routes | 4C |
| [React 19](#react-19) | UI component model | 4C |
| [TypeScript](#typescript) | Type safety across the frontend | 4C |
| [Tailwind CSS](#tailwind-css) | Styling | 4C |
| [FastAPI](#fastapi) | Backend web framework | 4A, 4B |
| [MongoDB](#mongodb) | Product/relational-ish data | 4A (write), 4C (owns schema) |
| [Qdrant](#qdrant) | Vector database | 4A (write), 4B (read) |
| [Redis](#redis-two-independent-instances) | Job queue, locks, conversation cache | 4A, 4B |
| [Ollama + Llama 3](#ollama--llama-3) | Local LLM inference | 4B |
| [all-MiniLM-L6-v2](#all-minilm-l6-v2) | Sentence embeddings | 4A (generate), 4B (query) |
| [BM25](#bm25) | Keyword/lexical retrieval | 4B |
| [Reciprocal Rank Fusion](#reciprocal-rank-fusion-rrf) | Merging vector + keyword results | 4B |
| [JWT / ES256](#jwt--es256-service-to-service-auth) | Service-to-service authentication | 4C mints, 4A/4B verify |
| [Docker](#docker--docker-compose) | Local infrastructure | shared |

---

## Next.js 16 (App Router)

**What it is:** A React framework that provides file-system routing, server-side rendering,
API routes, and a build/bundling pipeline in one package.

**Where used:** All of Team4C — pages under `team4c/app/`, and its own backend API routes
(`team4c/app/api/*`) that Team4C's frontend calls, which in turn call Team4A/Team4B.

**Why:** Not independently documented as a formal evaluation in the codebase. Inferred
rationale: the App Router lets one framework serve both the UI and the backend-for-frontend
API layer (auth, ownership checks, service-JWT minting) without standing up a separate Node
server, which matches a three-service split where Team4C's own job is specifically "the
product," not "yet another backend."

**How it works here:** Server Components and Route Handlers under `app/api/` implement the
protected routes (workspaces, materials, chat, conversations, file serving); client
components (`"use client"`) implement the interactive chat/upload UI.

**Alternatives:**
- **Plain React + separate Express/Fastify backend** — more moving parts to deploy and keep
  in sync; Next.js's Route Handlers give you the backend-for-frontend layer "for free" in the
  same project.
- **Remix** — a comparable React meta-framework; a reasonable alternative, not chosen here.
- **SvelteKit / Nuxt** — different UI framework entirely; would mean not using React, which
  the wider ecosystem (component libraries, the Vercel AI SDK used for streaming chat) is
  built around.

**Advantages here:** one deployable unit for UI + BFF API; Route Handlers integrate cleanly
with Auth.js middleware for protected routes; React Server Components reduce client bundle
size for largely-static pages (landing, docs pages).

**Limitations:** framework lock-in to Vercel's conventions; App Router's caching semantics
have historically been a common source of subtle bugs (stale data after a mutation) if not
handled carefully — worth knowing if asked about pitfalls.

**Interview answer:** "Next.js gives us React for the UI and a backend-for-frontend API layer
in the same codebase, so Team4C can own auth, ownership checks, and service-JWT minting
without running a second server."

**Likely follow-up:** *"Why not call Team4A/Team4B directly from the browser?"* — Because the
service JWT that authenticates Team4C to Team4A/4B is signed with a private key that must
never reach the browser; only a server-side layer can mint it safely, which is exactly what
Next.js's Route Handlers provide.

---

## React 19

**What it is:** The component-based UI library Next.js is built on.

**Where used:** Every interactive piece of Team4C's UI — the AI Tutor chat panel, workspace
dashboard, upload flow, conversation sidebar.

**Why:** Comes as a consequence of choosing Next.js. The specific version (19) brings the
newer `use()` hook and improved Server Component ergonomics.

**Alternatives:** Vue, Svelte, Angular — all viable UI libraries; React was likely chosen for
its ecosystem (the Vercel AI SDK's `useChat()` hook, used for the streaming chat UI, is
React-specific) rather than a documented technical superiority argument.

**Advantages here:** `useChat()` from `@ai-sdk/react` handles token-by-token streaming state
out of the box, which the AI Tutor chat depends on directly.

**Limitations:** hooks-based state management has real footguns (stale closures, effect
dependency arrays) — the stuck-stream watchdog fix (see
[TEAM4C_DEEP_DIVE.md](../learning/TEAM4C_DEEP_DIVE.md)) exists specifically because a React
hook's internal state (`useChat()`'s stream) can be orphaned by a component remount.

**Interview answer:** "React, mainly because the Vercel AI SDK's streaming-chat hook is built
for it, and it's what Next.js is built on."

---

## TypeScript

**What it is:** A statically-typed superset of JavaScript.

**Where used:** All of Team4C's source (`.ts`/`.tsx` throughout).

**Why:** Not documented as a discrete decision, but the codebase enforces it strictly — `tsc
--noEmit` is a standing requirement before any change is considered complete (see
[TESTING.md](../TESTING.md)).

**Advantages here:** catches a whole class of "wrong shape of data" bugs at build time —
particularly valuable at the Team4A/Team4B API boundary, where a response-shape mismatch
would otherwise only surface at runtime, possibly in production.

**Alternatives:** plain JavaScript with JSDoc types (weaker guarantees), Flow (largely
abandoned by the ecosystem).

**Limitations:** type-checking discipline doesn't catch runtime data-shape drift unless the
API response is also validated at the boundary (e.g., with a schema validator) — TypeScript
alone trusts that the declared type matches what actually arrives over HTTP.

**Interview answer:** "Static types catch a class of integration bugs — a field renamed on
one side of the Team4A/Team4C or Team4B/Team4C boundary — before they reach a user."

---

## Tailwind CSS

**What it is:** A utility-class CSS framework — you compose styles from small, single-purpose
classes directly in markup rather than writing separate CSS files.

**Where used:** All of Team4C's styling, including the dark-first design system and the
premium visual/UX pass (responsive breakpoints, restrained motion via
`prefers-reduced-motion`).

**Why:** Not documented as a discrete evaluation. Inferred: pairs naturally with a
component-based framework (styles live next to the markup they affect) and makes a consistent
design system (spacing scale, color tokens) easy to enforce without a separate CSS
architecture.

**Alternatives:** CSS Modules, styled-components/Emotion (CSS-in-JS), plain global CSS.
Tailwind trades "you have to learn its utility vocabulary" for "you rarely write new CSS or
invent inconsistent one-off values."

**Interview answer:** "Utility-first CSS keeps the design system's spacing/color scale
consistent without a separate stylesheet architecture to maintain."

---

## FastAPI

**What it is:** A Python web framework built on Starlette/ASGI with automatic request/response
validation (via Pydantic) and OpenAPI schema generation.

**Where used:** Both Team4A and Team4B's HTTP APIs.

**Why:** Not documented as a discrete evaluation in the codebase, but Pydantic-based request
validation is used extensively (every request/response model in `app/models/` and inline in
route handlers) — this is FastAPI's central value proposition, not incidental.

**How it works here:** every route declares a Pydantic response_model; malformed requests are
rejected before handler code runs; `/openapi.json` (live introspection) was used during
architecture-documentation work as the most authoritative source of "what endpoints actually
exist."

**Alternatives:** Flask (no built-in validation/async), Django REST Framework (heavier,
ORM-coupled — a poor fit for two services that don't own a relational schema), raw
Starlette/ASGI (FastAPI's own foundation, but you'd hand-roll the validation FastAPI gives
you for free).

**Advantages here:** async-native (matters for I/O-bound work like calling Qdrant, Ollama,
and Redis without blocking), automatic request validation reduces a whole category of "did the
caller send the right shape" bugs, and the generated OpenAPI schema makes the API
self-documenting.

**Limitations:** Python's GIL means CPU-bound work (like the embedding computation in
ingestion) doesn't parallelize across threads within one process the way it would in a
language with true multi-threading — relevant if ingestion throughput ever needs scaling.

**Interview answer:** "FastAPI gives us async I/O and automatic Pydantic validation on every
route, so a malformed request from Team4C fails fast with a clear error instead of reaching
business logic."

**Likely follow-up:** *"Why two separate FastAPI services instead of one?"* — see
[SYSTEM_ARCHITECTURE_GUIDE.md](SYSTEM_ARCHITECTURE_GUIDE.md#why-three-services) — ingestion
and retrieval have very different scaling/failure profiles (ingestion is bursty and
CPU/IO-heavy; retrieval needs to stay responsive under chat load), and splitting them means
one team's mistake or one service's outage doesn't take down the other.

---

## MongoDB

**What it is:** A document-oriented NoSQL database — schemaless JSON-like documents instead of
fixed relational tables.

**Where used:** Owned schema-wise by Team4C (`team4c/models/*.ts` — User, Workspace, File,
Conversation, Message). Written to by Team4A (specifically `File.currentIngestionGeneration`,
the ingestion-authority field). Read by Team4B (`GenerationAuthorityClient`, to fail-closed
filter retrieval candidates).

**Why:** Not documented as a formal evaluation. Inferred: the product's core entities
(workspaces, files, conversations, messages) are naturally document-shaped and don't need
cross-table joins in the way a relational schema would — a conversation "has" messages, a
workspace "has" files, and MongoDB's document model matches this containment directly.

**Alternatives:** PostgreSQL (relational, would need explicit joins/foreign keys for the same
relationships, but gains transactional guarantees MongoDB's single-document-atomicity model
doesn't natively offer across documents), Firebase/Firestore (a managed alternative, but ties
the project to a specific cloud vendor for local-first development).

**Advantages here:** flexible schema evolution (a new field on `File` doesn't require a
migration), a single shared database across all three services for the product's own state
(rather than proliferating databases per service) simplifies the local-dev setup.

**Limitations:** no cross-document transactions used in this codebase (each service's writes
are scoped to what it owns), no relational integrity enforcement at the database level —
`workspace_id`/`userId` scoping is enforced entirely in application code (see
[SECURITY.md](../SECURITY.md)), which means a missed check is possible in principle, not
prevented by the database schema itself.

**Interview answer:** "MongoDB because the product's entities — workspaces containing files,
conversations containing messages — are naturally document-shaped, and one shared database
across all three services keeps local development simple."

**Likely follow-up:** *"How is workspace isolation actually enforced if the database doesn't
do it?"* — In application code: every query is scoped by `workspace_id`/`userId`, and
`assertOwnership()` (`team4c/lib/ownership.ts`) is the single checkpoint that a workspace both
exists and belongs to the caller — see [SECURITY.md](../SECURITY.md).

---

## Qdrant

**What it is:** A purpose-built vector database — stores high-dimensional embedding vectors
and supports fast approximate-nearest-neighbor similarity search, alongside payload
(metadata) filtering.

**Where used:** Team4A publishes chunk embeddings to it (`educopilot_chunks`, the canonical
collection); Team4B queries it for semantic retrieval.

**Why:** Not documented as a formal evaluation. Inferred: a dedicated vector database gives
approximate-nearest-neighbor search and metadata-filtered search (workspace/document scoping)
in one system, which a general-purpose database would need bolted-on extensions for.

**Alternatives:** pgvector (a Postgres extension — would mean one fewer moving service, at the
cost of a less mature ANN implementation for this use case), Pinecone/Weaviate (managed
alternatives, cloud-dependent), FAISS (a library, not a service — would mean building your own
persistence/filtering layer around it).

**Advantages here:** payload filtering (workspace/document scoping applied at the database
query level, not just in application code afterward) and collection-level isolation (the
canonical vs. legacy collection split is just two independent Qdrant collections, no schema
migration needed to keep them separate).

**Limitations:** another piece of infrastructure to run locally (a fourth Docker container
alongside Mongo/Redis×2); no built-in keyword/BM25 search, which is exactly why Team4B
maintains its own separate BM25 index (see [BM25](#bm25) below) rather than relying on Qdrant
alone.

**Interview answer:** "Qdrant does approximate-nearest-neighbor vector search with metadata
filtering, so we can search 'similar chunks' scoped to one workspace in a single query."

---

## Redis (two independent instances)

**What it is:** An in-memory key-value store, used here for two unrelated jobs on two
separate instances/ports (6379 for Team4A, 6380 for Team4B) — deliberately not shared, so a
spike in one service's Redis usage can't starve the other's.

**Where used (Team4A, :6379):** Celery broker (db0) and result backend (db1) for the legacy
ingestion pipeline; `IngestionLock` (a distributed lock) for content-hash dedup and stale-job
recovery serialization.

**Where used (Team4B, :6380):** `ConversationManager`'s session/turn history storage.

**Why:** Not documented as a single formal decision, but the *separation* into two instances
is deliberate (confirmed by the distinct ports and the explicit "not shared" framing in
`docs/ENVIRONMENT.md`). Inferred: Celery job coordination and conversation-history caching
have very different access patterns and failure tolerances — losing Team4B's Redis loses
in-flight conversation context (annoying, recoverable); losing Team4A's Redis loses ingestion
job coordination (could cause duplicate processing without the lock).

**Alternatives:** a single shared Redis instance with different key prefixes/DB indices (fewer
containers to run, but couples the two services' Redis load together); a real message queue
(RabbitMQ/SQS) instead of Redis-as-Celery-broker (heavier, arguably over-engineered for this
project's scale).

**Advantages here:** fast, TTL-native (conversation sessions and lock leases both need
automatic expiry, which Redis provides natively), and Celery's broker/backend split (db0/db1)
keeps in-flight task state separate from completed-task results.

**Limitations:** in-memory by default — a Redis restart without persistence configured loses
whatever wasn't yet flushed (acceptable here since both use cases are either recoverable via
stale-job recovery, or a conversation cache that can be seeded again from Team4C's own MongoDB
history).

**Interview answer:** "Two separate Redis instances — one per team — so Celery job
coordination on Team4A's side and conversation-history caching on Team4B's side don't compete
for the same memory or connections."

---

## Ollama + Llama 3

**What it is:** Ollama is a local LLM runtime (downloads and serves open-weight models);
Llama 3 is the specific model served through it, used here as an 8B, Q4-quantized build.

**Where used:** Team4B's `LLMGenerator` calls Ollama for every AI Tutor answer.

**Why:** Explicitly documented (`README.md`, `SECURITY.md`): **no cloud LLM call exists
anywhere in this pipeline** — this is a deliberate privacy/cost/control choice, not an
oversight. Course material (potentially sensitive to a student) never leaves the local
machine to reach a third-party API.

**Alternatives:** OpenAI/Anthropic/Gemini API (would mean sending retrieved course-material
context to a third party on every question — a real privacy trade-off for a system whose core
pitch is "grounded in *your own* material"), a different local runtime (llama.cpp directly,
vLLM) — Ollama specifically trades some inference throughput for a much simpler
model-management/serving experience.

**Advantages here:** zero per-request cost, zero data leaves the machine, works offline once
the model is pulled.

**Limitations, real and measured (not claimed):** CPU-bound in this project's own development
environment (`size_vram: 0`, no GPU configured) — observed generation latency 30–140+ seconds
per request. This is documented as an infrastructure characteristic of the current local
setup, not a Team4B code defect, and Team4C's UI (loading states, the stuck-stream watchdog)
is built with that reality in mind, not an assumption of sub-second responses.

**Interview answer:** "A local LLM means course material never leaves the student's machine to
reach a third-party API — that's the actual reason, not just cost. The trade-off is latency:
30 to 140+ seconds per answer on this CPU-only development setup."

**Likely follow-up:** *"Would a cloud LLM be faster?"* — Almost certainly yes for latency, at
the cost of sending retrieved context to a third party and paying per request. This project's
explicit design choice prioritizes the former trade-off; a production deployment might
revisit it with a GPU-backed or hosted option, which is called out as a real, undone item in
[DEVELOPER_HANDOFF.md](../DEVELOPER_HANDOFF.md)'s deployment checklist.

---

## all-MiniLM-L6-v2

**What it is:** A sentence-embedding model (from the `sentence-transformers` family) that
maps text to a 384-dimensional vector, such that semantically similar text maps to nearby
vectors.

**Where used:** Team4A generates embeddings for every chunk at ingestion time; Team4B
generates an embedding for every incoming query, using the *same* model (they must match —
mixing embedding models between ingestion and query would make vector similarity meaningless).

**Why:** Not documented as a formal bake-off, but its properties fit the constraints directly:
it's small enough to run locally with no GPU (consistent with the project's "no cloud
dependency" theme extended to embeddings too, not just generation), and 384 dimensions keeps
Qdrant's storage/search cost low relative to larger embedding models (768d, 1536d).

**Alternatives:** larger sentence-transformer models (better semantic quality, much more
compute/storage cost), OpenAI's `text-embedding-3` family (cloud-dependent, reintroduces the
same third-party-data-exposure trade-off the local-LLM choice was made to avoid), a
multilingual-specific embedding model (was actually investigated for improving Hindi/Hinglish
retrieval — see [RAG_ARCHITECTURE.md](../RAG_ARCHITECTURE.md)'s "Investigated and rejected"
table — and rejected because it didn't survive full hybrid/RRF evaluation despite looking
promising in isolation).

**Advantages here:** small, fast, local, cosine-distance-friendly (L2-normalized vectors).

**Limitations:** a smaller model has a real, measured ceiling on retrieval quality for hard
cases — this is one contributing factor in the documented cross-script (Hinglish/English ↔
Hindi) retrieval weakness in [KNOWN_LIMITATIONS.md](../KNOWN_LIMITATIONS.md), though BM25's
tokenizer behavior is the more directly implicated cause for the specific compound-word case
documented there.

**Interview answer:** "A small, local sentence-embedding model — 384 dimensions, runs on CPU —
consistent with keeping the whole pipeline off any cloud API, at the cost of some retrieval
quality ceiling versus a much larger embedding model."

---

## BM25

**What it is:** A classic lexical/keyword ranking algorithm (a refinement of TF-IDF) — scores
documents by exact term overlap with a query, weighted by term rarity and document length.

**Where used:** Team4B's `HybridRetriever` maintains a workspace-scoped, in-memory BM25 index
alongside Qdrant's vector search, and fuses the two result sets.

**Why:** Explicitly motivated by a real gap vector search alone has: semantic search finds
*conceptually* similar text but can miss exact-terminology matches (a specific function name,
an exact error code, an acronym) that a student might search for verbatim. BM25 covers exactly
that case.

**How it works here:** rebuilt per-workspace (not a single global index), and — a real,
previously-fixed bug — the corpus must be refreshed after ingestion or the BM25 leg silently
returns stale/empty results; this is now wired into the app's startup lifecycle (see
[TEAM4B_DEEP_DIVE.md](../learning/TEAM4B_DEEP_DIVE.md)).

**Alternatives:** Elasticsearch/OpenSearch (a full-text search engine with BM25 built in —
more powerful, but another heavyweight service to run and keep in sync with Qdrant's content),
vector search alone (simpler, but loses exact-terminology recall), a hybrid engine that does
both in one system (fewer moving parts, but this project's Qdrant version doesn't provide
built-in BM25).

**Limitations, documented and measured:** the tokenizer is script-agnostic but not
morphology-aware — a Hindi compound word's spaced vs. unspaced form are treated as entirely
different tokens, causing a documented, real retrieval miss (see
[KNOWN_LIMITATIONS.md](../KNOWN_LIMITATIONS.md)). This is a genuine, disclosed, unresolved
limitation, not something quietly worked around.

**Interview answer:** "BM25 catches exact-terminology matches — an error code, a specific
term — that pure vector similarity can miss, at the cost of being sensitive to exact
tokenization, which is where our one real, documented Hindi retrieval gap comes from."

---

## Reciprocal Rank Fusion (RRF)

**What it is:** A rank-fusion algorithm that merges multiple ranked result lists (here: the
vector-search ranking and the BM25 ranking) into one combined ranking, by summing
`1 / (k + rank)` for each item across every list it appears in, without needing the two lists'
raw scores to be on comparable scales.

**Where used:** `HybridRetriever` combines its semantic and BM25 legs' rankings this way,
with `k=60` (configured in `team4b/app/core/config.py`).

**Why chosen over an alternative fusion method:** vector-similarity scores and BM25 scores are
on fundamentally different, incomparable scales — you can't just add them together
meaningfully. RRF sidesteps that entirely by working from *rank position*, not raw score,
which is exactly the property needed to combine two structurally different retrieval methods
fairly.

**Alternatives:** a weighted linear combination of normalized scores (requires choosing a
normalization scheme and a weight — both extra tunable parameters with their own failure
modes), Convex Combination / CombSUM (similar score-scale problem RRF avoids), a learned
reranker as the sole fusion mechanism (this project *has* a reranker — see below — but treats
it as a separate, currently-disabled second-stage refinement, not a replacement for RRF's
first-stage fusion).

**Advantages here:** simple, parameter-light (just `k`), robust to the two legs' very
different score distributions, and empirically the configuration Team4B's Phase 5 validation
arc settled on and froze — deliberately not re-tuned without new evidence (see
[RAG_ARCHITECTURE.md](../RAG_ARCHITECTURE.md)).

**Limitations:** rank-based fusion discards *how much* better one result was than another —
two results ranked #1 and #2 count almost the same in RRF's formula regardless of whether
their underlying scores were nearly tied or vastly different.

**Interview answer:** "RRF merges the vector and BM25 rankings by rank position rather than
raw score, which avoids the problem that the two methods' scores aren't on the same scale to
begin with."

---

## JWT / ES256 (service-to-service auth)

**What it is:** JSON Web Tokens, signed here with ES256 (ECDSA using the P-256 curve and
SHA-256) — an asymmetric-key signature scheme, as opposed to a symmetric shared-secret scheme
like HS256.

**Where used:** every Team4C → Team4A/Team4B call carries a JWT minted by Team4C
(`lib/serviceJwt.ts`), verified by the receiving service.

**Why asymmetric (ES256) rather than a shared secret:** with a shared secret (HS256), any
service that can *verify* a token could also *forge* one — the same secret does both jobs.
With ES256, Team4C holds the private key and is the only party that can mint a valid token;
Team4A and Team4B hold only the public key, so they can verify authenticity but never
impersonate Team4C or each other. This is a real, meaningful security property, not just a
formality.

**Claims used:** `sub` (user id), `workspace_id`, `scope` (`ingest`|`query`), `aud`
(`team4a-ingestion`|`team4b-query` — so a token minted for one service can't be replayed
against the other), `iss`, `iat`, `exp` (300s TTL — short-lived, limits the damage window if a
token ever leaked), `jti`, plus `kid` in the header (supports key rotation).

**Alternatives:** a shared API key per service (simpler, but no cryptographic non-repudiation,
and a leaked key grants full impersonation), OAuth2 client-credentials flow via a real
authorization server (more standard for larger systems, but meaningfully more infrastructure
for a three-service project where Team4C is the only token issuer anyway), mTLS (strong, but
operationally heavier — certificate management per service).

**Advantages here:** short TTL limits exposure, `aud`/`scope` scoping means a token minted for
ingestion literally cannot be used against the query service even if replayed, and the
public/private key split means compromising Team4A or Team4B's verification key doesn't grant
the ability to mint new tokens.

**Limitations:** no revocation mechanism beyond the short TTL — a leaked token is valid for up
to 300 seconds regardless; this is an accepted trade-off for a local-development system, not
something claimed to be production-hardened as-is.

**Interview answer:** "ES256 means only Team4C can mint a valid service token — Team4A and
Team4B can verify but never forge one — because they only ever hold the public key."

**Likely follow-up:** *"What stops Team4A from calling Team4B directly with a fake token?"* —
It can't produce a validly-signed one without Team4C's private key; and even a genuine Team4A
token wouldn't be accepted by Team4B anyway, because its `aud` claim would say
`team4a-ingestion`, not `team4b-query` — the audience check rejects it independent of
signature validity.

---

## Docker / Docker Compose

**What it is:** Container runtime and orchestration for local infrastructure.

**Where used:** Qdrant, Redis ×2 (and optionally MongoDB) run as Docker containers in local
development, per [SETUP.md](../SETUP.md).

**Why:** Standard practice for reproducible local infrastructure — avoids "works on my
machine" drift for the shared data stores, without requiring a native install of Qdrant/Redis
on every developer's machine.

**Alternatives:** native installs of each service (more setup friction per developer, but one
fewer abstraction layer), a full `docker-compose.yml` for the application services
themselves too (deliberately *not* done here — `infra/README.md` states this integration
"intentionally reuses your existing approved Docker/native setup ... rather than duplicating
it" — Team4A/4B/4C run as native processes, not containers, in this project's current setup).

**Interview answer:** "Docker for the stateful infrastructure — Qdrant, Redis — so every
developer gets the same versions without a native install; the three application services
themselves run natively for faster local iteration."

---

*Last verified against source: 2026-09-28. See [DEVELOPER_HANDOFF.md](../DEVELOPER_HANDOFF.md)
for what to read next.*
