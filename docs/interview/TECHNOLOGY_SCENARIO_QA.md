# Technology Choices & Scenario-Based Q&A

Two related categories: "why this technology and not that one," and "what would you do if X
went wrong." Pairs with [TECHNOLOGY_DECISIONS.md](../guides/TECHNOLOGY_DECISIONS.md) (the full
per-technology reference) and [TROUBLESHOOTING.md](../TROUBLESHOOTING.md) (the real, tested
diagnostic playbook).

## Technology alternatives

**Q1. Why a local LLM (Ollama/Llama 3) instead of an API like OpenAI or Anthropic?**

**Short answer:** So course material — potentially sensitive to a student — never leaves the
local machine to reach a third-party API.

**Detailed explanation:** This is stated as a deliberate privacy/control choice, not just a
cost-saving measure — the whole pipeline (embedding model too) is kept local specifically to
avoid any external data exposure. The real, measured cost is latency: 30–140+ seconds per
answer on this project's CPU-only development setup, versus what would likely be sub-second
with a cloud API.

**Follow-up:** *"Would you make the same choice for a real production deployment?"* It's a
genuine trade-off worth discussing rather than a settled answer — a GPU-backed local deployment
would close much of the latency gap while keeping the privacy property; a hosted-LLM option is
explicitly listed as a real, undone deployment consideration in
[DEVELOPER_HANDOFF.md](../DEVELOPER_HANDOFF.md).

---

**Q2. Why Qdrant instead of pgvector (a Postgres extension)?**

**Short answer:** A dedicated vector database gives mature approximate-nearest-neighbor search
with metadata filtering in one system; pgvector would mean one fewer service to run, at the
cost of a less specialized ANN implementation.

**Follow-up:** *"Is running a fourth piece of infrastructure locally worth it?"* A fair
question — the trade-off is real infrastructure overhead versus retrieval-quality/filtering
maturity; this project chose the latter.

---

**Q3. Why Reciprocal Rank Fusion instead of a learned fusion model?**

**Short answer:** RRF needs no training data and no tuning beyond one constant (`k`), and
sidesteps the raw-score-comparability problem entirely by working from rank position.

**Follow-up:** *"Isn't the reranker basically a learned alternative?"* Not quite the same
role — the reranker is an optional *second-stage* refinement over RRF's already-fused
candidates, not a replacement for the fusion step itself.

---

**Q4. Why MongoDB instead of PostgreSQL for the product schema?**

**Short answer:** The core entities (a workspace containing files, a conversation containing
messages) are naturally document-shaped containment relationships, not requiring the explicit
joins a relational schema would need for the same structure.

**Follow-up:** *"What do you lose by not using a relational database?"* Database-level
relational integrity enforcement — `workspace_id`/`userId` scoping here is entirely enforced in
application code (`assertOwnership()`), not by a foreign-key constraint the database itself
would refuse to violate.

---

**Q5. Why keep Team4A and Team4B as separate services instead of merging retrieval into the
ingestion service?**

**Short answer:** They have fundamentally different load patterns and failure tolerances —
ingestion is occasional and heavy; retrieval needs to be consistently responsive under
conversational load.

**Follow-up:** *"What would merging them actually break?"* Nothing functionally required them
separate, but a merged service would mean a burst of uploads could degrade chat responsiveness
for everyone, since they'd compete for the same process's resources.

---

**Q6. Why Next.js's App Router specifically, rather than a separate React SPA + Express
backend?**

**Short answer:** One deployable project serves both the UI and the backend-for-frontend API
layer (auth, ownership checks, service-JWT minting) without a second server to run and keep in
sync.

**Follow-up:** *"What's the downside of coupling the frontend and BFF this tightly?"* Less
flexibility to scale or deploy the API layer independently from the UI — acceptable for this
project's scope, a real constraint for a much larger one.

## Scenario-based troubleshooting

**Q7. A student reports the AI Tutor says "I don't have enough information" for a question you
know the material covers. Where do you look first?**

**Short answer:** Confirm the material's status is actually `"ready"` (not still `"processing"`
or silently `"failed"`), then check whether the BM25 corpus was refreshed at Team4B's last
startup (a real, previously-existing bug class) and whether the generation-authority check is
excluding the document for any reason.

