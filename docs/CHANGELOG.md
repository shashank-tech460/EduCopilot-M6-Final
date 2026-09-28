# Changelog

High-level milestones, not a copy of every individual development-session
report (those have been consolidated into the canonical documentation set
— see [DEVELOPER_HANDOFF.md](DEVELOPER_HANDOFF.md)'s note on document
history if you're looking for phase-by-phase detail that no longer exists
as separate files).

## Architecture

- Established the three-service split (Team4A ingestion, Team4B RAG,
  Team4C product) with a service-JWT-authenticated integration boundary
  between them.
- Introduced the ingestion-generation/authority mechanism so a document
  can be safely re-ingested without a stale, superseded attempt ever
  overwriting a newer one's results.

## Ingestion (Team4A)

- Built the PDF and YouTube ingestion pipelines (extraction → chunking →
  embedding → Qdrant publishing), with a Hindi-transcript fallback for
  YouTube videos whose default-language transcript is unavailable.
- Added the canonical `/v1/ingest` path, the Redis-coordinated per-document
  lock, and the narrow, explicitly-scoped MongoDB authority write
  (`File.currentIngestionGeneration`).

## Retrieval and generation (Team4B)

- Built hybrid retrieval: semantic search (Qdrant) + BM25 (workspace-scoped,
  rebuilt per query), merged via Reciprocal Rank Fusion.
- Validated the pipeline through a multi-phase forensic testing arc
  covering grounding correctness, citation integrity, conversation
  faithfulness, workspace/document isolation, multilingual behavior, and
  performance — see [RAG_VALIDATION.md](RAG_VALIDATION.md).
- Investigated and rejected several retrieval-quality alternatives
  (a multilingual embedding model, script-aware BM25 augmentation,
  enabling the reranker, threshold/top_k changes, query expansion) after
  real evaluation showed none improved production results — see
  [RAG_ARCHITECTURE.md](RAG_ARCHITECTURE.md).
- Reached **RAG-accepted / frozen** status: no further retrieval-tuning
  changes without new specific evidence.

## Security

- Built the prompt-level trust boundary (untrusted-context delimiters +
  syntactic neutralization) against prompt injection.
- Identified, via a real adversarial testing battery, a forced-fixed-output
  attack pattern achieving 5/31 full hijacks; designed and validated a
  deterministic output-side guard that reduced this to 0/32 with zero
  false-positive regressions.
- Documented one remaining lower-severity residual
  (`REPRO-SPOOF-5`) rather than claiming complete elimination — see
  [SECURITY_ARCHITECTURE.md](SECURITY_ARCHITECTURE.md).

## Integration and product completion (Team4C)

- Built real authentication, workspace/material CRUD with account-level
  isolation, and wired Team4C to the real, running Team4A/Team4B services
  (not mocks) for live ingestion and query.
- Fixed a real cross-service configuration gap (Team4A's Mongo
  authority write silently going to the wrong database by default) that
  had been causing ingestion to appear to hang with no visible error.
- Built the streaming AI Tutor chat UI, with Markdown rendering, citation
  chips independently re-verified against workspace ownership, and
  source-scope selection (whole workspace vs. one material).

## UI/UX and accessibility

- Built a dark-first premium visual system (design tokens, glass
  surfaces, restrained motion respecting `prefers-reduced-motion`).
- Ran automated WCAG 2A/2AA checks across every major page and fixed two
  **real, found-not-assumed** issues this surfaced: a genuine color-contrast
  failure on a button, and — more significantly — a CSS `mask-image`
  applied directly to a content-bearing container (the landing hero
  section and the auth pages' marketing panel both used it) that was
  fading real heading/paragraph/citation text toward transparent based on
  vertical position, not merely a decorative background layer as
  intended. Root-caused via direct DOM/CSS inspection (not assumed to be
  a screenshot-tool artifact) and fixed by moving the effect onto a
  dedicated, non-content-bearing pseudo-element.
- Verified responsive behavior with real screenshots and DOM geometry
  checks at 375/390/768/1024/1280/1440px on the landing, login, and
  signup pages.

## Testing

- Built out Team4C's test suite from near-zero to 469 Vitest tests and a
  13-test Playwright E2E suite across 7 spec files, including specs that
  exercise the real Team4A→Team4B→Team4C path end-to-end (not mocked).
- Added automated accessibility testing (`@axe-core/playwright`) across
  5 major pages.

## Documentation

- Consolidated a large set of temporary, phase-specific development
  reports into a canonical, maintained documentation set:
  `README.md` + `docs/PROJECT_OVERVIEW.md`, `ARCHITECTURE.md`,
  `TEAM4A.md`, `TEAM4B.md`, `TEAM4C.md`, `INTEGRATION.md`, `SETUP.md`,
  `ENVIRONMENT.md`, `TESTING.md`, `TROUBLESHOOTING.md`, `PROJECT_QA.md`,
  `DEVELOPER_HANDOFF.md`, `SECURITY.md`, `LIMITATIONS.md`, `ROADMAP.md`,
  `CHANGELOG.md` (this file) — so the repository is understandable
  without any prior development session's context.
- Preserved genuinely valuable historical/decision records
  (`RAG_ARCHITECTURE.md`, `SECURITY_ARCHITECTURE.md`,
  `KNOWN_LIMITATIONS.md`, `RAG_VALIDATION.md`, and others) rather than
  discarding project history — marked clearly superseded where
  applicable instead of deleted, where the historical record itself had
  ongoing value.

## 2026-09-28 — Reliability/security hardening and documentation cleanup

Uncommitted as of this entry — see [M6_STATUS.md](M6_STATUS.md) for the
committed-vs-uncommitted distinction.

- **Team4A:** fixed duplicate ingestion on the legacy routes (content-hash
  idempotency) and added stuck-job recovery for a job left in
  `PROCESSING` past a stale threshold. 913 passed, 5 skipped.
- **Team4B:** re-verified a previously-suspected retrieval root cause
  (RRF normalization) against the current corpus and code rather than
  trusting an earlier conclusion — did not reproduce; confirmed the real
  prior fixes (`is_elliptical_query()`, BM25 corpus refresh) already hold.
  Attempted a further prompt-injection mitigation (query-text
  neutralization) — implemented and unit-tested, but a live retest showed
  it does **not** stop a direct override attack; disclosed as such, not
  claimed as a fix. 1438 passed, 3 skipped, 1 known pre-existing failure.
- **Team4C:** fixed a dev-mode-only stuck-stream bug (Next.js Fast Refresh
  orphaning an in-flight `useChat()` instance) with a client-side
  watchdog, and a mobile sidebar layout default. 669 Vitest tests passed
  (62 files), `tsc --noEmit` clean.
- **Architecture diagrams:** produced two finalized architecture diagrams
  (Complete System Architecture, Detailed Technical Architecture), each in
  documentation and 16:9 presentation quality, PNG + editable SVG — see
  [docs/architecture/](architecture/).
- **Repository cleanup:** archived two historical cleanup-audit reports to
  `docs/history/`; deleted four confirmed-obsolete, never-version-controlled
  local backup directories; removed one accidental stray file; corrected
  several stale cross-references between documents. Full detail:
  [docs/DOCUMENTATION_CLEANUP_2026-09-28.md](DOCUMENTATION_CLEANUP_2026-09-28.md).
