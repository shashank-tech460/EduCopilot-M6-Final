# EduCopilot M6 — Architecture Reference (Refined Diagram Set)

This document accompanies the refined architecture diagrams in this folder. It restates the
verified facts behind the diagrams in text form and points to the exact source location for
each one, so the diagrams can be checked against the code independently of this document.

All facts below were verified by reading the current source in this repository
(`D:\Major_Project\project\EduCopilot-M6-Local\EduCopilot-M6-Local`) and, where noted, by
calling the live running services. No fact was carried forward from an earlier document
without a fresh check against the current code as part of this refinement pass.

## Services and ports

| Service | Technology | Port | Source |
|---|---|---|---|
| Team 4C | Next.js 16 / React 19 / TypeScript | 3000 | `team4c/` |
| Team 4A | FastAPI | 8001 | `team4a/app/main.py` |
| Team 4B | FastAPI | 8002 | `team4b/app/api/main.py` |
| MongoDB | — | 27017 | shared datastore |
| Qdrant | — | 6333 | shared vector store |
| Redis (Team 4A) | Celery broker (db0) / result backend (db1) | 6379 | `team4a/app/config/settings.py` |
| Redis (Team 4B) | Conversation/session history | 6380 | `team4b/.env` (`REDIS_URL` override; code default is 6379/0) |
| Ollama | Local LLM runtime | 11434 | external, used only by Team4B |

## Team 4A — ingestion

- Canonical endpoint: `POST /v1/ingest` — service-JWT protected, synchronous.
- Legacy endpoints (Celery-queued, still reachable but not used by the current product upload
  flow): `POST /ingest/pdf`, `POST /ingest/video`, `POST /ingest/youtube`.
- Job status: `GET /jobs/{job_id}`, `GET /jobs`. Health: `GET /health`, `GET /readyz`.
- Embedding model: `all-MiniLM-L6-v2`, 384-dim, cosine distance.
- Chunking: `chunk_size=512` tokens, `chunk_overlap=50` tokens
  (`team4a/app/config/settings.py`).
- Canonical write path: `IngestionLock` → identity + generation claim in MongoDB
  (`MongoAuthorityClient.claim()`, `team4a/app/pipeline/mongo_authority.py`) → `Publisher`
  upserts to the Qdrant collection `educopilot_chunks`
  (`canonical_qdrant_collection_name`).
- Legacy write path: the Celery pipeline in `app/tasks.py` never passes a
  `collection_name_override` to `Publisher.publish()`, so it writes to the default collection
  `team4a_ingested_chunks` (`qdrant_collection_name`) — a separate collection from the one
  Team4B reads from.
- Stale-job recovery: a job stuck in `PROCESSING` past a configured threshold
  (`stale_processing_threshold_seconds`, default 4 hours) is recovered and marked `FAILED`
  under a short-lease `IngestionLock`, on read (`GET /jobs/{id}` or `GET /jobs`).

## Team 4B — retrieval and generation

- Query endpoints: `POST /api/v1/query` (non-streaming), `POST /api/v1/query/stream` (NDJSON
  token stream) — both JWT-protected and rate-limited.
- Session endpoints: `GET /api/v1/sessions/{session_id}/history`,
  `POST /api/v1/sessions/{session_id}/seed`, `DELETE /api/v1/sessions/{session_id}` (Redis
  :6380).
- Evaluation: `POST /api/v1/evaluate` (RAGAS batch). Health: `GET /health`, `GET /metrics`.
- Retrieval: hybrid search (semantic + BM25), fused with Reciprocal Rank Fusion, `k=60`
  (`team4b/app/core/config.py`, `rrf_k`). Candidate pool per leg: `max(top_k, 100)`.
  Default `top_k=5` (`default_top_k`).
- Reranker: implemented (`cross-encoder/mmarco-mMiniLMv2-L12-H384-v1`) but
  `reranker_enabled=False` by default.
- Generation-authority filter: `GenerationAuthorityClient.get_current_generations()` reads
  `File.currentIngestionGeneration` from MongoDB; a candidate whose document is absent from
  that map is excluded before ranking — fail-closed, not a fallback-to-trust.
- Citations: `document_id`, `document_title`, `chunk_id`, plus `page_number` /
  `section_heading` for PDF sources and start/end timestamp for video/YouTube sources.
- Generation is local-only: Team4B calls Ollama directly; there is no cloud LLM call anywhere
  in the pipeline.
- Prompt-injection mitigation: the user's query text is passed through
  `_neutralize_untrusted_text()` and the system prompt explicitly instructs the model not to
  comply with in-question override attempts (`team4b/app/services/llm_generator.py`). This is
  a real, tested, non-regressing code change. It does **not** fully solve the underlying
  vulnerability: a live retest of a direct "ignore your instructions" attack against the local
  model after this change still produced full compliance with the attack. This limitation is
  intentionally represented as a short, neutral technical note rather than embedded narrative
  text in the diagrams.

## Team 4C — application

- Authentication: Auth.js (NextAuth v5) with a credentials provider, bcrypt password hashing,
  JWT session cookie (`team4c/lib/auth.ts`).
- Authorization: `assertOwnership()` (`team4c/lib/ownership.ts`) — a workspace that does not
  exist and a workspace that exists but is not owned by the caller both return the same 404,
  so ownership cannot be probed from the response shape.
- Protected API routes (session + ownership required): Workspaces, Materials, Chat,
  Conversations, and File Serving (`/api/local-storage/[...path]`) APIs.
- Service-to-service calls to Team4A/Team4B carry an ES256-signed JWT minted by Team4C.
  Claims: `sub` (user id), `workspace_id`, `scope` (`ingest` | `query`), `aud`
  (`team4a-ingestion` | `team4b-query`), `iss`, `iat`, `exp`/`kid` (300s TTL), `jti`. The
  private signing key exists only in Team4C; Team4A/4B hold only the public key for
  verification.
- Service abstractions: the Team A and Team B service clients are real, JWT-authenticated
  clients. The transcript service is a mock with no real implementation. The storage service
  is a local-disk mock, development-only.
- Client-side reliability fix: a stuck-stream watchdog (`useChatStream.ts`) recreates the
  underlying `useChat()` instance if a stream produces no terminal event within 240 seconds,
  which specifically addresses a dev-mode-only failure mode where Next.js Fast Refresh
  orphans an in-flight stream.

## Shared data and storage

- MongoDB: users, workspaces, files, conversations, messages.
- Qdrant: `educopilot_chunks` (active/canonical), `team4a_ingested_chunks` (legacy, unused by
  the current upload flow).
- Redis — Team4A (:6379): Celery broker (db0) and result backend (db1).
- Redis — Team4B (:6380): conversation/session history.
- Local file storage: uploaded material bytes; development-only, not production-durable
  storage.

## Deliberately unverified / out of scope

- PDF export of the diagrams was not produced: no SVG-to-PDF converter (`cairosvg`,
  `rsvg-convert`, `inkscape`) is installed or on `PATH` in this environment. The SVG files in
  this folder are the vector source of record and can be converted to PDF with any of those
  tools if one becomes available.
- No application code or runtime behavior was changed as part of this diagram-refinement
  task. All facts above reflect the code as it exists in this repository at the time of this
  pass; no database, Redis, or file-storage state was reset, modified, or accessed.
