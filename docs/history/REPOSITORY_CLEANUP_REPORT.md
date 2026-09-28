# Repository Cleanup Report — Phase 5L

**Date:** 2026-09-21
**Scope:** repository-wide inventory, secrets audit, documentation, and a
single RAG-accepted checkpoint commit/tag/push. No retrieval, embedding,
BM25, RRF, reranker, threshold, top_k, or LLM logic was touched. No
Team4A behavior change. No Team4C implementation started.

## 1. Starting point

A previous, thorough cleanup audit already exists:
`docs/M6_REPOSITORY_CLEANUP_AUDIT.md` (2026-09-17). It inventoried 1,342
files, deleted 18 confirmed-unreferenced backup/one-off files (with
approval), and classified 4 non-canonical backup directories as
"exclude from Git, keep locally" rather than delete. This report
**builds on that audit rather than repeating it** — re-verifying its
conclusions still hold, and inventorying everything that changed since
(the entire Phase 5D–5K RAG validation arc).

## 2. Inventory results (this phase)

### A. KEEP — required source/config/test/documentation
All of `team4a/app`, `team4a/tests`, `team4b/app` (including
`multi_query_retrieval.py`/`query_transform.py` — see below),
`team4b/tests`, `team4c/app`/`components`/`hooks`/`lib`/`models`/`services`/`store`/`types`/`tests`,
all Docker/compose/requirements/package files, all `.env.example`
templates, `team4b/README.md`, `team4c/README.md`,
`team4b/docs/CONTRACT_DECISIONS.md`, `team4c/docs/*`, `infra/README.md`,
`scripts/*.ps1`. Unchanged from the 2026-09-17 audit's own findings —
re-verified, not re-litigated.

**`team4b/app/services/multi_query_retrieval.py` and `query_transform.py`**
(new since the last audit): confirmed **not** orphaned clutter — they are
Phase 5A's tested multi-query-expansion investigation, with their own
dedicated test (`tests/test_phase5a_cross_script_retrieval_evaluation.py`)
that structurally asserts (via `inspect.getsource()`) they are
deliberately unwired from `dependencies.py`/`rag_service.py`. Classified
KEEP — documented, evidence-backed, intentionally-inert experimental
code, exactly the kind of history this phase was told to preserve.

### B. KEEP — validation/evidence artifacts
Every `team4b/data/*.json`/`*.md` file (Phase 2 through Phase 5K reports,
including the two broader "final pro"/"product-level" validation reports
and all raw supporting `_phase4c_*`/`_phase4d_*` data), the new
`docs/m6-historical-vs-rebuilt-rag-comparison.md`,
`docs/m6-original-corpus-reconstruction-inventory.md`,
`docs/m6-os-1400-point-discrepancy-investigation.md`,
`docs/m6-product-validation-isolation-environment.md`,
`docs/m6-rebuilt-baseline-manifest.json`, and
`team4b/scripts/phase5a_cross_script_retrieval_evaluation.py` +
its test. **Nothing in this category was removed, moved, or edited** —
per this phase's explicit instruction not to delete generalized-RAG
evaluation evidence merely because it is old.

### C. ARCHIVE — none newly identified
No new "keep-but-declutter" candidates were found. The 2026-09-17 audit's
own ARCHIVE-equivalent decision (exclude the 4 non-canonical backup
directories from Git, keep them locally) remains the correct disposition
and was re-verified, not changed.

### D. DELETE — none found
A targeted search for new `.bak`/`.backup`/`.m6-*`/`.before-*`/`.log`
clutter, and for any loose root-level scratch files, found **nothing new**
since the 2026-09-17 cleanup. Root directory contains only `.gitignore`.
No files were deleted this phase — the repository was already clean; this
phase's own experimental/diagnostic scripts all ran outside the
repository (in a session-local scratchpad, never part of this git tree),
consistent with every phase's own stated discipline throughout the 5D–5K
arc.

### E. SECRET/SENSITIVE — audited, none committed
See Section 3 (Secrets Audit) below.

### F. REVIEW — resolved this phase
**`team4c-validation/`** (new since the last audit, not previously
classified): a full source copy of `team4c/`, used as an intentional,
documented, disposable parallel environment (ports 8011/8012/3010,
pointed at the isolated `educopilot_chunks_product_validation` Qdrant
collection) for product-level RAG validation — see
`docs/m6-product-validation-isolation-environment.md`. Its own nested
`.gitignore` is byte-identical to `team4c/.gitignore` (verified via
`diff`), so its `node_modules/`, `.next/`, `.env*`, `*.pem`, and
`.local-uploads/` were already protected even before this review.
**Resolution:** added `/team4c-validation/` to the root `.gitignore` as a
fifth non-canonical/disposable directory (same treatment as the 4
existing ones) — excluded from Git, kept locally, not deleted (it may
still be needed for further validation work against the same Qdrant
collection several RAG-validation phases already relied on).

