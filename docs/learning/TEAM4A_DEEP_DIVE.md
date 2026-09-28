# Team4A Deep Dive — Ingestion & Document Processing

A from-scratch, code-verified explanation of Team4A — what it does, why each piece exists, and
where to find it in the code. Pairs with [docs/TEAM4A.md](../TEAM4A.md) (the concise
reference) and [docs/architecture/ARCHITECTURE_REFERENCE.md](../architecture/ARCHITECTURE_REFERENCE.md).
Every claim below cites its exact source location; verify anything you plan to rely on against
the live code before quoting it as current fact in a fast-moving codebase.

## Table of contents

1. [What Team4A is, in one paragraph](#what-team4a-is-in-one-paragraph)
2. [Service architecture](#service-architecture)
3. [API surface](#api-surface)
4. [Upload and validation](#upload-and-validation)
5. [Text extraction, per source type](#text-extraction-per-source-type)
6. [Chunking](#chunking)
7. [Embedding generation](#embedding-generation)
8. [Metadata and source attribution](#metadata-and-source-attribution)
9. [The canonical path — identity, locking, and generations](#the-canonical-path--identity-locking-and-generations)
10. [The legacy path — Celery](#the-legacy-path--celery)
11. [Publishing to Qdrant](#publishing-to-qdrant)
12. [Duplicate prevention](#duplicate-prevention)
13. [Stale-job recovery](#stale-job-recovery)
14. [Security](#security)
15. [Configuration reference](#configuration-reference)
16. [Testing and known limitations](#testing-and-known-limitations)
17. [Examiner questions](#examiner-questions)

---

## What Team4A is, in one paragraph

Team4A turns a PDF, an MP4, or a YouTube URL into searchable, embedded chunks of text sitting
in a vector database, tagged with enough metadata (page number, timestamp, document identity)
that Team4B can later retrieve a chunk and cite exactly where it came from. It never answers
questions and never talks to a student directly — it is purely the *extract → chunk → embed →
publish* pipeline, callable only by Team4C, over a service-authenticated API
(`team4a/app/main.py:40-53`).

## Service architecture

`app/main.py` builds one `FastAPI` instance (`app.main.py:49`), adds a single
`RequestLoggingMiddleware` (line 50), and includes three routers: the five legacy endpoints
(`app/api/routes.py`), health checks (`app/api/health.py`), and the canonical endpoint
(`app/api/canonical_ingest.py`) — lines 51-53. There is **no `lifespan` hook** — every heavy
dependency (the embedding model, Qdrant client, Redis client) is constructed lazily on first
use, a convention repeated verbatim across `embedder.py`, `video_processor.py`,
`publisher.py`, `canonical_mutations.py`, `celery_app.py`, and `canonical_ingest.py`.

Two parallel pipelines exist in this one service:

- **Canonical** (`app/api/canonical_ingest.py` + `app/pipeline/canonical_ingestion.py`) — the
  one path the real product actually uses.
- **Legacy** (`app/api/routes.py` + `app/tasks.py`, Celery-backed) — an older, still-functional
  pipeline kept for backward compatibility, confirmed *not* called by Team4C's real client
  code (`app/api/routes.py:52-56`, cross-checked against `team4c/services/teamA/client.ts`).

They write to **different Qdrant collections** (`educopilot_chunks` vs.
`team4a_ingested_chunks`) and have meaningfully different guarantees — this split runs through
almost every section below, so it's worth internalizing early: **if you're asked "how does
ingestion work," the canonical path is the real answer; the legacy path is the historical
one.**

## API surface

| Method & path | File:line | Auth | Purpose |
|---|---|---|---|
| `POST /v1/ingest` | `canonical_ingest.py:248` | `require_ingest_identity` | **Canonical.** Synchronous, locked, generation-tracked ingestion |
| `POST /ingest/pdf` | `routes.py:210` | `require_ingest_identity` | Legacy, Celery-queued PDF upload |
| `POST /ingest/video` | `routes.py:333` | `require_ingest_identity` | Legacy, Celery-queued video upload |
| `POST /ingest/youtube` | `routes.py:419` | `require_ingest_identity` | Legacy, Celery-queued YouTube URL |
| `GET /jobs/{job_id}` | `routes.py:571` | `require_ingest_identity` | Legacy job status |
| `GET /jobs` | `routes.py:597` | `require_ingest_identity` | Legacy job list, paginated |
| `GET /health` | `health.py:64` | none | Liveness |
| `GET /readyz` | `health.py:79` | none | Readiness |

All five legacy routes only gained authentication during a security-hardening pass — before
that they were, in the code's own words, "an unauthenticated attack surface"
(`routes.py:46-65`).

The canonical request body (`CanonicalIngestRequest`) accepts exactly `document_id`,
`file_type`, `file_url` — and rejects any extra field (`extra="forbid"`,
`canonical_ingest.py:170-196`). `workspace_id` and `user_id` are **never** read from the
request body; they come exclusively from the verified JWT (see [Security](#security)) — this
is the tenancy invariant that makes it structurally impossible for a caller to ingest into a
workspace it doesn't own.

## Upload and validation

`FileStorage.save()` (`app/api/file_storage.py:55-138`) never trusts a client-supplied
filename — the saved name is always `{server-generated job_id}{fixed extension}`, which is
itself the path-traversal defense (`file_storage.py:8-14`).

Size limits are enforced twice: an early, non-authoritative check against the declared
`Content-Length` header, then an authoritative streaming byte-count while writing in 1 MiB
chunks — exceeding it raises `UploadTooLargeError` and deletes the partial file
(`file_storage.py:45,118-124`). Content-type is checked as an exact string match against the
client's declared `Content-Type` header only (`application/pdf` / `video/mp4`) — no
byte-sniffing, no extension inference (`routes.py:168-187`). Limits: 200 MB PDFs, 2 GB videos
by default (`app/config/settings.py:135-144`).

For the canonical path's `file_url` fetch, a much stronger, separate mechanism exists in
`app/pipeline/remote_source_resolver.py`: a trusted-origin allowlist (exact hostname match),
per-request SSRF-safe IP pinning, explicit rejection of cloud-metadata addresses
(`169.254.169.254`, `fd00:ec2::254`), redirect rejection by default, and magic-byte content
validation *after* download — never trusting the remote server's own `Content-Type` header
(`remote_source_resolver.py:10-30,69-80,129`).

## Text extraction, per source type

**PDF** — `app/processors/pdf_processor.py` uses **PyMuPDF**. Heading detection is a
deterministic, layout-based heuristic: font size ≥1.15× the character-weighted body-text size,
and ≤12 words — explicitly not a keyword list (`pdf_processor.py:37-56,236-273`).

**Video** — `app/processors/video_processor.py` shells out to **ffmpeg/ffprobe** for
probing/keyframes/audio extraction and uses **openai-whisper** for transcription, lazily
imported. Audio is transcribed in fixed 30-second windows so one failed window doesn't lose
the rest (`video_processor.py:52,92-125`). Keyframes are extracted but not persisted — only a
deterministic reference string (`kf_1_30s`) survives (lines 397-431). A video with no audio
track produces zero segments (`audio_absent=True`).

**YouTube** — `app/processors/youtube_processor.py` uses `youtube-transcript-api` for the
transcript and `yt-dlp` (metadata only, `download=False`) for title/channel/date. URL parsing
accepts only `youtube.com/watch?v=` and `youtu.be/` forms (lines 135-167).

**Hindi transcript fallback** — lives specifically in
`app/pipeline/canonical_extraction.py:115-150`, and **only** on the canonical YouTube path.
Tries `youtube_default_language` (default `"en"`) first; on
`TranscriptUnavailableError`, makes exactly one further attempt in
`youtube_fallback_language` (default `"hi"`). The code is explicit: "not a translation, never
an LLM call... whichever language actually succeeds is what gets ingested, verbatim"
(`canonical_extraction.py:131-140`). **The legacy `/ingest/youtube` route has no such
fallback.**

## Chunking

`app/pipeline/chunker.py`. Defaults: `chunk_size=512`, `chunk_overlap=50`
(`settings.py:51-60`), both counted in a lightweight, dependency-free regex token definition
(`\w+|[^\w\s]`) — deliberately *not* the embedding model's own subword tokenizer
(`chunker.py:39-43`). Splitting is sentence-aware (a simple regex splitter, not a full NLP
tokenizer), and a single sentence is never split mid-sentence even if it alone exceeds the
budget. Overlap is drawn from the previous chunk's own new content, staying inside
`chunk_size`, not added on top of it (lines 180-201).

**A pre-chunking step exists only for video/YouTube**: `app/pipeline/transcript_windowing.py`
groups raw, often fragment-sized transcript segments (a real observed bug: a standalone
"okay" becoming its own chunk) into windows targeting `chunk_size` words before the chunker
ever runs, with a minimum window size below which a trailing window merges into its
predecessor. **This only runs on the canonical path** — the legacy Celery pipeline chunks raw
segments directly, with no windowing (`app/tasks.py:367-369,428-430`). PDF is never windowed —
"a PDF segment is already a whole page."

## Embedding generation

`app/pipeline/embedder.py`. Model: **`all-MiniLM-L6-v2`**, pinned to a specific, verified HF
Hub commit SHA rather than "latest" — "so upstream repo pushes don't silently change which
weights are loaded" (`settings.py:87-100`). Output: **384 dimensions**, validated against the
loaded model's actual output size at startup, failing loudly on mismatch
(`embedder.py:166-180`). Batch size 32, runs on CPU by default, **L2-normalized** always
(`normalize_embeddings=True`), and runs **in-process** — no external embedding API call
(`embedder.py:58-103`). Distance metric for the Qdrant collection is set to **Cosine**
explicitly, "the standard, documented convention for this model" (`celery_app.py:201-211`).

## Metadata and source attribution

`app/pipeline/metadata.py`. The most interesting detail: `chunk_id` is a **deterministic
UUID5**, never random — derived from `job_id|source_type|segment_key|chunk_index|chunk.text`
against a fixed namespace UUID (`metadata.py:52-81`). This means re-enriching the exact same
chunk always produces the exact same ID, which is what makes re-publishing idempotent (see
[Publishing](#publishing-to-qdrant)).

Per-source-type fields, populated only when applicable (never faked for the wrong type):
PDF gets `page_number`/`headings`; video gets `start_timestamp`/`end_timestamp`/a nearest
`frame_reference`; YouTube gets `start_timestamp`/`video_title`/`channel_name`/`source_url`.

## The canonical path — identity, locking, and generations

**The problem this solves:** multiple concurrent or repeated ingestion attempts for the same
document must never race each other, and only one "generation" of chunks may ever be visible
at a time — even if the process crashes mid-attempt, with no stale or duplicate chunks left
behind.

**`IngestionLock`** (`app/pipeline/ingestion_lock.py`) is a Redis-coordinated per-document lock
plus a monotonic generation counter, implemented with three atomic Lua scripts (single Redis
round-trip each, closing a real gap an earlier two-round-trip design had):

- `acquire()` — atomically checks the lock is free, increments a never-expiring generation
  counter, then sets the lock with a lease. A failed acquisition never consumes a generation
  number.
- `renew()` — an owner-checked lease extension, re-run immediately before **every**
  externally-visible mutation (a Qdrant publish batch, the Mongo claim, cleanup) — not just on
  a timer. This is explicitly the "mutation gate."
- `release()` — an owner-checked, safe-no-op-if-already-lost unlock.

The code is explicit that Redis is *not* the authority for "which generation is currently
visible" — only MongoDB is.

**`MongoAuthorityClient.claim()`** (`app/pipeline/mongo_authority.py:155-219`) is the one and
only MongoDB write Team4A ever performs, and it's narrow: an atomic
`update_one(filter={"_id": id, "currentIngestionGeneration": {"$lte": N}}, update={"$set":
{"currentIngestionGeneration": N}})`. Three things worth knowing:
1. It uses `$lte`, never `!=` — the code explicitly flags `!=` as unsafe, since it "can let a
   stale, lower generation's claim overwrite a genuinely newer generation."
2. It never creates a `File` document (`upsert` stays `False`) — an earlier bootstrap version
   that did was deliberately removed. "Team4A does not, and must never, create a `File`
   document."
3. A `File` that exists but predates the field entirely also fails the `$lte` check and
   returns `succeeded=False` — distinguished from "no such document" (`MissingFileError`).

**`CanonicalIngestionOrchestrator.run()`** (`app/pipeline/canonical_ingestion.py:144-339`) ties
it together:

```
acquire lock → generation N
attach {document_id, workspace_id, user_id, ingestion_generation=N} to every chunk
renew (mutation gate) → publish generation-N chunks to educopilot_chunks
renew (mutation gate) → MongoAuthorityClient.claim(document_id, N)
  on success: renew → delete older generations → release lock
  on any failure: self-heal by deleting exactly the points THIS attempt published
                  (never a filter/range delete) → do NOT release the lock
                  ("it is not this worker's lock anymore")
```

One important, honestly-documented caveat from the module's own docstring: at the time this
was built, Team4C's real `File` schema did not yet contain `currentIngestionGeneration`, so
integration against the real collection was explicitly blocked pending a cross-team schema
change (`canonical_ingestion.py:28-39`) — worth checking against the current schema (see
[TEAM4C_DEEP_DIVE.md](TEAM4C_DEEP_DIVE.md)) rather than assuming this note is still current.

## The legacy path — Celery

`app/tasks.py` implements the same four-stage pipeline (extract → chunk → embed → publish) as
`process_pdf`/`process_video`/`process_youtube` Celery tasks, updating `IngestionJob`
status/progress at each stage boundary (25/50/75/100%). Differences from canonical: no
lock/generation/identity layer at all — `IngestionJob` "carries no workspace_id/user_id field
at all"; no transcript windowing; and it publishes with no `collection_name_override`, so it
lands in the **legacy** collection, `team4a_ingested_chunks` — never the canonical one, and the
two are never conflated in any code path.

## Publishing to Qdrant

`app/pipeline/publisher.py`. Point IDs are a **deterministic UUID5 of the chunk_id** — so
re-publishing the same chunk is a safe upsert, never a duplicate. Batched at 100 points per
call, retried up to 3 times beyond the first attempt with exponential backoff (2s → 4s → 8s).
On permanent failure, an alert callback fires — currently "deliberately just a callback/log
hook, not a real email/Slack/PagerDuty integration."

Canonical-only deletes (`app/pipeline/canonical_mutations.py`) are deliberately kept separate
from the upsert-only `Publisher`: `delete_exact_points()` for self-healing a failed attempt,
and `delete_older_generations()` (a strict `<` filter, never `!=`) for cleanup after a
successful claim.

## Duplicate prevention

Applies to the **legacy routes only** (the canonical path's generation/lock mechanism already
solves this differently). Root cause: every legacy upload gets a fresh random `job_id`, and
chunk identity is derived from `job_id` — so two uploads of byte-identical content "always
publish two fully disjoint sets of Qdrant points" without this fix (`routes.py:116-130`).

The fix reuses the *existing* `IngestionLock` primitive rather than inventing a new one: a
SHA-256 hash of the file bytes (streamed, never loaded whole into memory) becomes the lock's
`document_id`, namespaced by source type
(`f"legacy:{source_type}:{content_hash}"`). A second upload of the same content within the
lease window (default 600s) gets `HTTP 409` and its just-saved file is deleted immediately.

## Stale-job recovery

Also legacy-only. A job's `updated_at` is only touched at the 4 pipeline stage boundaries — if
the worker crashes mid-task, nothing updates it again, and it stays `PROCESSING` forever
without this fix.

`_recover_if_stale()` (`routes.py:479-568`) checks, on read (`GET /jobs/{id}` or `GET /jobs`):
if the job is `PROCESSING` and hasn't been touched in over `stale_processing_threshold_seconds`
(default 14400s = 4 hours — deliberately equal to the lock lease, since there's no finer
per-stage heartbeat to distinguish "stalled" from "legitimately still running Whisper on a
multi-hour video"), it acquires a short (10s) recovery lock in its own namespace, **re-fetches
and re-checks** the job under that lock (it might have genuinely completed in the race
window), and only then marks it `FAILED` with a clear, safe-to-retry error message.

## Security

`app/security/service_jwt.py`'s `ServiceJWTVerifier` accepts **ES256 only** — "never HS256...
would require sharing the signing secret with 4A, which Rev.4.4 explicitly forbids." It checks
algorithm, `kid`, issuer, audience, clock-skew-bounded expiry, and required claim presence, then
explicit semantic checks (non-empty `workspace_id`/`sub`/`jti`, exact `scope` match, and a
future-dated `iat` beyond skew tolerance rejected — PyJWT's own leeway doesn't cover `iat`).
Returns a typed, immutable `ServiceIdentity` — "there is no code path that returns a 'probably
fine' identity." Team4A holds only public verification keys; no private-key code exists
anywhere in this service.

## Configuration reference

| Setting | Default | File:line |
|---|---|---|
| `chunk_size` / `chunk_overlap` | 512 / 50 | `settings.py:51-60` |
| `embedding_model_name` / `embedding_dimensions` | `all-MiniLM-L6-v2` / 384 | `settings.py:65-100` |
| `embedding_device` | `cpu` | `settings.py:74-81` |
| `pdf_max_size_mb` / `pdf_max_pages` | 200 / 5000 | `settings.py:135-144` |
| `video_max_size_gb` / `video_max_duration_hours` | 2 / 4 | `settings.py:105-130` |
| `whisper_model_name` | `base` | `settings.py:105-130` |
| `youtube_default_language` / `youtube_fallback_language` | `en` / `hi` | `settings.py:149-167` |
| `redis_broker_url` / `redis_result_backend_url` | `:6379/0` / `:6379/1` | `settings.py:172-179` |
| `qdrant_collection_name` (legacy) | `team4a_ingested_chunks` | `settings.py:206-233` |
| `canonical_qdrant_collection_name` | `educopilot_chunks` | `settings.py:247` |
| `ingestion_lock_lease_seconds` | 14400 (4h) | `settings.py:274-284` |
| `legacy_ingest_dedup_lease_seconds` | 600 | `settings.py:300` |
| `stale_processing_threshold_seconds` | 14400 | `settings.py:325` |
| `service_jwt_expected_audience` / `_required_scope` | `team4a-ingestion` / `ingest` | `settings.py:344-363` |
| `file_url_require_https` | `True` | `settings.py:379-393` |

## Testing and known limitations

918 tests collected across 44 files (913 passed / 5 skipped as last freshly run — see
[M6_STATUS.md](../M6_STATUS.md) for the current authoritative count). Categories: route/API,
legacy dedup & stale recovery, the canonical pipeline (lock, authority, mutations), Celery
wiring, each pipeline stage (chunker/embedder/metadata/publisher, each with a companion
property-based test file), each processor (PDF/video/YouTube, plus language-fallback and
windowing), security (service JWT, remote-source SSRF resolver, non-root Docker), and upload
handling.

A documented, known interface gap: an audio-absent video produces zero chunks (job still
`COMPLETED`, `chunk_count=0`) — there's no representation yet for a frame-only, textless
record.

## Examiner questions

**"Why does the canonical path need a distributed lock at all — isn't one upload just one
request?"** Because re-ingestion (a user re-uploading the same material, or a retry after a
failure) can race with itself or with a still-in-flight earlier attempt for the same
`document_id`. Without the lock, two concurrent attempts could both publish chunks, or one
could claim authority over a generation the other is still writing.

**"What happens if Team4A crashes halfway through publishing?"** For the canonical path: the
lock is never released by a crashed process (no `finally` runs), so it simply expires after its
lease — the next attempt for that document gets a fresh generation number and the crashed
attempt's partial points are cleaned up by whichever future generation succeeds
(`delete_older_generations`). For the legacy path: `_recover_if_stale()` on the next read marks
the orphaned job `FAILED`, safe to retry.

**"Why two entirely separate ingestion pipelines?"** The legacy one predates the canonical
design and is kept for backward compatibility/testing — it's explicitly confirmed the real
product only calls `/v1/ingest`. This is disclosed, not hidden, in
[docs/TEAM4A.md](../TEAM4A.md) and the architecture diagrams.

**"Why chunk with a custom regex tokenizer instead of the embedding model's own tokenizer?"**
Keeps chunking a lightweight, dependency-free operation decoupled from whichever embedding
model happens to be configured — the chunker's job is text segmentation, not
model-specific tokenization.
