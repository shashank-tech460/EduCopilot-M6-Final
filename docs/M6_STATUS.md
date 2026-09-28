# M6 Status

**Last updated:** 2026-09-28, following a reliability/security hardening
pass (dedup, stale-job recovery, a RAG retrieval re-verification, a
stuck-stream UI fix, a mobile layout fix, and a prompt-injection mitigation
attempt) and a documentation/architecture consolidation pass. **As of this
update, this hardening pass exists as uncommitted local changes on top of
the last published commit (`13ba7d3`) — it has not yet been committed or
pushed.** Every number below was freshly re-run against the current local
state on 2026-09-28, not carried forward from an older report.

This is the single authoritative status document for M6. If another
document conflicts with this one on current status, this document is
correct.

## COMPLETED

### Team4A (ingestion)
Stable throughout the core project. Not modified by the Phase 5 RAG
validation arc (5D–5L) or by the Team4C work described below. PDF and
YouTube ingestion, extraction, chunking, metadata, embedding, and
publishing to the canonical Qdrant collection are all in active, working
use.

**Reliability hardening (uncommitted, 2026-09-28):**
- **Duplicate-ingestion fix** — the legacy ingestion routes now use a
  content-hash (SHA-256) idempotency check so re-submitting the same file
  does not create duplicate jobs/chunks.
- **Stuck-job recovery** — a job left in `PROCESSING` past a configured
  threshold (`stale_processing_threshold_seconds`, default 4 hours) is
  now detected and marked `FAILED` (with an `ErrorDetail` explaining why)
  the next time it's read, serialized under a short-lease `IngestionLock`
  so a real in-progress job is never falsely recovered mid-race.
- 11 new regression tests (`tests/test_stale_job_recovery.py`) plus the
  existing dedup test file.
- **Full suite, re-run 2026-09-28: 913 passed, 5 skipped, 0 failed.**

### Team4B / RAG — validated and frozen
The generalized hybrid-retrieval + generation pipeline went through a
multi-phase forensic validation arc (Phases 5D–5K) covering grounding
correctness, citation integrity, conversation faithfulness, fresh-session
honesty, out-of-scope handling, workspace/document isolation, multilingual
behavior, source-type coverage, prompt-injection security, and
performance. See [RAG_VALIDATION.md](RAG_VALIDATION.md) for the
phase-by-phase summary.

**Security fix (Phase 5K):** a forced-fixed-output prompt-injection
pattern closed with a validated, generalized output-side guard. FULL-severity
injection cases: 5/31 → 0/32, zero false-positive regressions.

**Retrieval quality re-verification (uncommitted, 2026-09-28):** a fresh
investigation re-checked the previously-suspected RRF-normalization/
threshold hypothesis for a reported F1 retrieval issue against the
*current* corpus and code, rather than trusting an earlier session's
conclusion. The hypothesis did not reproduce; the real prior root causes
(`is_elliptical_query()`'s over-broad skip branch, and the BM25 corpus
never being refreshed at app startup) were confirmed already fixed in
current code. One genuinely new gap was found and closed: the app's
`lifespan` startup hook wasn't covered by a regression test asserting it
actually refreshes the BM25 corpus once at boot — now covered
(`tests/test_main.py`).

**Prompt-injection mitigation attempt (uncommitted, 2026-09-28):** the
user's own query text is now passed through the existing
`_neutralize_untrusted_text()` defense, and the system prompt explicitly
instructs the model not to comply with an override attempt arriving via
the question itself. This is a real, tested, non-regressing code change —
**and it did not solve the underlying vulnerability.** A live retest of a
direct "ignore your instructions" attack against the running local model,
after this change, still produced full compliance with the attack. This
is disclosed here exactly as it was found: implemented and unit-tested,
confirmed ineffective against the live model. See
[SECURITY_ARCHITECTURE.md](SECURITY_ARCHITECTURE.md).