## 3. Secrets audit

**No secret file's contents were read, printed, or copied at any point.**

| Check | Result |
|---|---|
| `.env`/`.env.*` files tracked or staged? | **No.** `git status --ignored` confirms every real `.env` file (`team4a/.env`, `team4a/.env.before-youtube-hindi-fallback`, `team4b/.env`, `team4c/.env`, `team4c-validation/.env`, plus copies inside the 2 gitignored `team4a-*` backup dirs) is marked `!!` (ignored) — none trackable. |
| `*.pem` key files tracked or staged? | **No.** `team4c/service-jwt-private-key.pem`, `team4c/service-jwt-public-key.pem`, and their `team4c-validation/` copies all confirmed ignored. |
| `.env.example` templates contain real-looking secrets? | **No.** Pattern search for API-key formats, embedded MongoDB credentials, and PEM key bodies found one match — a documentation comment in `team4b/.env.example` showing the *expected format* of a config value with an obviously truncated placeholder (`MFkw...`), not a real key. |
| Hardcoded credentials in application source? | **No.** Targeted search across `team4a/app` and `team4b/app` for common secret-assignment patterns found none. |
| Other credential-shaped filenames? | **No.** Only a legitimate UI component (`password-input.tsx`, a form input component, not a stored secret) matched. |
| `.gitignore` covers all of the above? | **Yes**, at both the root and the nested `team4c`/`team4c-validation` level (verified identical). |

**Secret audit result: PASS.** No potential secret was found in a
committable location; nothing required stopping this phase.

## 4. Documentation created

| File | Why it provides distinct value |
|---|---|
| `README.md` (root — did not exist before) | Single entry point: purpose, capabilities, architecture summary, team responsibilities, ports, setup pointers, testing, security, status, limitations, project structure |
| `docs/RAG_ARCHITECTURE.md` | The frozen RAG pipeline, current config, and — critically — *why* several investigated alternatives were rejected, with evidence pointers |
| `docs/RAG_VALIDATION.md` | Phase-by-phase (1 through 5L) objective/method/finding/decision summary, so a future engineer doesn't have to read 20+ individual reports to understand the arc |
| `docs/SECURITY_ARCHITECTURE.md` | What's fixed (Phase 5F + 5K), what's residual (`REPRO-SPOOF-5`), what was rejected (ingestion-side filtering) and why, secrets handling |
| `docs/KNOWN_LIMITATIONS.md` | Consolidated, evidence-cited limitations list — deliberately separated from "bugs" |
| `docs/M6_STATUS.md` | The single authoritative COMPLETED/IN PROGRESS/PENDING breakdown, explicitly correcting the older master handoff's now-stale status claims |
| `docs/TESTING.md` | pytest commands/baseline, the known-failure explanation, and the live-battery methodology used throughout the RAG arc |
| `docs/REPOSITORY_CLEANUP_REPORT.md` | This file |

**Deliberately NOT created** (would have duplicated existing content,
against this phase's own "no meaningless duplicate Markdown files"
instruction):

- `CONTRIBUTING.md`, root `SECURITY.md` — no external-contributor workflow
  exists yet to document; security content lives in
  `docs/SECURITY_ARCHITECTURE.md` instead of a shallow root duplicate.
- `docs/PROJECT_OVERVIEW.md`, `docs/ARCHITECTURE.md` — the new root
  `README.md` already covers this ground at the appropriate level; a
  separate file would only restate it.
- `docs/DATA_FLOW.md` — covered within `docs/RAG_ARCHITECTURE.md`'s
  pipeline diagram; no additional data-flow exists outside the RAG path
  worth a dedicated document.
- `docs/API_OVERVIEW.md` — already covered by `team4b/README.md` and
  `team4c/docs/api-contracts.md`.
- `docs/SETUP.md`, `docs/RUNBOOK.md` — already covered by the new root
  `README.md`'s setup section plus `team4b/README.md`'s detailed Docker
  deployment/troubleshooting sections and the existing `scripts/*.ps1`
  orchestration tooling.

**Existing documentation reconciled, not rewritten:** a short status
banner was added to the top of `docs/EDUCOPILOT_MASTER_HANDOFF.md`
(written 2026-09-17, before the Phase 5D–5K arc) pointing to the new
authoritative docs, since several of its "not started" claims (e.g. Phase
1 BM25 Devanagari support) were completed after it was written. Its body
was left unchanged — a full rewrite of a 900-line document was judged
higher-risk than a clear pointer to current-status documents.

## 5. `.gitignore` result

