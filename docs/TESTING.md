# Testing & Validation

## Team4B unit/integration test suite

```bash
cd team4b
python -m pytest -q
```

**Expected baseline:** `1438 passed, 3 skipped, 1 known pre-existing
failure` (re-run and reconfirmed 2026-09-28; the pass count has grown
from earlier phases' `1302` baseline as new regression tests were added
alongside real fixes — a rate-limiting test suite, a streaming-response
test suite, and a lifespan/BM25-corpus-refresh test suite among them —
not because the suite shrank or a check was removed). The one known
failure's identity and root cause below are unchanged.

If this changes:
- **A new failure** → investigate before doing anything else; do not
  weaken or delete the failing test to get a green suite.
- **The known failure disappears** → investigate why (it may mean the
  underlying stale-ground-truth data was fixed, which would be good news,
  but must be confirmed, not assumed).
- **Fewer tests collected** → likely an accidental deletion or import
  break; treat as a stop condition.

### The known pre-existing failure, explained

```
tests/test_phase3_generalized_ground_truth.py::TestRelevantChunkIdsExistInCanonicalCorpus
    ::test_every_relevant_chunk_id_exists_in_the_canonical_collection
```

This test asserts that every `relevant_chunk_id` in the Phase 3 ground
truth file still exists in the canonical Qdrant collection. It fails
because the canonical corpus was legitimately rebuilt after that ground
truth file was authored (confirmed in Phase 5H/5I-A: the corpus content
itself changed — a real MFT/MVT-vs-Hindi-transcript mismatch example was
found — not merely chunk-ID drift). The fix is to regenerate the ground
truth against the current corpus, not to change the test's assertion.
Phase 5I-A's `phase5i_a_current_corpus_ground_truth_candidate.json` is a
step toward that (19 entries, live-verified, but still explicitly marked
`CANDIDATE`, not human-approved) — it has not replaced the Phase 3 file
this test checks against, so the test correctly still fails until that
replacement is made deliberately, not accidentally.

**Do not delete or weaken this test.** Its failure is accurate, explained,
and tracked — silencing it would hide a real data-provenance fact.

## Integration/acceptance test approach (not pytest — live, scripted)

The RAG validation arc (Phases 5D–5K) used **live, end-to-end scripted
batteries** — real `HybridRetriever` + real `LLMGenerator` + real Ollama
calls, real Qdrant collections — rather than only unit tests, because the
properties being validated (grounding correctness, honest refusal,
prompt-injection resistance) are about actual model behavior, not just
code correctness. These scripts lived outside the repository (in a
session-local scratchpad) and are not part of the committed codebase;
their **results** are committed as the `team4b/data/m6_phase5*_report.{md,json}`
evidence files.

### RAG acceptance methodology (Phase 5J)

17 test categories (grounding, irrelevant-context, out-of-scope,
fresh-session, follow-up, prompt-injection, workspace isolation, document
isolation, citation integrity, source-type coverage, language coverage,
subject coverage, security boundary, error handling, performance) were
each exercised with real queries against real workspaces, in English,
Hindi, and Hinglish, across PDF and YouTube sources and multiple subjects.
67 live generation calls total. Full detail and every individual result:
`team4b/data/m6_phase5j_rag_final_acceptance_report.md`.

### Security acceptance methodology (Phases 5F, 5J, 5K)

A fixed 17-category adversarial threat corpus + 7 legitimate controls
(Phase 5F) has been re-run live, unmodified, at multiple later
checkpoints (5J, 5K) to confirm defenses hold on the *current* code, not
just at the time they were written. Phase 5K additionally forensically
tested two candidate fix designs (an ingestion-side detector and two
generations of an output-side detector) against real captured evidence
before implementing anything, then re-ran the full 31-case battery +
5-case supplement + the full 31-case main acceptance battery post-fix.
Full detail: `team4b/data/m6_phase5k_prompt_injection_architecture_report.md`.

## Team4A test suite

Not modified by the Phase 5D–5L RAG arc or by the Team4C product-integration
work described below. It was extended by a reliability-hardening pass
(dedup + stale-job recovery, uncommitted as of 2026-09-28).

```bash
cd team4a && python -m pytest -q
```

**Expected baseline:** `913 passed, 5 skipped` (re-run and reconfirmed
2026-09-28).

## Team4C test suite