**Current state: RAG-accepted / frozen**, with the two additions above
layered on top (a re-verification, not a retrieval-logic change; and a
disclosed-ineffective security attempt). No further retrieval, embedding,
BM25, RRF, reranker, threshold, or top_k changes are planned without new
specific evidence. **Full suite, re-run 2026-09-28: 1438 passed, 3
skipped, 1 known pre-existing failure** (unchanged root cause — see
[TESTING.md](TESTING.md)). See [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md)
for what "accepted" does *not* mean — several real, documented, bounded
limitations remain and are not hidden.

### Team4C — product integration: COMPLETE

Unlike the state recorded in earlier versions of this document, Team4C's
product integration is no longer "not yet started." After Team4B was
frozen, a substantial, dedicated phase of work built out and validated
the full product:

- Real authentication (Auth.js, credentials provider), workspace CRUD
  with account-level isolation, PDF and YouTube material upload with live
  ingestion status, and a real, streaming AI Tutor chat interface — all
  wired to the **real, running** Team4A and Team4B services (not mocks),
  verified via live end-to-end testing (real ingestion → real retrieval →
  real grounded, cited answers).
- Citations independently re-verified against workspace ownership before
  rendering (defense-in-depth beyond what Team4B already scopes).
- A premium visual/UX pass: dark-first design system, responsive layout
  verified at 375/390/768/1024/1280/1440px, restrained motion respecting
  `prefers-reduced-motion`, and a real WCAG contrast bug found and fixed
  via automated accessibility testing (not just claimed).
- A full automated test suite, a 13-test Playwright E2E suite across 7 spec files (including
  real signup/login, workspace isolation across accounts, and a genuine
  upload→ingest→ask→cited-answer flow against the live backend), and
  axe-core WCAG 2A/2AA checks on 5 major pages — all passing as of the
  last full run. Full detail: [TESTING.md](TESTING.md).

This is real, live-verified product-level acceptance — not merely "the
frontend exists and runs," which was the prior, more limited claim in
earlier versions of this document.

**Reliability and UX fixes (uncommitted, 2026-09-28):**
- **Stuck "Thinking..." fix (dev-mode root cause):** Next.js Fast Refresh
  was found to remount the chat component mid-stream, orphaning the
  in-flight `useChat()` instance. Fixed with a client-side watchdog: if a
  stream produces no terminal event within 240 seconds, the hook
  recreates its `useChat()` instance (by changing its `id`) and surfaces
  an inline "this response took too long" banner, rather than leaving the
  UI stuck indefinitely. This is a dev-mode-only failure class and does
  not exist in a production build. 3 new regression tests
  (`useChatStream-stuckWatchdog.test.tsx`).
- **Mobile sidebar default-collapse fix:** the conversation sidebar now
  starts collapsed on narrow viewports (<640px) on first mount, without
  breaking the existing contract that a manually-collapsed sidebar stays
  collapsed across reload (a one-directional fix — it only auto-collapses,
  never auto-expands, to avoid conflicting with the user's own persisted
  preference). 3 new regression tests.
- **Full Vitest suite, re-run 2026-09-28: 669 passed (669), 62 test files.
  `tsc --noEmit`: 0 errors.** ESLint, Playwright E2E (13/13), and the
  production build were last verified earlier in this same pass and have
  not been re-run since; no code affecting them has changed in between.

### Security hardening
Phase 5F (prompt-level trust boundary) and Phase 5K (output-side guard)
are both implemented, validated, and unchanged since their respective
acceptance. One lower-severity residual (`REPRO-SPOOF-5`, prompt-scaffold
disclosure, no real secret exists to leak) remains open and is explicitly
tracked, not hidden — see [SECURITY_ARCHITECTURE.md](SECURITY_ARCHITECTURE.md).