Added to the existing (already-good) root `.gitignore`: `.coverage`,
`htmlcov/`, `.local-uploads/` (defense-in-depth; already covered by
nested `team4c*/.gitignore`), `*.log` (present in the original audit's
own recommendation but missing from the file that was actually created —
re-added; verified zero tracked or committed `*.log` file exists anywhere
in the repository before adding this), `.vscode/`, `.idea/`, `.DS_Store`,
`Thumbs.db`, and `/team4c-validation/` (Section 2.F). Verified via
`git status --short` before/after that no source, test, documentation,
Docker, or evaluation-report file was newly hidden by any of these
additions.

## 6. Test result

```
1302 passed, 3 skipped, 1 known pre-existing failure
```

Identical to the historical baseline stated in this phase's own
instructions, re-verified twice this phase (once before documentation
changes, once after) — no regression. The known failure
(`test_phase3_generalized_ground_truth.py::TestRelevantChunkIdsExistInCanonicalCorpus::test_every_relevant_chunk_id_exists_in_the_canonical_collection`)
is explained, not silenced — see `docs/TESTING.md`. No test was modified,
weakened, or deleted this phase.

## 7. Qdrant invariant result

| Collection | Before | After |
|---|---|---|
| `educopilot_chunks` (canonical) | 542 | 542 |
| `educopilot_chunks_product_validation` | 4938 | 4938 |

No writes occurred. This phase performed zero Qdrant operations beyond
read-only point-count verification.

## 8. Final git review

- `git status --short`: reviewed in full (61 entries before the
  checkpoint commit) — every entry accounted for above.
- `git diff --stat`: 10 tracked files changed (379 insertions, 51
  deletions) — `.gitignore`, `docs/EDUCOPILOT_MASTER_HANDOFF.md` (banner
  only), `team4a/docker-compose.yml` (pre-existing, unrelated to this
  arc), `team4b/app/api/dependencies.py` + `main.py` (pre-existing Phase
  5C-2 BM25-startup-wiring fix), `team4b/app/services/llm_generator.py`
  (Phase 5K's approved security fix, on top of Phase 5F's original
  change), `team4b/app/services/rag_service.py` (pre-existing Phase 5C
  fix), `team4b/data/evaluation_results.jsonl` (append-only test-run log),
  `team4b/tests/test_api.py` + `test_rag_service.py` (pre-existing,
  matching test updates for the Phase 5C fix).
- `git diff --check`: clean (only routine Windows LF→CRLF autocrlf
  notices, zero whitespace-error or conflict-marker findings).
- Full diff of every pre-existing modified application file was read: all
  are legitimate, already-documented engineering work (the Phase 5C-2
  BM25-startup-lifecycle fix, explained in Section 2's cross-reference
  above) — none contain secrets, none are accidental, none weaken any
  test.
- **RAG code confirmed unchanged except the already-approved Phase 5K
  fix**: `llm_generator.py`'s diff against the base commit is the sum of
  Phase 5F's original delimiter/neutralization defense plus Phase 5K's
  additive `_output_tokens()`/`_is_forced_fixed_output()` guard — nothing
  else.
- Team4A: confirmed untouched by this phase (the one pre-existing
  `docker-compose.yml` modification predates the entire Phase 5 arc,
  dated 2026-09-17, unrelated to and unmodified by this phase).
- Team4C: confirmed untouched (no file under `team4c/` was created,
  edited, or deleted this phase; `team4c-validation/` was only added to
  `.gitignore`, never edited).

## 9. Checkpoint commit / tag / push

See the exact commit hash, tag, and push result at the end of this
report's companion session output. Per this phase's instructions: one
commit, message `docs: finalize M6 RAG accepted repository checkpoint`,
annotated tag `m6-rag-accepted`, pushed to the current branch
(`phase5-cross-script-retrieval`) plus the tag. **No merge to `main`. No
PR.**

## 10. Remaining warnings

- Windows line-ending (LF→CRLF) notices are routine `core.autocrlf`
  behavior on this platform, not an error — no action needed.
- `docs/EDUCOPILOT_MASTER_HANDOFF.md`'s body (beyond the new banner)
  still contains stale roadmap/status claims from before the Phase 5
  arc — flagged, not fixed, per this phase's own lower-risk approach
  (see Section 4). A future documentation pass could retire or rewrite
  it fully once the team confirms nothing still depends on its
  engineering-rules sections.
- `docs/M6_REPOSITORY_CLEANUP_AUDIT.md` (the 2026-09-17 audit) is itself
  now partially superseded by this report for anything that changed
  since — both are kept as a historical record of two real cleanup
  passes, not merged into one document.

## 11. Exact recommended next phase

Per every RAG-validation phase's own consistent stop condition and this
phase's explicit instruction not to begin it here: **Team4C product
integration** is the next phase of work — specifically, validating
Team4C's UI/UX and full end-to-end product flows against the now-frozen,
accepted Team4B RAG backend, per the PENDING items listed in
`docs/M6_STATUS.md`.
