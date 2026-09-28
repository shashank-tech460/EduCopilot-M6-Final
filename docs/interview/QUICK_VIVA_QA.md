# Quick Viva Q&A — One-Line Answers

Rapid-fire answers for a viva or interview where you need one clear sentence, fast. For the
detailed version of any answer here, see the matching file in this folder or the
[learning/](../learning/) deep-dives. Organized by category, matching
[docs/PROJECT_QA.md](../PROJECT_QA.md)'s broader Q&A for longer, narrative explanations.

## Project overview

- **What is EduCopilot M6?** An AI-powered learning platform where students upload their own
  PDFs/videos and ask an AI Tutor questions. Answers are retrieved and cited from that
  material, not the model's general training — this is the design goal, not a guarantee;
  retrieval can miss relevant content and incorrect answers remain possible.
- **What problem does it solve?** Students have material but no fast, trustworthy way to ask
  "what does my own material say about X" and get a cited answer, or an honest "I don't know."
- **What are the three services?** Team4A (ingestion), Team4B (RAG/retrieval + generation),
  Team4C (the Next.js product).
- **Is it deployed anywhere?** No — local development only, explicitly, everywhere in the docs.

## Architecture

- **How do the three services communicate?** HTTP, authenticated by a short-lived ES256-signed
  service JWT that only Team4C can mint.
- **Do Team4A and Team4B talk to each other?** No — never directly; both are only called by
  Team4C.
- **What database do they share?** MongoDB, but narrowly: Team4A writes only
  `File.currentIngestionGeneration`; Team4B reads only that same field.
- **What's the one thing that must match across all three services' config?**
  `MONGO_DATABASE_NAME` — the single most common local-setup mistake per the docs.

## Team4A — ingestion

- **What does Team4A do?** Extract → chunk → embed → publish to Qdrant, for PDFs, videos, and
  YouTube URLs.
- **Which endpoint does the real product use?** `POST /v1/ingest` — the canonical path; five
  legacy endpoints exist but are confirmed unused by the live product.
- **What's the chunk size/overlap?** 512 tokens, 50-token overlap.
- **What embedding model?** `all-MiniLM-L6-v2`, 384 dimensions, cosine distance.
- **How is a duplicate upload prevented?** A SHA-256 content hash becomes a Redis lock key on
  the legacy routes — a second identical upload within the lease window gets a 409.
- **What stops two concurrent ingestion attempts for the same document from racing?** A
  Redis-backed `IngestionLock` plus a monotonic generation counter, with MongoDB as the single
  source of truth for "which generation is currently visible."
- **What happens if a worker crashes mid-job?** Stale-job recovery marks it `FAILED` (safe to
  retry) the next time its status is read, after a 4-hour threshold.

## Team4B — RAG

- **What does "RAG" stand for and mean here?** Retrieval-Augmented Generation — retrieve the
  actually-relevant text first, then force the model to answer only from that text.
- **What's the retrieval strategy?** Hybrid — semantic (vector) search plus BM25 keyword
  search, merged with Reciprocal Rank Fusion.
- **Why hybrid instead of just vector search?** Vector search misses exact-terminology matches
  BM25 catches, and vice versa for conceptual similarity.
- **What's RRF's k value?** 60.
- **Is the reranker used?** Implemented, but disabled by default — opt-in only.
- **What LLM generates the answer?** A local Ollama model, `llama3` — no cloud API call
  anywhere in the pipeline.
- **How are citations built?** Exclusively from retrieval metadata — never from the model's
  own generated text.
- **What stops a stale/re-ingested document from being retrieved?** The generation-authority
  filter — fail-closed: if a document's current generation can't be confirmed, it's excluded,
  never trusted by default.
- **Is prompt injection solved?** No. Mitigated for one specific, validated attack pattern
  (Phase 5K's output-side guard). A later query-neutralization attempt did **not** stop a
  direct instruction-override attack on the live model — it still fully succeeded on retest.
  A separate, lower-severity disclosure case (`REPRO-SPOOF-5`) also remains open.

## Team4C — product

- **What framework?** Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS, shadcn/ui.
- **How does auth work?** Auth.js v5, credentials provider, bcrypt password hashing, JWT
  session strategy.
- **What's `assertOwnership()`?** The single shared check that a workspace exists AND belongs
  to the caller — both failure cases return the identical 404, so the ID space isn't probeable.
- **How does streaming chat work?** The Vercel AI SDK's `useChat()` hook, proxied through
  Team4C's own `/api/chat` route, which forwards Team4B's real token stream.
- **What was the "stuck Thinking" bug?** A dev-mode-only issue — Next.js Fast Refresh
  remounting the chat component mid-stream orphaned the listening `useChat()` instance; fixed
  with a 240-second client-side watchdog that recreates the instance.

## Security

- **What algorithm signs the service JWT?** ES256 (asymmetric) — Team4C holds the only private
  key; Team4A/4B hold only the public key, so they can verify but never forge a token.
- **Why not a shared secret instead?** With a shared secret, anything that can verify a token
  could also forge one — asymmetric signing removes that risk entirely.
- **How long does a service token live?** 300 seconds (5 minutes).
- **How is workspace isolation enforced?** At three independent layers: Team4C's API boundary,
  Team4B's retrieval scoping, and a second Team4C re-check of citations after the fact.
- **Is there rate limiting?** Only on Team4B's 3 most expensive routes (query, query/stream,
  evaluate) — 30 requests/60s, Redis-backed. Team4A and Team4C have none; it's not system-wide.

## Databases

- **What does MongoDB store?** Users, workspaces, files, conversations, messages — Team4C's
  product schema.
- **What does Qdrant store?** Chunk text, embeddings, and metadata — the canonical collection
  is `educopilot_chunks`.
- **Why two separate Redis instances?** So Team4A's Celery/lock load and Team4B's conversation
  cache never compete for the same memory or connections.

## Testing

- **Is there real test coverage?** Yes — hundreds of pytest tests per Python service, hundreds
  of Vitest tests plus a live Playwright E2E suite for Team4C; current counts:
  [M6_STATUS.md](../M6_STATUS.md).
- **Is there a known failing test?** One, explained and tracked, not silenced — a
  stale-ground-truth-data issue in a Team4B evaluation test, not a code defect.

## Limitations

- **Biggest known limitation?** Hindi/cross-script retrieval is measurably weaker than
  same-language retrieval — a real, disclosed, unresolved gap.
- **Is the system production-ready?** No, and the docs say so explicitly — local development
  only, no load testing, no cloud deployment.
