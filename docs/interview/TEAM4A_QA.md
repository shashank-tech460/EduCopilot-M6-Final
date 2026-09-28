# Team4A Q&A — Ingestion

Deep-answer format: short answer → explanation → example → code reference → a likely
follow-up. For narrative-depth reading rather than Q&A lookup, see
[TEAM4A_DEEP_DIVE.md](../learning/TEAM4A_DEEP_DIVE.md).

---

**Q1. What does Team4A actually do?**

**Short answer:** It turns a PDF, video, or YouTube URL into embedded, searchable chunks
stored in Qdrant.

**Detailed explanation:** Four stages, always in this order: extract raw text (per source
type), split it into overlapping chunks, generate a vector embedding for each chunk, and
publish those chunks (text + vector + metadata) to Qdrant. It's the only service that ever
touches raw uploaded files.

**Example:** A 40-page PDF becomes roughly 40+ chunks (one page can produce multiple chunks if
it's long), each tagged with its page number.

**Code reference:** `team4a/app/pipeline/` (chunker.py, embedder.py, metadata.py,
publisher.py).

**Possible follow-up:** *"Does it ever generate the answer to a question?"* No — Team4A never
sees a question, only documents. Answering is entirely Team4B's job.

---

**Q2. Why are there two ingestion paths — canonical and legacy?**

**Short answer:** The legacy path is an older pipeline kept for backward compatibility; the
canonical path is what the real product actually uses today.

**Detailed explanation:** The canonical path (`POST /v1/ingest`) adds a distributed lock,
generation tracking, and identity-scoped metadata the legacy path never had. It's confirmed,
by inspecting Team4C's own service client, that Team4C's real traffic only ever calls the
canonical endpoint.

**Example:** Uploading a PDF through the actual app always hits `/v1/ingest`, never
`/ingest/pdf`.

**Code reference:** `team4a/app/api/canonical_ingest.py` vs. `team4a/app/api/routes.py`.

**Possible follow-up:** *"Should the legacy routes just be deleted?"* They still work and are
tested, so removing them is a real decision with a real cost (losing backward compatibility),
not an obviously-free cleanup — it's noted as a legacy path, not flagged as dead code to
delete.

---

**Q3. Why does the canonical path need a distributed lock?**

**Short answer:** To stop two concurrent (or repeated) ingestion attempts for the same document
from racing each other and leaving duplicate or inconsistent chunks.

**Detailed explanation:** Without the lock, a retry racing an in-flight first attempt could
both publish chunks for the same document, or one could claim "current" status over a
generation the other hasn't finished writing yet. The lock plus a monotonic generation counter
ensures only one attempt is ever "in charge" of a document at a time, and MongoDB (not Redis)
is the single source of truth for which generation is currently visible.

**Example:** A student re-uploads the same PDF after fixing a typo in its filename — the second
attempt gets a fresh generation number, and once it succeeds, the first generation's chunks are
cleaned up.

**Code reference:** `team4a/app/pipeline/ingestion_lock.py`, `mongo_authority.py`.

**Possible follow-up:** *"What if the process crashes while holding the lock?"* The lock is
never explicitly released by a crashed process — it simply expires after its lease (4 hours by
default), and the next attempt proceeds with a fresh generation.

---

**Q4. What's a "generation" in this context?**

**Short answer:** A monotonically increasing number identifying one ingestion attempt for a
specific document — only the highest successfully-claimed generation is considered current.

**Detailed explanation:** Every lock acquisition issues the next generation number for that
document. If an attempt fails partway through, its points are deleted and the lock is left to
expire — the failed attempt's generation is simply never claimed. Team4B checks a retrieved
chunk's own `ingestion_generation` against what MongoDB currently says is authoritative for
that document, and drops anything that doesn't match.

**Example:** Generation 1 succeeds and is claimed. A later re-ingestion gets generation 2; once
generation 2 succeeds, generation 1's points are deleted and generation 2 becomes current.

**Code reference:** `team4a/app/pipeline/canonical_ingestion.py`.

**Possible follow-up:** *"Why not just overwrite the old chunks directly?"* Because a failed
overwrite mid-way would leave a mix of old and new chunks with no way to tell which is which —
generations let a failed attempt be cleanly discarded instead.

---

**Q5. Walk through what happens when a PDF is uploaded, from Team4A's side only.**

**Short answer:** Verify the JWT → acquire a lock → extract text page-by-page → chunk → embed
→ publish to Qdrant → claim the generation in MongoDB → clean up old generations → release the
lock.

**Detailed explanation:** See the full sequence in
[SYSTEM_ARCHITECTURE_GUIDE.md](../guides/SYSTEM_ARCHITECTURE_GUIDE.md#sequence-uploading-a-document).
Every mutation (a publish batch, the Mongo claim) is preceded by re-confirming the lock is
still held — the "mutation gate" pattern — so a lock lost mid-attempt is caught before any
further write happens.

**Example:** If the lock is lost between chunking and publishing (extremely unlikely, but
possible under heavy load), the publish step never runs — the mutation gate catches it first.

**Code reference:** `team4a/app/pipeline/canonical_ingestion.py:144-339`.

**Possible follow-up:** *"Why re-check the lock before every mutation instead of just once at
the start?"* Because the whole pipeline can take a while (video transcription especially) — a
single check at the start wouldn't catch a lock lost partway through a long-running attempt.

---

**Q6. How does chunking actually split the text?**

**Short answer:** Sentence-aware splitting into ~512-token pieces with 50 tokens of overlap
between consecutive chunks, using a lightweight regex tokenizer, never a full NLP library.

**Detailed explanation:** A single sentence is never split mid-sentence even if it alone
exceeds the token budget — an explicit exception. Overlap comes from the previous chunk's own
tail content, not duplicated from further back, and stays inside the chunk_size budget rather
than being added on top of it.

**Example:** A 1000-word page becomes roughly 2 chunks with a small shared tail of text between
them, so a concept split across the boundary still has some context in both chunks.

**Code reference:** `team4a/app/pipeline/chunker.py`.

**Possible follow-up:** *"Why not use the embedding model's own tokenizer for chunk sizing?"*
Keeps the chunker decoupled from whichever embedding model is configured — swapping models
doesn't require touching chunking logic.

---

**Q7. Why is there a separate "transcript windowing" step for video/YouTube but not PDF?**

**Short answer:** Raw transcript segments can be tiny fragments (a single word), which would
otherwise become their own near-useless chunk; windowing groups them into reasonably-sized
pieces before chunking. A PDF page is already a sensible unit, so it needs no such step.

**Detailed explanation:** This was a real, observed bug — a transcript segment like "okay"
becoming its own standalone retrievable chunk, hurting retrieval quality. Windowing groups
consecutive raw segments to target the same size as `chunk_size`, merging any trailing
under-sized window into its predecessor.

**Example:** Ten short transcript fragments spanning 20 seconds get grouped into one
reasonably-sized window before the chunker ever sees them.

**Code reference:** `team4a/app/pipeline/transcript_windowing.py`.

**Possible follow-up:** *"Does the legacy pipeline do this too?"* No — only the canonical path
windows transcripts; the legacy Celery pipeline chunks raw segments directly.

---

**Q8. What's the Hindi YouTube fallback, exactly?**

**Short answer:** If the default-language (English) transcript is unavailable, the canonical
path tries Hindi as a second, single attempt — never a translation, never an LLM call, just
whichever language's real transcript actually succeeds.

**Detailed explanation:** This exists only on the canonical YouTube path, not the legacy one.
It's a narrow, MVP-scoped correction, not a general multilingual solution.

**Example:** A YouTube video with only a Hindi-language transcript available still gets
ingested (in Hindi) instead of failing outright.

**Code reference:** `team4a/app/pipeline/canonical_extraction.py:115-150`.

**Possible follow-up:** *"Does this fix Team4B's Hindi retrieval weakness?"* No — that's an
entirely separate, still-open limitation in Team4B's BM25 tokenization; this fallback only
affects whether a transcript gets ingested at all, not how well it's later retrieved.

---

**Q9. How is a duplicate upload prevented?**

**Short answer:** A SHA-256 hash of the file's bytes becomes a Redis lock key on the legacy
routes; a second upload with an identical hash within the lease window gets rejected with a
409.

**Detailed explanation:** This exists because the legacy pipeline's chunk identity is derived
from a fresh random `job_id` every time, so without this fix, two uploads of byte-identical
content would always publish two fully disjoint sets of chunks. It reuses the existing
`IngestionLock` primitive rather than inventing a new mechanism.

**Example:** Uploading the same PDF twice in a row (perhaps a double-click) is rejected on the
second attempt rather than creating duplicate chunks.

**Code reference:** `team4a/app/api/routes.py:114-207`.

**Possible follow-up:** *"Does this apply to the canonical path too?"* No — the canonical path
solves a related but different problem (concurrent/repeated ingestion of the *same document
identity*) with its own lock+generation mechanism; this specific content-hash mechanism is
legacy-route-only.

---

**Q10. What happens if a worker crashes mid-ingestion?**

**Short answer:** On the legacy path, the job is detected as stale and marked `FAILED` (safe to
retry) the next time anyone reads its status, after a 4-hour threshold.

**Detailed explanation:** A job's `updated_at` only advances at four pipeline stage
boundaries — a crash between boundaries leaves it stuck. Recovery is lazy (checked on read, not
via a background scheduler), and re-checks the job under a short lock before marking it failed,
specifically to avoid falsely failing a job that genuinely completed in the tiny race window.

**Example:** A worker process is killed mid-transcription; the job silently sits in
`PROCESSING` until someone next requests its status, at which point it flips to `FAILED` with
a clear "safe to retry" message.

**Code reference:** `team4a/app/api/routes.py:479-568`.

**Possible follow-up:** *"Why 4 hours specifically?"* It's set equal to the lock's own lease
duration, because there's no finer-grained heartbeat than the four stage boundaries — a shorter
threshold couldn't reliably distinguish "stalled" from "legitimately still running a long
video transcription."

---

**Q11. What embedding model is used, and why that one specifically?**

**Short answer:** `all-MiniLM-L6-v2`, a small, local, 384-dimension sentence-embedding model.

**Detailed explanation:** It's small enough to run on CPU with no GPU, keeping the whole
pipeline free of any cloud dependency (consistent with the same choice for the LLM itself), and
384 dimensions keeps Qdrant's storage/search cost low. It's pinned to a specific, verified model
revision (a commit SHA, not "latest") so an upstream repo change can't silently swap the
weights being used.

**Example:** A chunk's text becomes a 384-number vector, normalized to unit length, stored
alongside the chunk in Qdrant.

**Code reference:** `team4a/app/pipeline/embedder.py`, `team4a/app/config/settings.py:65-100`.

**Possible follow-up:** *"What would break if Team4B used a different embedding model?"*
Nothing would technically error, but retrieval would become meaningless — cosine similarity
between vectors from two different models' embedding spaces isn't a valid comparison at all.

---

**Q12. What security protects Team4A's endpoints?**

**Short answer:** Every route except `/health`/`/readyz` requires a verified ES256-signed
service JWT, checked via `require_ingest_identity`.

**Detailed explanation:** The verifier checks algorithm, key ID, issuer, audience, expiry
(with clock-skew tolerance), and every required claim's presence — plus explicit semantic
checks (correct `scope`, non-empty identity fields, no future-dated token). Team4A only ever
holds public verification keys.

**Example:** A request with a valid signature but the wrong `aud` claim (say, one minted for
Team4B) is rejected — signature validity alone isn't enough.

**Code reference:** `team4a/app/security/service_jwt.py`.

**Possible follow-up:** *"Were these routes always authenticated?"* No — a security-hardening
pass found the five legacy routes had no authentication at all before this fix; the code's own
comments call this out plainly as a real, previously-existing gap.