### Documentation
A full documentation consolidation pass replaced a large set of temporary,
phase-specific development reports with a canonical, maintained
documentation set (`README.md` + `docs/ARCHITECTURE.md`, `TEAM4A.md`,
`TEAM4B.md`, `TEAM4C.md`, `INTEGRATION.md`, `SETUP.md`, `ENVIRONMENT.md`,
`TESTING.md`, `TROUBLESHOOTING.md`, `PROJECT_QA.md`,
`DEVELOPER_HANDOFF.md`), so the repository is understandable without any
prior session's conversation history.

**Documentation and repository cleanup pass (uncommitted, 2026-09-28):**
finalized architecture diagrams now live at [docs/architecture/](architecture/)
(documentation-quality and 16:9 presentation versions of both diagrams,
PNG + editable SVG, plus a text reference doc); two historical
repository-cleanup audit reports were archived to
[docs/history/](history/); four confirmed-obsolete local backup
directories (never part of version control) were deleted; this document
and `README.md` were updated with freshly re-run test numbers. Full
detail: [docs/DOCUMENTATION_CLEANUP_2026-09-28.md](DOCUMENTATION_CLEANUP_2026-09-28.md).

## PENDING / NOT YET DONE

- **Committing and pushing the 2026-09-28 hardening/documentation pass** —
  everything described above under "uncommitted, 2026-09-28" exists only
  in the local working tree as of this status update. `origin/main` still
  reflects the earlier, published checkpoint. This is a decision for you
  to make explicitly, not something done automatically as part of any
  documentation pass.
- **Production-readiness beyond local development** — no cloud deployment,
  no production infrastructure hardening, no load/scale testing has been
  performed or is claimed anywhere in this project. All testing has run
  against local services on development machines.
- **Decision on the residual `REPRO-SPOOF-5` prompt-injection finding**,
  and on the newly-attempted-but-ineffective query-neutralization change
  above — accept both as documented residuals, or commission further work.
- **Decision on the ingestion-trust-model question** (whether the current
  injection risk profile is acceptable given who can actually get content
  indexed) — a product/deployment decision, not something Team4B alone
  can decide.
- **Hindi/cross-script retrieval improvement** — a real, open, unresolved
  limitation; several fixes were investigated and rejected on evidence
  (see [RAG_ARCHITECTURE.md](RAG_ARCHITECTURE.md)). No further attempt is
  currently planned without new evidence.
- **A distinct MP4-upload content pipeline's real-world validation** — no
  content with a distinct `mp4` source-type tag exists in either Qdrant
  collection as of the last audit; video-source evidence exists only via
  YouTube transcripts.
- **Cleanup of the disposable `team4c-validation/` environment** — a
  parallel, gitignored product instance created for an isolated
  product-validation exercise on 2026-09-18. Its own document
  ([m6-product-validation-isolation-environment.md](m6-product-validation-isolation-environment.md))
  records that cleanup was deliberately deferred pending your review; it
  was reviewed again during the 2026-09-28 cleanup pass and intentionally
  kept, at your instruction. A second Qdrant collection
  (`educopilot_chunks_product_validation`) and validation-only processes
  on ports 8011/8012/3010 may still exist from that same exercise — not
  checked or touched during this pass.

## Do not conclude from this repository

- That Hindi/cross-script retrieval is "fixed." It is not — see
  [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md).
- That prompt injection is eliminated. It is mitigated for one specific,
  validated pattern (Phase 5K); one residual remains open
  (`REPRO-SPOOF-5`); and a further, separate mitigation attempt (query-text
  neutralization, 2026-09-28) was implemented and tested but **confirmed
  ineffective** against a live direct-override attack — see
  [SECURITY_ARCHITECTURE.md](SECURITY_ARCHITECTURE.md).
- That this has been deployed anywhere beyond local development.
- That "669 tests passing" or "13/13 E2E tests passing" means every
  conceivable edge case has been covered — it means the specific,
  real flows those tests exercise are verified working, which is a real
  but bounded claim.
- That this document's "uncommitted, 2026-09-28" work is part of the
  published GitHub repository. It is not, as of this status update — see
  "PENDING / NOT YET DONE" above.
