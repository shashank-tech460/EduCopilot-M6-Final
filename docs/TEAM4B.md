# Team4B — RAG / Query Service

FastAPI service that answers a student's question, grounded only in their
own workspace's ingested material, with citations. **RAG-accepted and
frozen** as of Phase 5K — see [M6_STATUS.md](M6_STATUS.md).

## In simple terms first

A student asks "What is polymorphism?" Team4B doesn't just ask an LLM —
it first searches the student's own uploaded material for the most
relevant pieces of text (**retrieval**), then hands only those pieces to
the LLM along with the question, instructing it to answer *from that text
only* (**generation**). This is Retrieval-Augmented Generation (RAG): it
makes the answer traceable back to real material instead of the model
guessing from what it was trained on.

## Purpose

Team4B owns retrieval and generation. It never extracts, chunks, or
embeds anything itself — it only reads what Team4A already published to
Qdrant.

## Pipeline

```
query
  |
  v
HybridRetriever.retrieve(query, workspace_id, top_k, score_threshold, search_mode)
  |
  +-- semantic leg: Qdrant cosine similarity
  +-- BM25 leg: in-memory keyword index, rebuilt PER WORKSPACE PER QUERY
  |         (so a cross-workspace document can never influence ranking
  |          statistics, not merely be filtered out afterward)
  |
  +-- Reciprocal Rank Fusion (RRF) merges both legs
  |
  v
Generation-authority filter (MongoDB read, fail-closed) -- applied to
BOTH legs' candidates BEFORE fusion, never after
  |
  v
LLMGenerator.generate(query, retrieved_results, conversation_history)
  |
  +-- build_prompt(): system instructions + untrusted-context-delimited
  |     evidence + conversation history + the question
  +-- Ollama /api/generate (llama3)
  +-- output-side guard (see SECURITY_ARCHITECTURE.md)
  |
  v
grounded answer + citations, or an honest "I don't know" (INSUFFICIENT_CONTEXT_MESSAGE)
```

## Why hybrid retrieval — semantic + BM25 + RRF

- **Semantic search** (embeddings + cosine similarity in Qdrant) finds text
  that means the same thing even with different words — good for
  conceptual questions, weaker on exact terminology/acronyms.
- **BM25** (keyword/lexical search) is the opposite: strong on exact terms,
  blind to paraphrase.
- **Reciprocal Rank Fusion (RRF)** merges both ranked lists into one by
  each candidate's *rank position* in each list (not raw scores, which
  aren't comparable across the two methods), so a chunk that ranks well
  in either leg gets credit, and a chunk strong in both legs rises to the
  top. `rrf_k = 60` (a standard RRF damping constant).

This combination was chosen because pure-semantic and pure-keyword search
each fail on the specific queries the other handles well; see
[RAG_ARCHITECTURE.md](RAG_ARCHITECTURE.md)'s "Investigated and rejected"
table for what else was tried (reranking, query expansion, a multilingual
embedding model) and why none of it replaced this combination in
production.

## Production configuration (frozen)

| Setting | Value |
|---|---|
| `top_k` | 5 |
| `score_threshold` | 0.3 |
| `search_mode` (default) | `hybrid` |
| `rrf_k` | 60 |
| `hybrid_candidate_pool_size` | 100 |
| Reranker | disabled |
| Embedding model | `all-MiniLM-L6-v2` (384-dim) |
| BM25 tokenizer | ASCII alnum + Devanagari runs (script-aware, not language-aware) |
| LLM | Ollama `llama3` (8B, local) |

No further changes to embeddings, BM25, RRF, reranker, `top_k`, or
`score_threshold` are planned without new specific evidence — see
[RAG_ARCHITECTURE.md](RAG_ARCHITECTURE.md) for the full "what frozen
means" statement and every alternative that was tried and rejected.

## Isolation and authority guarantees

- **Workspace isolation**: `workspace_id` is mandatory on every retrieval
  code path. There is no "search everything" option, and BM25 rebuilds a
  fresh, workspace-scoped index per query rather than filtering a shared
  one afterward.
- **Document scoping**: an optional `document_ids` list narrows both legs
  before fusion; an explicitly-empty list is a deliberate narrowing to
  zero results, never treated as "no restriction."