Unlike Team4A, Team4C's frontend/product layer **was** extensively built,
tested, and validated in a later phase of this project (after the Phase
5D–5L RAG arc concluded and Team4B was frozen) — full auth, workspace,
material, and AI Tutor product flows, a premium UI/UX pass, and a
dedicated final visual-acceptance pass. This is real, current, and
re-verified — not aspirational.

```bash
cd team4c
npx tsc --noEmit          # TypeScript
npx eslint .               # lint
npx vitest run             # unit + component tests
npx playwright test        # end-to-end
npm run build               # production build
```

**Current real baseline:**

| Check | Result | Last verified |
|---|---|---|
| `tsc --noEmit` | 0 errors | 2026-09-28 |
| `eslint .` | 9 pre-existing errors / 3 pre-existing warnings, all in test files unrelated to any product change — see below; 0 new introduced by any change described in this document | earlier in the same development pass; not re-run 2026-09-28 |
| `vitest run` | 669 tests passed (62 files) — grown from an earlier `469`/`51` baseline as new component/hook tests (conversation sidebar, stuck-stream watchdog, conversation messages, ingestion, session restoration, and others) were added alongside real fixes | 2026-09-28 |
| `playwright test` (auth-workspace, smoke, accessibility, workspace-isolation, source-isolation, core-rag, youtube-rag) | 13/13 passed | earlier in the same development pass; not re-run 2026-09-28 |
| accessibility (`@axe-core/playwright`) | 5/5 pages pass WCAG 2A/2AA (landing, login, signup, dashboard, workspace) | earlier in the same development pass; not re-run 2026-09-28 |
| `npm run build` | clean, all routes compile | earlier in the same development pass; not re-run 2026-09-28 |

Nothing affecting ESLint, Playwright, accessibility, or the build has
changed between that earlier verification and 2026-09-28 — the changes in
between were `tsc`/`vitest`-covered fixes (see
[M6_STATUS.md](M6_STATUS.md)) and documentation/diagram work only. Re-run
the full command list above yourself before relying on this if in doubt.

**Distinguishing pre-existing ESLint issues from new ones**: the 9
pre-existing errors are all `@typescript-eslint/no-explicit-any` in two
older test files (`tests/unit/m5-conversations-route.test.ts`,
`tests/unit/m5-ragSession.test.ts`) that predate the product-integration
work and were never touched by it — confirmed via `git status` on those
exact files showing no changes. Any new ESLint run should show the same
9/3 baseline; a different count is a real regression to investigate.

### What Team4C's Playwright suite actually verifies

Not mocked — real signup/login/logout against a real MongoDB, real
workspace CRUD and cross-account isolation, a real PDF upload through
real ingestion to a real "ready" status, a real question sent to the real
running Team4B service producing a real grounded answer with a real
citation, and cross-source (PDF vs. YouTube) / cross-workspace citation
isolation. This is the closest thing this project has to a live product
acceptance test, run automatically rather than manually.

### What the production build checks

`next build` — full TypeScript compilation, all routes statically
analyzed and either pre-rendered or marked server-rendered correctly, no
build-time errors. A clean build is a standing requirement, checked before
any change is considered complete.

## Integration tests

There is no separate "integration test" suite distinct from the above —
Team4C's Playwright E2E suite *is* the integration test, since several of
its specs (`core-rag.spec.ts`, `source-isolation.spec.ts`) exercise the
real, running Team4A → Team4B → Team4C path end-to-end, not a mocked one.

## Reproducibility

Every RAG-validation phase report documents its own exact git commit,
Qdrant point counts (before/after), and configuration, so results can be
correlated to a specific, known code/data state. Qdrant collection point
counts have been verified unchanged at the start and end of every phase
in the arc:

- `educopilot_chunks` (canonical, frozen): **542** — this collection is
  intentionally frozen and this count should never change; if a fresh
  `curl http://localhost:6333/collections/educopilot_chunks` ever shows a
  different number, treat it as a real incident, not routine drift.
- `educopilot_chunks_product_validation`: **4938** at the point-in-time
  this figure was recorded (end of the Phase 5 RAG validation arc). Unlike
  the canonical collection, this one is a disposable, intentionally
  non-frozen collection used for live product-level testing in later
  phases and grows through ordinary use — do not treat this specific
  number as an expected current value; check `curl
  http://localhost:6333/collections/educopilot_chunks_product_validation`
  for the real current count if it matters for what you're doing.
