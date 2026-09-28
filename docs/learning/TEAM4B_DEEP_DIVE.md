# Team4B Deep Dive — Retrieval, RAG, and Answer Generation

A from-scratch, code-verified explanation of Team4B: the RAG engine. Pairs with
[docs/TEAM4B.md](../TEAM4B.md) (concise reference), [docs/RAG_ARCHITECTURE.md](../RAG_ARCHITECTURE.md)
(the frozen pipeline and every rejected alternative), and
[docs/SECURITY_ARCHITECTURE.md](../SECURITY_ARCHITECTURE.md) (the full threat model). This
document explains *how* and *why*; those two explain *what's frozen and what's still open*.
Every claim cites its source; verify before quoting as current fact.

## Table of contents

1. [What Team4B is, in one paragraph](#what-team4b-is-in-one-paragraph)
2. [RAG fundamentals, briefly](#rag-fundamentals-briefly)
3. [The full pipeline, step by step](#the-full-pipeline-step-by-step)
4. [API surface](#api-surface)
5. [Query preprocessing — follow-up detection](#query-preprocessing--follow-up-detection)
6. [Semantic (vector) search](#semantic-vector-search)
7. [BM25 keyword search](#bm25-keyword-search)
8. [Fusion — Reciprocal Rank Fusion](#fusion--reciprocal-rank-fusion)
9. [The reranker (disabled by default)](#the-reranker-disabled-by-default)
10. [Generation-authority filtering](#generation-authority-filtering)
11. [Prompt construction and injection defenses](#prompt-construction-and-injection-defenses)
12. [Ollama and generation](#ollama-and-generation)
13. [Citations](#citations)
14. [Streaming](#streaming)
15. [Conversation history](#conversation-history)
16. [Security and rate limiting](#security-and-rate-limiting)
17. [Configuration reference](#configuration-reference)
18. [Evaluation (RAGAS)](#evaluation-ragas)
19. [Known limitations, from the code itself](#known-limitations-from-the-code-itself)
20. [Examiner questions](#examiner-questions)

---

## What Team4B is, in one paragraph

Team4B takes a student's question plus a `workspace_id`, finds the most relevant chunks that
Team4A published for that workspace, filters out anything not currently authoritative, asks a
local LLM to answer *using only that retrieved text*, and returns an answer with citations
built strictly from retrieval metadata — never from anything the model free-typed. It never
touches raw files and never talks to Qdrant/Mongo about anything outside this narrow, tightly
scoped job.

## RAG fundamentals, briefly

Retrieval-Augmented Generation exists because a general-purpose LLM has no idea what's in a
specific student's specific PDF — it can only answer from what it was trained on, which is
either wrong (hallucination) or simply absent. RAG's fix: retrieve the actually-relevant text
first, then force the model to generate its answer *from that text*, not from its own
training-time memory. Team4B's `_SYSTEM_INSTRUCTIONS` state this directly: "use ONLY the
Context/History... do not use outside knowledge... do not invent citations"
(`app/services/llm_generator.py:115-146`).

## The full pipeline, step by step

```
User question (+ session_id)
    │
    ▼
[1] Query preprocessing — elliptical/follow-up detection, session-scoped
    │
    ▼
[2] Retrieval (in parallel, per leg):
    ├── Semantic search — embed the query, search Qdrant (canonical collection)
    └── BM25 keyword search — score against a per-workspace, per-query in-memory index
    │
    ▼
[3] Generation-authority filter — drop any candidate whose document isn't
    the currently-authoritative ingestion generation (BEFORE fusion)
    │
    ▼
[4] Fusion — Reciprocal Rank Fusion merges the two legs' rankings
    │
    ▼
[5] Threshold + top_k truncation (+ optional reranker, if enabled)
    │
    ▼
[6] Context assembly — retrieved chunks + conversation history + the
    question, wrapped in prompt-injection-resistant framing
    │
    ▼
[7] LLM generation (Ollama, local) — structured {answer, grounded} output
    │
    ▼
[8] Output-side safety check — forced-fixed-output guard
    │
    ▼
[9] Citation assembly — built ONLY from retrieval metadata
    │
    ▼
Response (+ citations, streamed or not) → Team4C
```

Each numbered stage is its own section below.

## API surface

| Method & path | File:line | Auth | Purpose |
|---|---|---|---|
| `POST /api/v1/query` | `routes.py:101` | JWT + rate-limited | Non-streaming answer |
| `POST /api/v1/query/stream` | `routes.py:228` | JWT + rate-limited | NDJSON token stream |
| `GET /api/v1/sessions/{session_id}/history` | `routes.py:411` | JWT | Full (unwindowed) history |
| `POST /api/v1/sessions/{session_id}/seed` | `routes.py:519` | JWT | Restore a missing/expired session |
| `DELETE /api/v1/sessions/{session_id}` | `routes.py:583` | JWT | Clear a session |
| `POST /api/v1/evaluate` | `routes.py:620` | JWT + rate-limited | RAGAS batch evaluation |
| `GET /health` | `routes.py:732` | none | Component health (vector store, Redis, LLM, derived RAG rollup) |
| `GET /metrics` | `routes.py:842` | none | In-memory query metrics snapshot |

`workspace_id` comes exclusively from the verified JWT identity on every route, never from the
request body.

## Query preprocessing — follow-up detection

`is_elliptical_query()` (`app/services/followup_context.py:135-170`) flags a query as an
incomplete follow-up (pronoun-based — "it", "this", "explain further" — or a curated closed set
of short phrases), purely syntactically, with no per-subject vocabulary and no LLM call.

**A real bug and its fix, worth knowing precisely:** this heuristic has confirmed false
positives on fully self-contained questions that merely *contain* a pronoun ("What is a DBMS
and what are ITS key features?"). An earlier version, on a match, skipped retrieval outright
and returned a scripted clarification — so a false positive silently broke a perfectly
answerable question. The fix (`app/services/rag_service.py:239-266`): whenever
`is_elliptical_query()` matches, the query is passed through
`build_enriched_retrieval_query()`, which prepends the most recent user turn's text for
retrieval purposes only — and gracefully returns the query *unchanged* if there's no previous
turn to enrich from. So a false positive now just falls through to ordinary retrieval on the
original text, while a genuine no-context elliptical query still correctly reaches an honest
"insufficient context" response (because retrieval on a bare pronoun returns nothing useful) —
never a special-cased short-circuit. The enrichment text is used for retrieval only; the
model's "Current Question" section always receives the original, unmodified query.

## Semantic (vector) search

`HybridRetriever._semantic_candidates()` (`app/services/hybrid_retriever.py:405-467`) embeds
the query with the same `all-MiniLM-L6-v2` model Team4A used for ingestion (they must match —
mixing embedding models makes vector similarity meaningless), then queries the canonical Qdrant
collection with `score_threshold=-1.0` *deliberately* — the real threshold is applied after
score normalization, not against raw cosine similarity's native range. The candidate pool
fetched is `max(top_k, hybrid_candidate_pool_size, selection_pool_size)`, not the caller's bare
`top_k` — over-fetch first, filter/rank/truncate later.

## BM25 keyword search

`app/services/bm25_index.py`, wrapping `rank_bm25.BM25Okapi`. Two details matter:

**It's rebuilt fresh per query, per workspace** — not a single global persistent index. This is
deliberate, for multi-tenant correctness: a cross-workspace document must never even enter
BM25's IDF (term-rarity) statistics, not merely be filtered out afterward, since IDF is a
corpus-wide statistic that would otherwise leak information across workspaces.

**A real, previously-undetected bug**: `refresh_bm25_corpus()` — the method that populates the
in-memory chunk cache BM25 searches against — existed but was **never called by anything in the
running application**, confirmed by static analysis of every route and dependency plus direct
log evidence. Every deployed process's BM25 corpus was silently empty the whole time,
degrading "hybrid" search to semantic-only without anyone being able to tell from the API's
behavior alone. The fix wires this call into `main.py`'s `lifespan` startup hook, against the
same cached retriever instance the query path uses — one refresh, at boot, non-fatal on
failure (BM25 is a quality enhancement, not an availability dependency, logged but never
crashes the app if it fails).

The tokenizer is script-agnostic: ASCII alphanumeric runs OR Devanagari-block runs, kept as
*separate* alternatives rather than merged — so a script switch with no whitespace splits into
distinct tokens rather than fusing incorrectly. This fixed an original ASCII-only pattern under
which Devanagari text tokenized to nothing and could never match BM25 at all — but a residual
gap remains for Hindi compound-word spacing variants (see
[Known limitations](#known-limitations-from-the-code-itself)).

## Fusion — Reciprocal Rank Fusion

`reciprocal_rank_fusion()` (`hybrid_retriever.py:645-677`):
`score = Σ 1/(k + rank_i)`, summed across every ranked list a chunk appears in, with `k=60`
(`app/core/config.py:174-178`). Ties are broken by chunk_id, for determinism. The fused score
is then normalized by dividing by the theoretical maximum for the number of lists — chosen
specifically to preserve real score-gap magnitude rather than reducing to a pure rank index.

**Generation-authority filtering runs before RRF, on both legs independently** — a stale
candidate can never influence the fused ranking even transiently.

## The reranker (disabled by default)

Fully implemented (`app/services/reranker.py`, a cross-encoder), but
`reranker_enabled=False` by default (`config.py:200-209`) — "opt-in only... preserves the exact
pre-existing retrieval behavior... for every existing deployment until an operator explicitly
turns this on."

**Model choice, with a documented trade-off**: `cross-encoder/mmarco-mMiniLMv2-L12-H384-v1`, a
multilingual model, was chosen over the more common `ms-marco-MiniLM-L-6-v2` specifically
because the latter is English-only and "would give zero benefit for Hindi retrieval — the
project's identified largest weakness." This came at a measured cost: a manually-measured
weaker discrimination margin on Devanagari text than on English (roughly −1.79 vs. −4.98 for
Hindi candidates, and +8.63 vs. −5.51 for English), plus a real ~130-second one-time model-load
cost. If enabled, the candidate pool is first expanded (`reranker_candidate_pool_size=40`) so
the reranker has real headroom to promote something ranked below the RRF-selected top_k; on
`RerankerUnavailableError` it degrades gracefully to pre-rerank order rather than failing the
whole request.

## Generation-authority filtering

`app/services/generation_authority.py`, `GenerationAuthorityClient`. **This is the only place
Team4B touches MongoDB at all** — a narrow, read-only exception to read
`File.currentIngestionGeneration`. One batched, workspace-scoped query per call, no caching.

**The fail-closed mechanism, precisely**: the returned map contains *only* document_ids that
are validly-shaped, found, belong to the given workspace, and have a valid
`currentIngestionGeneration`. Anything else — malformed, missing, wrong workspace, or even a
*total Mongo outage* — simply means that document_id is absent from the map. A retrieval
candidate passes only if its own `document_id`/`ingestion_generation` are well-formed **and**
present in the map **and** equal — so a missing map entry, for any reason including infra
failure, causes exclusion, never a default-to-trust. This is the precise meaning of
"fail-closed" here: the failure mode is "answer without this content," never "answer with
possibly-stale content."

## Prompt construction and injection defenses

`build_prompt()` (`app/services/llm_generator.py:910-982`) assembles exactly:

```
{system instructions}

=== Context ===
{retrieved chunks, each provenance-labeled and neutralized}

=== Conversation History ===
{prior turns, or "(no prior conversation)"}

=== Current Question ===
{the user's query, also neutralized}
```

**Three layered defenses, each with an honestly-documented limit:**

1. **Untrusted-context framing** (`_UNTRUSTED_CONTEXT_BEGIN`/`_END` markers +
   `_UNTRUSTED_CONTEXT_NOTE`) — every retrieved chunk is bracketed by an explicit,
   position-independent statement that the enclosed text is data, not instructions, regardless
   of how it's phrased. This is the primary defense. Its mechanism is purely instructional
   framing — it relies on the model actually honoring it, which is exactly where the residual
   gap lives.
2. **`_neutralize_untrusted_text()`** — a narrow, purely syntactic layer applied to both
   retrieved text and the user's own query. It rewrites two specific patterns: a role-prefixed
   line (`system:`, `user:`, `assistant:`) and a literal occurrence of one of the prompt's own
   reserved section headers (`=== Context ===`, etc.). The code is explicit that this alone
   would **not** have stopped the actually-successful attacks discovered during security
   testing, which used no role marker at all — it's a narrower, defense-in-depth layer, not
   the primary one.
3. **`_is_forced_fixed_output()`**, an *output-side* guard, checked after generation. It
   detects a specific pattern: the model's entire answer (≤6 output tokens) appears verbatim as
   a contiguous quoted span inside a single retrieved chunk's raw text — evidence the model
   discarded the real question and echoed an attacker-planted short string from poisoned
   content. If triggered, the answer is replaced with the honest "insufficient context" message
   and `grounded=False`. **Structural limit, stated plainly in the code**: this can only ever
   trigger on answers of ≤6 words, so it cannot catch a longer hijacked answer by design — and
   the streaming path deliberately never live-streams an answer until it exceeds 6 words,
   specifically so it's guaranteed to have already cleared this check.

**A tested and rejected alternative**: routing the system instructions through Ollama's native
`system` request field (real template-level role separation) was tried and found to be a *net
regression* — it didn't fix the harder attacks and introduced new compliance failures. The
current delimiter-plus-neutralization approach is the evidence-selected final design, not the
first thing tried.

For the full threat model, the specific attack corpus, and the one documented residual finding
(`REPRO-SPOOF-5`), see [SECURITY_ARCHITECTURE.md](../SECURITY_ARCHITECTURE.md).

## Ollama and generation

Model: `llama3` by default (`config.py:264-267`), called via `httpx` against
`POST {ollama_url}/api/generate`. Generation timeout defaults to 15 seconds
(overridable — real-world CPU-only generation regularly exceeds this in this project's own dev
environment, hence the documented 30–140+ second latencies in
[KNOWN_LIMITATIONS.md](../KNOWN_LIMITATIONS.md); `llm_generation_timeout_seconds` and
`ollama_num_predict` exist specifically to bound worst-case behavior on constrained hardware).

**Structured output**: generation uses Ollama's JSON-schema-constrained decoding
(`{"answer": str, "grounded": bool}`) — live-confirmed to genuinely constrain decoding, not
merely a prompted hint. `grounded` can legitimately come back `None` if the model doesn't
produce valid structured JSON — the code is explicit that callers must never treat `None` as
`True`.

## Citations

Built **exclusively from retrieval metadata** (`app/services/response_assembly.py:88-120`) —
`document_id`, `document_title`, `chunk_id`, `relevance_score`, plus type-appropriate optional
fields (`page_number`/`section_heading` for documents, `start_timestamp`/`end_timestamp` for
video). If a required field is missing or malformed, the code raises rather than fabricating a
placeholder. The reranker is explicitly documented to never touch `chunk_id`/`text`/`metadata`
— only `relevance_score` — so it's structurally incapable of altering citation identity.
Deduplication uses `(document_id, page_number, start_timestamp, end_timestamp)` as the key,
keeping the highest-relevance occurrence.

## Streaming

`/api/v1/query/stream` uses **NDJSON**, not Server-Sent Events: zero-or-more
`{"type": "delta", "text": "..."}` lines, then one final `{"type": "done", ...}` or
`{"type": "error", ...}` line. The authoritative final answer always comes from re-parsing the
complete accumulated response the same way the non-streaming path does — the incremental deltas
are a best-effort live preview, not the source of truth. A real, disclosed trade-off: work that
happens *before* streaming starts (retrieval, session setup) can still fail with a proper HTTP
status; a failure *after* some tokens have already been sent can no longer change the HTTP
status, so it's reported as an in-band `{"type": "error"}` line instead.

## Conversation history

`app/services/conversation.py`, Redis-backed, 30-minute TTL by default, refreshed only on
write. Two read modes matter: `get_history()` returns the **complete** chronological history
(used by the `/history` route); `get_windowed_history()` returns only the most recent 5 turns
(`conversation_window_size`) — this is what actually gets fed into the LLM prompt. Neither read
path ever trims the stored data — the full history stays available regardless of how the
windowed view is used for prompting.

`seed_history()` restores a session from Team4C's durable MongoDB store after Redis TTL expiry,
guarded by a Redis lock and written in a single atomic pipeline (fixing an earlier bug where a
partial-write failure left a session permanently and silently stuck).

## Security and rate limiting

Same ES256/JWT verification pattern as Team4A (see
[TEAM4A_DEEP_DIVE.md](TEAM4A_DEEP_DIVE.md#security)), with Team4B's own expected audience
(`team4b-query`) and required scope (`query`). Rate limiting
(`app/api/rate_limit.py`) is a Redis-backed fixed-window counter — 30 requests per 60-second
window, keyed by `sub:workspace_id` (never client IP, since this API has no direct browser
caller). One deliberate asymmetry worth remembering: the JWT check **fails closed** (any
verification problem → reject), but the rate limiter **fails open** on a Redis outage (treats
the request as not-limited rather than blocking all traffic because a cache is down) — these
are different risk postures for different failure types, not an oversight.

## Configuration reference

| Setting | Default | File:line |
|---|---|---|
| `rrf_k` | 60 | `config.py:174-178` |
| `hybrid_candidate_pool_size` | 100 | `config.py:179-195` |
| `reranker_enabled` | `False` | `config.py:200-209` |
| `reranker_model_name` | `cross-encoder/mmarco-mMiniLMv2-L12-H384-v1` | `config.py:210-220` |
| `reranker_candidate_pool_size` | 40 | `config.py:221-235` |
| `default_top_k` | 5 | `config.py:240-245` |
| `default_score_threshold` | 0.3 | `config.py:246-251` |
| `ollama_model_name` | `llama3` | `config.py:264-267` |
| `llm_generation_timeout_seconds` | 15.0 | `config.py:268-272` |
| `session_ttl_minutes` | 30 | `config.py:321-325` |
| `conversation_window_size` | 5 | `config.py:326-330` |
| `rate_limit_requests_per_window` / `_window_seconds` | 30 / 60 | `config.py:422-423` |
| `canonical_qdrant_collection_name` | `educopilot_chunks` | `config.py:74-96` |

## Evaluation (RAGAS)

`app/services/ragas_adapter.py` computes exactly **`faithfulness`, `answer_relevancy`,
`context_precision`** — and deliberately, permanently excludes `context_recall`. Why: RAGAS
defines `context_recall` as requiring an independently-verified ground-truth reference answer;
an earlier version passed the *system's own generated answer* as that reference, which is
circular and invalid, since the metric would then just be checking the system against itself.
RAGAS's installed version ships no reference-free variant, so the code unconditionally sets
`context_recall=None` with a fixed explanatory reason string, rather than computing a
meaningless number. `POST /api/v1/evaluate` evaluates a caller-supplied batch of
`{query, response, contexts}` triples — it never runs retrieval/generation itself.

## Known limitations, from the code itself

- **Hindi/cross-script retrieval**: the multilingual embedding candidate's isolated semantic
  gains for English/Hinglish-against-Hindi queries "largely disappeared inside the real hybrid
  BM25+RRF pipeline" — a documented, real, unresolved weakness. The experimental modules that
  investigated this (`query_transform.py`, `multi_query_retrieval.py`) are explicitly *not*
  wired into production — evaluation tooling only.
- **Reranker's weaker Hindi confidence margin** — a real, measured trade-off (see
  [above](#the-reranker-disabled-by-default)), not hidden by the choice to use a multilingual
  model anyway.
- **The `grounded` field's real compliance gap** — the model doesn't always produce valid
  structured JSON; `None` is a genuine, non-zero outcome, never silently treated as `True`.
- **The prompt-injection defenses' precise residual gap** — see
  [above](#prompt-construction-and-injection-defenses) and
  [SECURITY_ARCHITECTURE.md](../SECURITY_ARCHITECTURE.md).
- **The RAGAS adapter's `ragas.evaluate()` path has reportedly never been exercised against a
  live Ollama/embedding model** in some development environments — only its pure helper
  functions have real test coverage in that case. Verify current status before repeating this
  claim.

## Examiner questions

**"Why hybrid retrieval instead of just vector search?"** Vector search finds conceptually
similar text but can miss exact-terminology matches (an error code, an acronym, a specific
function name) that a student might search for verbatim — BM25 covers exactly that gap.

**"Why RRF instead of just averaging the two scores?"** Vector-similarity and BM25 scores are
on fundamentally different, incomparable scales — you can't meaningfully add them. RRF works
from rank position instead, sidestepping the scale problem entirely.

**"If the reranker is better, why is it off by default?"** It's not that it's proven worse — it
was built as an opt-in enhancement, deliberately preserving existing, already-validated
retrieval behavior for every current deployment until someone explicitly turns it on with full
awareness of the trade-off (including its weaker Hindi confidence margin).

**"How do you know a citation is never hallucinated?"** Because citations are structurally
built only from `RetrievalResult.metadata` fields — the assembly code never reads or derives
anything from the model's own generated text, and raises an error rather than fabricating a
missing field.

**"What's the actual difference between 'mitigated' and 'solved' for prompt injection here?"**
One specific, previously-successful attack class (a forced short fixed output) is closed with a
validated guard. The broader instruction-following vulnerability — a model choosing to comply
with an embedded instruction despite the framing telling it not to — is not solved, and the
documentation says so explicitly rather than claiming victory.