**Detailed explanation:** This mirrors a real investigation documented in this project's own
history: extensive live testing traced a very similar symptom, in one specific case,
to inconclusive root causes after ruling out the obvious candidates — the honest answer to "is
there always a knowable root cause" is sometimes no, and the right move is to say so rather
than force a fix. In another, earlier case, the actual cause was the BM25-corpus-never-refreshed
bug described in [TEAM4B_DEEP_DIVE.md](../learning/TEAM4B_DEEP_DIVE.md#bm25-keyword-search).

**Code reference:** `team4c/models/File.ts` (`status`), `team4b/app/services/hybrid_retriever.py`
(`refresh_bm25_corpus`), `generation_authority.py`.

**Follow-up:** *"What would you check if none of those explain it?"* Whether the query's
language/script is hitting the documented Hindi/cross-script retrieval weakness — a real,
disclosed limitation, not every case has a hidden bug behind it.

---

**Q8. A developer says "my local Redis for Team4B isn't working." What's the single most likely
cause, per this project's own documented experience?**

**Short answer:** They're pointed at port 6379 (Team4A's Redis) instead of 6380 (Team4B's) — two
separate instances is the single most commonly confused piece of local setup, called out
explicitly in [DEVELOPER_HANDOFF.md](../DEVELOPER_HANDOFF.md)'s "Common mistakes" section.

**Follow-up:** *"Is there a way this could fail silently rather than obviously?"* Yes — if both
instances are technically reachable on the wrong ports, Team4B might connect to *a* Redis, just
the wrong one, and conversation history could unexpectedly not appear as expected rather than
erroring outright.

---

**Q9. Ingestion is stuck at "processing" for a video that should have finished ten minutes ago.
What do you check?**

**Short answer:** Whether the worker actually crashed (in which case stale-job recovery should
eventually mark it `FAILED` on the next status read, after the 4-hour threshold) versus whether
it's still legitimately transcribing a very long video (Whisper on CPU is slow).

**Detailed explanation:** This is exactly the ambiguity the stale-job-recovery threshold was
tuned around — there's no finer-grained heartbeat than the four pipeline stage boundaries, so
"stuck" and "legitimately slow" can look identical for hours on a long video. The honest,
documented trade-off is a 4-hour threshold, not a shorter one that risks false positives on real
long-running jobs.

**Code reference:** `team4a/app/api/routes.py:479-568`.

**Follow-up:** *"Could this threshold ever be wrong for a specific deployment?"* Yes — it's a
config value (`stale_processing_threshold_seconds`), adjustable per-deployment if the expected
video-length distribution is very different from what 4 hours assumes.

---

**Q10. A citation appears in an answer, but clicking it shows nothing / a broken page. What are
the possible causes, given how citations are built?**

**Short answer:** Either the file was deleted after the answer was generated but before the
click (Qdrant's own eventual-cleanup timing), or — much more subtly — the citation's `fileId`
failed Team4C's own re-verification and should have been rendered as `disabled`, suggesting a
frontend rendering bug rather than a data problem.

**Detailed explanation:** Since citations are structurally built only from retrieval metadata
(never fabricated), a genuinely broken citation link points either at a timing issue
(content deleted between generation and click) or a UI bug in how a `disabled: true` citation
is rendered — not at a hallucinated citation, which the architecture rules out by construction.

**Code reference:** `team4c/components/chat/SourceAttribution.tsx`,
`team4c/lib/workspaceFilter.ts`.

**Follow-up:** *"How would you distinguish these two causes quickly?"* Check whether the
citation renders as visually disabled (a UI signal it was legitimately suppressed) versus
rendering as an active link that simply 404s (a genuine broken-link bug worth investigating
further).

---

**Q11. A new team member asks "why does the codebase have both a `LIMITATIONS.md` and a
`KNOWN_LIMITATIONS.md`?" How do you explain the difference?**

**Short answer:** `KNOWN_LIMITATIONS.md` is Team4B's own retrieval/generation limitations with
full evidence citations; `LIMITATIONS.md` is a broader product-wide summary that explicitly
links to, rather than duplicates, the former.

**Follow-up:** *"Is this the clearest possible naming?"* Reasonably confusing on first
encounter, worth acknowledging honestly — the content itself isn't duplicated, but the names
alone don't make that obvious.

---

**Q12. You're asked to add a fourth material type (say, audio-only files). What would you need
to touch, roughly?**

**Short answer:** A new processor in `team4a/app/processors/`, a new `file_type` value accepted
by the canonical request model, and a new `type` option in Team4C's upload UI/schema — Team4B
would need no changes at all, since it only ever sees already-chunked, already-embedded text.

**Detailed explanation:** This tests whether you understand the service boundaries well enough
to reason about a hypothetical change — Team4B's complete indifference to source-material type
(it only ever retrieves generic chunks with type-appropriate metadata) is the key insight; the
type-specific logic lives entirely in Team4A's extraction stage and Team4C's upload/citation
UI.

**Follow-up:** *"Would the citation UI need new code too?"* Likely yes — `SourceAttribution.tsx`
currently distinguishes document vs. video citations by which optional fields are populated; a
genuinely new citation shape (not timestamp- or page-based) would need its own rendering branch.
