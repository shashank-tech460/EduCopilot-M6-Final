# Codebase Navigation

A practical map: where to look for a given feature, without re-deriving it from scratch every
time. Pairs with [DEVELOPER_HANDOFF.md](../DEVELOPER_HANDOFF.md#where-things-live), which
covers the same ground at a coarser level — this document goes one level deeper, to specific
files and the classes/functions inside them.

## Team4A (`team4a/`)

```
app/
├── main.py                  FastAPI app construction, router wiring (no lifespan hook)
├── celery_app.py            Celery app + task registration wiring
├── tasks.py                 Legacy Celery pipeline (process_pdf/video/youtube)
├── api/
│   ├── canonical_ingest.py  POST /v1/ingest — the real, product-used endpoint
│   ├── routes.py            Legacy endpoints + dedup + stale-job recovery
│   ├── health.py            /health, /readyz
│   ├── auth_dependency.py   require_ingest_identity (JWT gate for every route)
│   └── file_storage.py      Upload save/size-enforcement
├── pipeline/
│   ├── ingestion_lock.py    IngestionLock — Redis distributed lock + generation counter
│   ├── mongo_authority.py   MongoAuthorityClient.claim() — the one Mongo write
│   ├── canonical_ingestion.py   Orchestrates lock → publish → claim → cleanup
│   ├── canonical_extraction.py  Hindi-fallback + transcript windowing (canonical only)
│   ├── canonical_mutations.py   delete_exact_points / delete_older_generations
│   ├── chunker.py           Chunker — chunk_size/overlap logic
│   ├── embedder.py          Embedder — all-MiniLM-L6-v2 wrapper
│   ├── metadata.py          MetadataEnricher — deterministic chunk_id + per-type fields
│   ├── publisher.py         Publisher — Qdrant upsert, retry/backoff
│   ├── transcript_windowing.py  group_segments_into_windows()
│   └── remote_source_resolver.py  SSRF-safe file_url fetch for canonical
├── processors/
│   ├── pdf_processor.py     PyMuPDF extraction + heading heuristic
│   ├── video_processor.py   ffmpeg/whisper extraction
│   └── youtube_processor.py youtube-transcript-api + yt-dlp
├── security/service_jwt.py  ServiceJWTVerifier (ES256, public-key-only)
├── config/settings.py       All configuration defaults
└── models/                  Pydantic request/response/domain models

tests/                       44 files — one per major module above, plus property-based
                              variants (test_*_properties.py) for chunker/embedder/publisher
```

| I want to change... | Look at |
|---|---|
| Chunk size/overlap | `app/config/settings.py`, `app/pipeline/chunker.py` |
| What metadata a chunk carries | `app/pipeline/metadata.py` |
| The canonical lock/generation mechanism | `app/pipeline/ingestion_lock.py`, `mongo_authority.py`, `canonical_ingestion.py` |
| Duplicate-upload prevention | `app/api/routes.py` (`_claim_legacy_content_or_409`) |
| Stuck-job recovery | `app/api/routes.py` (`_recover_if_stale`) |
| PDF heading detection | `app/processors/pdf_processor.py` |
| YouTube Hindi fallback | `app/pipeline/canonical_extraction.py` |
| Upload size limits | `app/config/settings.py`, `app/api/file_storage.py` |
| Service-JWT verification | `app/security/service_jwt.py` |

## Team4B (`team4b/`)

```
app/
├── api/
│   ├── main.py              create_app(), lifespan (BM25 startup refresh)
│   ├── routes.py            All 8 endpoints
│   ├── auth_dependency.py   require_query_identity
│   ├── rate_limit.py        RedisRateLimiter, rate_limited_query_identity
│   └── dependencies.py      get_hybrid_retriever/get_reranker/... (cached singletons)
├── services/
│   ├── hybrid_retriever.py  HybridRetriever — semantic + BM25 + RRF + auth filter + reranker hook
│   ├── bm25_index.py        BM25Index — per-query, per-workspace BM25Okapi wrapper
│   ├── generation_authority.py  GenerationAuthorityClient — the one Mongo read
│   ├── reranker.py          CrossEncoderReranker (implemented, disabled by default)
│   ├── llm_generator.py     build_prompt(), injection defenses, Ollama client, streaming
│   ├── followup_context.py  is_elliptical_query(), build_enriched_retrieval_query()
│   ├── conversation.py      ConversationManager — Redis session history
│   ├── response_assembly.py to_source_attribution() — citation building
│   ├── embedder.py          Query-side embedding (must match Team4A's model)
│   ├── vector_store.py      VectorStoreManager — Qdrant client wrapper
│   ├── evaluation.py        EvaluationPipeline
│   ├── ragas_adapter.py     RagasEvaluationAdapter (no context_recall — see deep dive)
│   ├── query_transform.py   NOT wired into production — evaluation tooling only
│   └── multi_query_retrieval.py  NOT wired into production — evaluation tooling only
├── security/service_jwt.py  ServiceJWTVerifier (Team4B's own copy, aud=team4b-query)
├── core/config.py           All configuration defaults (rrf_k, reranker_enabled, etc.)
└── models/                  query.py (SourceAttribution, QueryRequest/Response), evaluation.py

tests/                       39 files, ~1300+ test functions
data/                        Phase evaluation reports (m6_phase5*.md/.json) — real evidence,
                              not source code
```

| I want to change... | Look at |
|---|---|
| RRF's k constant, candidate pool size | `app/core/config.py`, `app/services/hybrid_retriever.py` |
| The BM25 tokenizer | `app/services/bm25_index.py` |
| Whether BM25 actually gets populated at boot | `app/api/main.py` (`lifespan`) |
| The reranker model / whether it's on | `app/core/config.py`, `app/services/reranker.py` |
| The generation-authority fail-closed check | `app/services/generation_authority.py`, `hybrid_retriever.py` |
| The system prompt / injection defenses | `app/services/llm_generator.py` |
| Follow-up/elliptical query handling | `app/services/followup_context.py`, `app/services/rag_service.py` |
| Citation field construction | `app/services/response_assembly.py` |
| Conversation history TTL/window size | `app/core/config.py`, `app/services/conversation.py` |
| Rate limiting | `app/api/rate_limit.py` |
| RAGAS metrics | `app/services/ragas_adapter.py` |

## Team4C (`team4c/`)

```
app/
├── (auth)/{login,signup}/page.tsx
├── (dashboard)/{dashboard,workspace/[id]}/page.tsx
├── api/
│   ├── auth/[...nextauth]/route.ts, auth/signup/route.ts
│   ├── chat/route.ts             Streaming proxy + citation re-verification
│   ├── workspaces/route.ts, workspaces/[id]/route.ts
│   ├── workspaces/[id]/files/route.ts, .../[fileId]/route.ts, .../retry/
│   ├── workspaces/[id]/conversations/route.ts
│   ├── conversations/[id]/route.ts, .../messages/route.ts, .../scope/route.ts
│   └── local-storage/[...path]/route.ts   File serving + path-traversal defense
├── proxy.ts                       Route guard (page routes only, not API routes)
components/
├── chat/ChatPanel.tsx             Virtualized message list, streaming UI
├── chat/SourceAttribution.tsx     Citation chip rendering
├── shared/ConversationSidebar.tsx List/select/delete conversations
├── shared/MaterialCard.tsx, UploadTracker.tsx
└── ui/                            shadcn/ui primitives
hooks/
├── useChatStream.ts                useChat() wrapper + stuck-stream watchdog
├── useActiveConversation.ts        Adopt-or-create conversation logic
├── useConversationMessages.ts      Restore persisted messages into UIMessage shape
└── useHydrated.ts
lib/
├── auth.ts                         Auth.js v5 config
├── ownership.ts                    assertOwnership() — the shared ownership check
├── conversationAuth.ts             assertConversationOwnership()
├── serviceJwt.ts                   Service JWT minting (private key lives here ONLY)
├── ingestion.ts                    resolveUploadedFile(), handOffToTeamA()
├── restoreSession.ts               Team4B session restoration from Mongo history
├── ragSession.ts                   generateRagSessionId()
├── localStorageCapability.ts       Capability-token verification for file serving
└── workspaceFilter.ts              filterWorkspaceReferences() — citation re-check
services/
├── teamA/{client.ts,mock.ts}       Real vs. mock Team4A HTTP client
├── teamB/{client.ts,mock.ts}       Real vs. mock Team4B HTTP client
└── storage.ts                      File storage abstraction (local dev mock)
store/appStore.ts                   Zustand store (session/workspace/chat/video/uploads/ui)
models/                             User, Workspace, File, Conversation, Message (Mongoose)

tests/
├── unit/       45 files
├── component/  17 files
└── e2e/        7 Playwright specs (smoke, auth-workspace, accessibility,
                workspace-isolation, source-isolation, core-rag, youtube-rag)
```

| I want to change... | Look at |
|---|---|
| Login/signup behavior | `lib/auth.ts`, `app/api/auth/signup/route.ts` |
| Who can access a workspace | `lib/ownership.ts` |
| The upload flow | `app/api/workspaces/[id]/files/route.ts`, `lib/ingestion.ts`, `services/storage.ts` |
| The stuck-stream / stuck-"Thinking" behavior | `hooks/useChatStream.ts` |
| How citations get re-verified before rendering | `app/api/chat/route.ts` (`finalizeAnswer`), `lib/workspaceFilter.ts` |
| The service JWT that authenticates 4A/4B calls | `lib/serviceJwt.ts` |
| Mongo schemas | `models/*.ts` |
| App-wide client state | `store/appStore.ts` |
| Conversation restoration after a Team4B session expires | `lib/restoreSession.ts` |
| Mobile sidebar behavior | `components/shared/ConversationSidebar.tsx` |
| File-serving path-traversal defense | `services/storage.ts` (`resolveLocalStoragePath`), `app/api/local-storage/[...path]/route.ts` |

## Finding a test for a behavior

Every table above's "look at" column has a same-named or closely-named test file one directory
level down under `tests/`. When in doubt: `grep -r "functionOrClassName" tests/` in the
relevant service finds it directly — this codebase's test files are consistently named after
what they test, not after arbitrary phase numbers.