- **Generation authority**: every candidate's `document_id` +
  `ingestion_generation` is checked against Team4A's current generation for
  that document (see [TEAM4A.md](TEAM4A.md)). Fail-closed: a document with
  no verifiable current generation is excluded, never default-allowed.
- **Citations**: built directly from the same retrieval metadata already
  used for isolation — never re-derived from the model's own output text,
  so a citation can never point somewhere the retrieval itself didn't
  actually pull from.

## Grounding and hallucination reduction

The prompt instructs the model to answer *only* from the retrieved
evidence and to say so honestly when the evidence is insufficient, rather
than answering from its own training data. This is enforced by prompt
instruction, not a hard architectural guarantee — Phase 5J's live testing
found the large majority of grounded answers (7/8, then 8/8 after a later
fix) were accurate and correctly cited, and also found one bounded, known
failure mode: the model occasionally narrates lexically-adjacent-but-wrong-domain
retrieved content with confidence instead of declining (see
[KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) — this was confirmed to be a
generation-layer behavior, not a workspace-isolation leak).

## Prompt-injection defenses

Two layers — a prompt-level trust boundary (untrusted-context delimiters +
syntactic neutralization) and a deterministic output-side guard against
forced-fixed-output attacks. Full detail, including exact validation
numbers and one open residual: [SECURITY_ARCHITECTURE.md](SECURITY_ARCHITECTURE.md).

## API

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/v1/query` | The main entrypoint — query + `session_id` + optional `retrieval_config` (document scoping) → answer + citations |
| `GET` | `/api/v1/sessions/{session_id}/history` | Read-only, full chronological conversation history for a session |
| `POST` | `/api/v1/evaluate` | Batch evaluation endpoint (used by the offline evaluation harnesses in `team4b/scripts/`, not by the product) |
| `GET` | `/health` | Liveness |

All routes require a valid internal service JWT
(`aud: "team4b-query"`, `scope: "query"`) — see
[INTEGRATION.md](INTEGRATION.md).

## Environment variables

Full reference: [ENVIRONMENT.md](ENVIRONMENT.md). The ones that matter
most:

| Variable | Purpose |
|---|---|
| `QDRANT_URL`, `QDRANT_COLLECTION_NAME` | Where to read chunks from (production traffic actually reads the *canonical* collection Team4A publishes to — see [TEAM4A.md](TEAM4A.md)) |
| `MONGO_URL`, `MONGO_DATABASE_NAME` | Generation-authority reads (must match Team4C's database) |
| `REDIS_URL` | Conversation history (default port **6380**, deliberately separate from Team4A's Redis on 6379) |
| `OLLAMA_URL`, `OLLAMA_MODEL_NAME` | Local LLM endpoint and model (`llama3`) |
| `SERVICE_JWT_EXPECTED_ISSUER` / `_AUDIENCE` / `_REQUIRED_SCOPE` / `_PUBLIC_KEYS_JSON` | Verification-only, same keypair as Team4A, different audience/scope |

## Startup

```powershell
# Docker (recommended)
cd team4b
docker compose up --build

# Manual
cd team4b
uvicorn app.api.main:app --host 0.0.0.0 --port 8002
```

## Health check

```powershell
curl http://localhost:8002/health
```

## Tests

```powershell
cd team4b
python -m pytest -q
```

**Expected baseline: 1438 passed, 3 skipped, 1 known pre-existing failure**
(a stale-ground-truth test, explained in detail in
[TESTING.md](TESTING.md) — do not delete or weaken it). The pass count has
grown from the `1302` baseline re-verified throughout the Phase 5D–5K RAG
validation arc as later regression tests were added (rate limiting,
streaming, lifespan/BM25-refresh) — the known failure's identity is
unchanged. Current, authoritative count: [M6_STATUS.md](M6_STATUS.md).

## Troubleshooting

See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for: Ollama unavailable, model
not pulled, Qdrant collection mismatches, empty retrieval results, and slow
generation (local CPU-bound LLM inference in this environment took 30–140+
seconds per request during Phase 5J/5K's live testing — see
[KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md), and design loading states
around this if working on Team4C).
