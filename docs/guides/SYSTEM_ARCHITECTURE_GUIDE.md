# System Architecture Guide — Full Integration

The deep, diagram-heavy explanation of how Team4A, Team4B, and Team4C actually work together.
For the high-level picture, start with [ARCHITECTURE.md](../ARCHITECTURE.md); for the
presentation-quality diagrams, see [docs/architecture/](../architecture/). This document is
the "how, exactly, step by step" layer underneath both.

## Table of contents

1. [Why three services](#why-three-services)
2. [Complete system map](#complete-system-map)
3. [Sequence: uploading a document](#sequence-uploading-a-document)
4. [Sequence: asking a question](#sequence-asking-a-question)
5. [Service-to-service authentication](#service-to-service-authentication)
6. [Workspace isolation, end to end](#workspace-isolation-end-to-end)
7. [Where each database fits](#where-each-database-fits)
8. [Synchronous vs. asynchronous operations](#synchronous-vs-asynchronous-operations)
9. [Error, retry, and recovery paths](#error-retry-and-recovery-paths)
10. [Conversation persistence and streaming](#conversation-persistence-and-streaming)
11. [Local startup order](#local-startup-order)

---

## Why three services

Team4A (ingestion) and Team4B (retrieval/generation) have deliberately different scaling and
failure profiles: ingestion is bursty, CPU/IO-heavy, and can take minutes for a large video;
retrieval needs to stay responsive under live chat load. Splitting them means one team's bug or
one service's outage doesn't take the other down with it, and each can be reasoned about,
tested, and (in principle) scaled independently. Team4C owns everything user-facing — auth,
ownership, the UI — and is the only service a browser ever talks to; Team4A and Team4B are
never reachable from outside the local network, only from Team4C's own server-side code (see
[Service-to-service authentication](#service-to-service-authentication)).

## Complete system map

```mermaid
flowchart TB
    Student(["Student — browser"])

    subgraph Team4C["Team4C — Next.js (port 3000)"]
        direction TB
        UI["Pages: landing, login, signup,\ndashboard, workspace/[id]"]
        API["API routes: auth, workspaces,\nfiles, chat, conversations,\nlocal-storage"]
        SJ["serviceJwt.ts\n(mints ES256 tokens)"]
    end

    subgraph Team4A["Team4A — FastAPI (port 8001)"]
        direction TB
        A_API["POST /v1/ingest (canonical)\nPOST /ingest/* (legacy)"]
        A_Pipe["extract → chunk → embed → publish"]
        A_Lock["IngestionLock + MongoAuthorityClient\n(canonical path only)"]
    end

    subgraph Team4B["Team4B — FastAPI (port 8002)"]
        direction TB
        B_API["POST /api/v1/query[/stream]\nsession + evaluate routes"]
        B_Retrieve["HybridRetriever\n(semantic + BM25 + RRF)"]
        B_Auth["GenerationAuthorityClient\n(fail-closed filter)"]
        B_Gen["LLMGenerator"]
    end

    Mongo[("MongoDB\nUsers · Workspaces · Files ·\nConversations · Messages")]
    Qdrant[("Qdrant\neducopilot_chunks (canonical)")]
    RedisA[("Redis :6379\nCelery broker/backend,\ningestion locks")]
    RedisB[("Redis :6380\nconversation history")]
    Ollama[("Ollama — llama3\n(local, no cloud call)")]

    Student --> UI
    UI --> API
    API -- "signed service JWT" --> A_API
    API -- "signed service JWT" --> B_API
    API -- "session + ownership" --> Mongo

    A_API --> A_Pipe --> A_Lock
    A_Lock -- "publish (canonical collection)" --> Qdrant
    A_Lock -- "claim currentIngestionGeneration" --> Mongo
    A_Pipe -. "legacy path only" .-> RedisA

    B_API --> B_Retrieve
    B_Retrieve -- "semantic leg" --> Qdrant
    B_Retrieve --> B_Auth
    B_Auth -- "read currentIngestionGeneration" --> Mongo
    B_Retrieve --> B_Gen
    B_Gen --> Ollama
    B_API -- "session history" --> RedisB
    B_Gen -- "answer + citations" --> API
    API --> UI
```

Full technical detail (ports, exact endpoints, JWT claims): see
[DATABASE_AND_API_REFERENCE.md](DATABASE_AND_API_REFERENCE.md) and
[docs/architecture/ARCHITECTURE_REFERENCE.md](../architecture/ARCHITECTURE_REFERENCE.md).

## Sequence: uploading a document

Covers the canonical path — the one the real product uses
(see [TEAM4A_DEEP_DIVE.md](../learning/TEAM4A_DEEP_DIVE.md) for the legacy alternative).

```mermaid
sequenceDiagram
    participant S as Student
    participant C as Team4C (server)
    participant Mongo as MongoDB
    participant A as Team4A
    participant Q as Qdrant

    S->>C: Upload PDF / paste YouTube URL
    C->>C: auth() session check
    C->>C: assertOwnership(workspaceId, userId)
    C->>Mongo: create File (status: "uploading")
    C->>C: store bytes (local-disk dev mock) or reference the YouTube URL
    C->>Mongo: File.status = "processing"
    C->>C: mint scoped, short-lived retrieval URL
    C->>A: POST /v1/ingest {document_id, file_type, file_url} + service JWT
    A->>A: verify JWT → ServiceIdentity
    A->>A: IngestionLock.acquire(document_id) → generation N
    A->>A: extract → chunk → embed
    A->>A: renew lock (mutation gate)
    A->>Q: publish generation-N chunks (educopilot_chunks)
    A->>A: renew lock (mutation gate)
    A->>Mongo: MongoAuthorityClient.claim(document_id, N)
    Mongo-->>A: succeeded (generation N is now current)
    A->>A: delete older generations' points, release lock
    A-->>C: 202 {status: completed, generation: N}
    C->>Mongo: File.status = "ready"
    C-->>S: status badge updates to "Ready" (polling/refetch)
```

If any step from lock-acquire through the Mongo claim fails, Team4A self-heals by deleting
exactly the points that specific attempt published and does **not** release the lock — see
[TEAM4A_DEEP_DIVE.md](../learning/TEAM4A_DEEP_DIVE.md#the-canonical-path--identity-locking-and-generations)
for why. Team4C maps the resulting failure through `describeIngestionFailure()` into a fixed,
safe message (`File.processingError`) — never raw error text.

## Sequence: asking a question

```mermaid
sequenceDiagram
    participant S as Student
    participant C as Team4C (server)
    participant B as Team4B
    participant Q as Qdrant
    participant Mongo as MongoDB
    participant R as Redis (:6380)
    participant O as Ollama

    S->>C: Ask a question (workspace + conversation open)
    C->>C: auth() + assertOwnership(workspace) + assertConversationOwnership
    C->>C: mint service JWT (scope: query, aud: team4b-query)
    C->>B: POST /api/v1/query/stream {query, session_id, retrieval_config}
    B->>B: verify JWT, rate limit
    B->>B: is_elliptical_query() → maybe enrich retrieval text
    par semantic leg
        B->>Q: vector search (canonical collection)
    and keyword leg
        B->>B: BM25 search (in-memory, per-workspace)
    end
    B->>Mongo: GenerationAuthorityClient — read currentIngestionGeneration
    Mongo-->>B: {document_id: generation, ...}
    B->>B: drop candidates whose generation doesn't match (fail-closed)
    B->>B: Reciprocal Rank Fusion → threshold → top_k
    B->>R: read windowed conversation history (last 5 turns)
    B->>B: build_prompt() — context + history + question, injection-neutralized
    B->>O: generate (structured {answer, grounded} output)
    O-->>B: streamed tokens
    B->>B: _is_forced_fixed_output() output-side check
    B->>R: append_turn (persist this exchange)
    B-->>C: NDJSON deltas, then {type: "done", answer, citations, grounded}
    C->>C: finalizeAnswer() — re-verify each citation's fileId against THIS workspace
    C->>Mongo: persist Message (with citations)
    C-->>S: streamed answer + citation chips
```

Note the two independent citation checks: Team4B builds citations only from retrieval
metadata (never model free-text), and Team4C independently re-verifies each one against the
active workspace before rendering — see
[TEAM4C_DEEP_DIVE.md](../learning/TEAM4C_DEEP_DIVE.md#citations-and-the-second-layer-of-trust).

## Service-to-service authentication

```mermaid
sequenceDiagram
    participant C as Team4C (server-only code)
    participant A as Team4A / Team4B

    Note over C: lib/serviceJwt.ts holds the ONLY private key in the system
    C->>C: mintServiceJwt({sub, workspace_id, scope, aud, iss})
    Note over C: ES256-sign, 300s TTL,<br/>claims: sub, workspace_id, scope,<br/>aud, iss, iat, exp, jti (+ kid in header)
    C->>A: Authorization: Bearer <token>
    A->>A: verify signature with PUBLIC key only
    A->>A: check iss, aud (must match THIS service), scope, exp, iat skew
    alt all checks pass
        A-->>C: 200/202 (request processed)
    else any check fails
        A-->>C: 401 (or 403 for wrong scope)
    end
```

Why `aud` matters concretely: a token minted with `aud: team4a-ingestion` is cryptographically
valid but will be **rejected by Team4B** even if somehow replayed there, because Team4B checks
`aud == team4b-query` independent of signature validity — see
[TECHNOLOGY_DECISIONS.md](TECHNOLOGY_DECISIONS.md#jwt--es256-service-to-service-auth).

## Workspace isolation, end to end

Isolation is enforced at three independent layers — not one:

1. **Team4C, at the API boundary**: every workspace-scoped query is filtered by
   `session.user.id`/`workspace_id`, and `assertOwnership()` returns an identical 404 for
   "doesn't exist" and "isn't yours," so the ID space itself isn't probeable.
2. **Team4B, at retrieval time**: `workspace_id` comes only from the verified JWT (never a
   request-body field an attacker could set), and both the semantic and BM25 legs are scoped to
   that workspace before any ranking happens — a BM25 index is even rebuilt fresh per query per
   workspace so a foreign document can't influence term-rarity statistics.
3. **Team4C, again, after Team4B responds**: citations are re-checked against the active
   workspace's own file list before being shown — defense-in-depth against a hypothetical bug
   on Team4B's side, not reliance on it being perfect.

## Where each database fits

| Store | Owner | Holds | Who else touches it |
|---|---|---|---|
| MongoDB | Team4C (schema) | Users, Workspaces, Files, Conversations, Messages | Team4A writes only `File.currentIngestionGeneration`; Team4B reads only that same field |
| Qdrant | Team4A (writer) | `educopilot_chunks` — chunk text + embedding + metadata | Team4B reads (semantic search); nothing else touches it |
| Redis :6379 | Team4A | Celery broker/result (legacy path only), `IngestionLock` state | Not shared with Team4B |
| Redis :6380 | Team4B | Conversation turn history, session TTL | Not shared with Team4A |

No database is shared for its *primary* purpose across services — the one deliberate exception
is the single `currentIngestionGeneration` field, a narrow, specific hand-off point, not a
general shared-schema arrangement.

## Synchronous vs. asynchronous operations

| Operation | Sync or async | Why |
|---|---|---|
| Canonical ingestion (`POST /v1/ingest`) | **Synchronous** | The caller (Team4C) needs a definite success/failure result to update `File.status` immediately; the lock/generation mechanism requires a single, ordered attempt anyway |
| Legacy ingestion (`POST /ingest/pdf` etc.) | **Asynchronous** (Celery) | Historical design — the client polls `GET /jobs/{id}` for status |
| A query (`/api/v1/query`) | Synchronous (blocking on the full answer) | Simpler client code where streaming isn't needed |
| A streaming query (`/api/v1/query/stream`) | Asynchronous from the client's view (NDJSON stream) | Lets the UI show tokens as they're generated, given multi-second-to-two-minute local LLM latency |

## Error, retry, and recovery paths

```mermaid
flowchart LR
    subgraph Ingestion
        direction TB
        I1["Canonical attempt fails\n(lock lost / publish fails / claim fails)"] --> I2["Self-heal: delete only\nTHIS attempt's points"]
        I2 --> I3["Lock NOT released —\nlease expires naturally"]
        I3 --> I4["Next attempt gets a\nfresh generation number"]
    end
    subgraph LegacyStale["Legacy stale-job recovery"]
        direction TB
        L1["Worker crashes mid-task"] --> L2["Job stuck in PROCESSING"]
        L2 --> L3["Next GET /jobs read after\n4h threshold"]
        L3 --> L4["Re-check under short lock\n(handles completion race)"]
        L4 --> L5["Mark FAILED,\nsafe-to-retry message"]
    end
    subgraph ChatUI["Stuck-stream watchdog (dev only)"]
        direction TB
        C1["Fast Refresh remounts\nmid-stream"] --> C2["useChat() instance\norphaned"]
        C2 --> C3["240s client timeout"]
        C3 --> C4["New chat instance\n(id generation bump)"]
        C4 --> C5["Amber 'took too long' banner"]
    end
```

Retrieval-side failures fail closed, not open: a generation-authority lookup failure excludes
the affected candidates rather than trusting them (see
[TEAM4B_DEEP_DIVE.md](../learning/TEAM4B_DEEP_DIVE.md#generation-authority-filtering)); a
rate-limiter Redis failure, by contrast, fails **open** (lets the request through) — a
deliberate, different choice for a different kind of risk, not an inconsistency.

## Conversation persistence and streaming

Team4B's Redis-backed conversation history is fast but short-lived (30-minute TTL, refreshed
only on write). Team4C's MongoDB `Message` collection is the durable record. When a
conversation is reopened after Team4B's session has expired, Team4C's
`restoreSessionIfMissing()` reads the most recent messages from Mongo and re-seeds Team4B's
Redis session before the next query — so a student never loses context just because they
stepped away for half an hour, without Team4B needing to know anything about MongoDB's schema
beyond the one narrow generation field it already reads.

## Local startup order

Infrastructure (MongoDB, Redis ×2, Qdrant, Ollama) → Team4A → Team4B → Team4C. Team4A/Team4B
have no hard dependency on each other at startup, but both need their respective Redis and
Qdrant/Mongo reachable; Team4C needs Team4A and Team4B's URLs configured (even if those
services aren't up yet — Team4C's clients fail per-request, not at its own startup). Full exact
commands: [SETUP.md](../SETUP.md#part-e--start-infrastructure-first).
