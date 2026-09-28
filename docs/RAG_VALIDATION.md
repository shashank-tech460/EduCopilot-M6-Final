# RAG Validation Journey

This is a concise, phase-by-phase summary of how Team4B's RAG system was
built, tested, and hardened. It exists so a future engineer can
understand *why* the current architecture looks the way it does without
reading every underlying report. Each entry links to its full report in
`team4b/data/` for detail and raw evidence — nothing here should be taken
as more authoritative than those reports; this is a summary, not a
replacement.

Phases 1–4E/F1 predate this document and are summarized briefly from
their artifact files. Phases 5A onward (including the full 5D–5K arc) are
summarized with first-hand-verified detail.

## Phase 1 — BM25 multilingual lexical support
**Objective:** make BM25 tokenize Devanagari (Hindi) text at all — the
original tokenizer was ASCII-only, so Hindi content tokenized to nothing
and could never be lexically matched.
**Decision:** implemented. `bm25_index.py`'s `default_tokenizer` now
matches ASCII alnum runs and Devanagari runs as separate alternatives.
Still in production, unchanged since.

## Phase 2 — Multilingual embedding evaluation (initial)
**Objective:** evaluate `all-MiniLM-L6-v2` (current) against
multilingual embedding candidates.
**Artifacts:** `phase2_evaluation_report.json`,
`phase2_ground_truth_candidate.json` (+ review), `phase2_ground_truth_approved.json`.
**Decision:** no migration made at this stage; groundwork for later,
more rigorous evaluation (see Phase 5I-B, which reopened this question
with full hybrid-pipeline simulation).

## Phase 3 — Generalized ground truth
**Objective:** build a broader, multi-subject ground-truth set beyond
Phase 2's initial scope.
**Artifact:** `phase3_generalized_ground_truth_candidate.json` (+ review).
**Note:** this is the ground-truth file `test_phase3_generalized_ground_truth.py`
checks against — see `docs/TESTING.md` for why one of its assertions now
fails against the current (rebuilt) corpus, and why that's a data-provenance
fact, not a code defect.

## Phase 4A–4E/F1 — Embedding, reranking, cross-lingual, and workspace-safety evaluation
| Phase | Objective | Artifact |
|---|---|---|
| 4A | Generalized embedding model evaluation | `phase4a_generalized_embedding_evaluation_report.json` |
| 4B | Reranker benchmarking | `phase4b_reranking_benchmark_report.json` |
| 4C | Candidate-recall diagnosis | `phase4c_candidate_recall_diagnosis.json` (+ raw supporting data, review) |
| 4D | Cross-lingual embedding evaluation | `phase4d_cross_lingual_embedding_evaluation.json` (+ raw supporting data, review) |
| 4E / 4E-F1 | Workspace RAG safety | `phase4e_workspace_rag_safety_report.json` (+ review) |

**Decision (all of 4A–4E/F1):** no production embedding/reranker change
made at this stage. The reranker remains implemented but disabled
end-to-end through every later phase (5H, 5I-B) that re-examined it.

## Phase 5A — Cross-script retrieval evaluation + multi-query investigation
**Objective:** investigate cross-script (Latin↔Devanagari) retrieval and a
multi-query-expansion candidate (`multi_query_retrieval.py`,
`query_transform.py`).
**Decision:** the multi-query modules were built and unit-tested but
**deliberately not wired into production** — enforced today by a
structural regression test
(`tests/test_phase5a_cross_script_retrieval_evaluation.py`) that asserts
`dependencies.py`/`rag_service.py` never reference them.
**Artifacts:** `phase5a_cross_script_retrieval_evaluation_report.json`,
`phase5a_cross_script_retrieval_review.md`.

## Product-level validation (2026-09-18) and Phase 5B/5C
**Objective:** validate the real product (real accounts, real UI/API,
real PDFs/YouTube videos) end-to-end against an isolated validation Qdrant
collection, protecting the canonical corpus.
**Key finding (Phase 5B):** a suspected `score_threshold` mistuning was
**definitively rejected** as the cause of zero-candidate failures.
Root cause was a pre-retrieval defect: `is_elliptical_query()` fired on
grammatically self-contained queries containing common pronoun words
anywhere in the text (e.g. "a query **that** finds..."), which caused
`RAGService` to skip retrieval entirely on a fresh conversation's first
message and return a scripted clarifying question instead.
**Fix (Phase 5C):** removed the "no previous turn → skip retrieval"
branch in `rag_service.py`; `build_enriched_retrieval_query()` is now
called unconditionally (it already safely no-ops with no previous turn).
Two tests rewritten to match the corrected behavior.
**Artifacts:** `m6_product_level_rag_validation_report.md`,
`m6_phase5b_retrieval_reliability_diagnosis.md`,
`m6_phase5c_retrieval_fix_report.md`,
`m6_final_pro_generalized_rag_validation_report.md` (a 123-case
post-validation audit confirming the fix and re-reviewing every case
against source material, not just HTTP 200).

## Phase 5D — Conversation faithfulness
**Objective:** determine whether irrelevant retrieved context or
fresh-session ambiguity causes fabrication.
**Key finding:** generation-stage context-relevance narration (not
retrieval, not history persistence) was the root cause of a prior
fabrication pattern.
**Artifact:** `m6_phase5d_conversation_faithfulness_report.md`.

## Phase 5E — Generalized reliability forensic battery
**Objective:** broaden 5D's findings across subjects/languages.
**Artifact:** `m6_phase5e_generalized_reliability_forensic_report.md`.

## Phase 5F — Prompt-injection hardening
**Objective:** fix a confirmed prompt-injection vulnerability (retrieved
content could make the LLM discard the real question).
**Decision:** implemented untrusted-context delimiters + narrow syntactic
neutralization in `llm_generator.py`. An escalated variant (routing
system instructions through Ollama's native `system` field) was tested
and found to be a **net regression** — reverted.
**Artifacts:** `m6_phase5f_injection_forensic_report.md`,
`m6_phase5f_prompt_injection_hardening_report.md`.

## Phase 5G — Trust-boundary forensic follow-up
**Objective:** deepen 5F's evidence on which injection patterns resist
the new defense and which don't.
**Artifact:** `m6_phase5g_trust_boundary_forensic_report.md`.

## Phase 5H — Grounding reliability forensic battery
**Objective:** broader grounding-safety testing including reranker
re-evaluation.
**Artifact:** `m6_phase5h_grounding_reliability_forensic_report.md`.

## Phase 5I-A — Evaluation foundation + Hindi determinism
**Objective:** determine whether "Hindi retrieval nondeterminism" is real,
and build a trustworthy current-corpus ground truth.
**Key finding:** retrieval nondeterminism **does not exist** — 90/90
repeated runs stable. The original observation was a same-process,
different-query comparison error in an earlier phase's own script.
**Artifact:** 19-entry `phase5i_a_current_corpus_ground_truth_candidate.json`
(CANDIDATE, not human-approved) +
`m6_phase5i_a_evaluation_foundation_hindi_determinism_report.md`.

## Phase 5I-B — Retrieval quality + cross-language improvement
**Objective:** compute trustworthy current-corpus Recall/MRR and
evaluate a multilingual embedding migration.
**Key finding:** the candidate embedding model looked like a clean win in
isolated semantic-only testing but showed **no net improvement and a new
Hindi→Hindi regression** once properly simulated through the full
hybrid+RRF pipeline — directly the trap the phase was designed to catch.
**Decision:** no production change (Category C).
**Artifact:** `m6_phase5i_b_retrieval_quality_report.md`.

## Phase 5I-C — Script-aware BM25 experiment
**Objective:** evaluate a generalized Devanagari→Latin transliteration
augmentation to BM25 for cross-script matching.
**Key finding:** zero net hybrid-level improvement; BM25-only aggregate
got measurably *worse*; the one targeted miss got a worse RRF rank; ~3.8–4.9x
latency increase; new false-positive risk from common Hindi function
words.
**Decision:** rejected (Category C, trending D).
**Artifact:** `m6_phase5i_c_script_aware_retrieval_report.md`.

## Phase 5J — Final RAG acceptance
**Objective:** consolidate all prior evidence into one acceptance
decision via a live, 17-category, 67-call acceptance battery.
**Decision:** **C — targeted fix required**, blocked specifically on one
security gap (5/31 injection cases achieving full output hijacking via a
"forced fixed-output" pattern). Every other dimension (grounding,
citations, isolation, conversation handling, subject/language coverage)
was already at "ready with documented limitations."
**Artifact:** `m6_phase5j_rag_final_acceptance_report.md`.

## Phase 5K — Prompt-injection architecture decision + fix
**Objective:** forensically compare an ingestion-side vs. output-side
defense for the Phase 5J blocker, and implement only if evidence proved
one safe.
**Key finding:** an ingestion-side keyword detector was rejected (would
require Team4A changes; ~27% false positives on ordinary educational
imperative language even in its best-faith form). A first output-side
design was tested and found completely ineffective (0/9 true positives) —
a genuinely important dead end, since a successful attack's output is by
definition drawn from the evidence. A revised design (exact-substring
containment of a short answer within the evidence) scored 8/8 true
positives, 0/59 false positives on 68 real captured answers.
**Decision:** **A — implemented.** FULL-severity injection cases: 5/31 →
0/32. Zero false-positive regressions across the full post-fix
regression battery (pytest + 31-case injection battery + 5-case
supplement + 31-case main acceptance battery).
**Artifact:** `m6_phase5k_prompt_injection_architecture_report.md`.

## Phase 5L — Repository cleanup & documentation (this phase)
**Objective:** consolidate the accepted RAG work into a clean,
documented, auditable git checkpoint. No retrieval/embedding/security
logic changed.
**Artifact:** `docs/history/REPOSITORY_CLEANUP_REPORT.md`.

---

**Net result of the Phase 5D–5K arc:** Team4B's generalized RAG pipeline
is validated and frozen, with one closed security gap (Phase 5K) and a
small set of explicitly documented, evidence-backed limitations (see
`docs/KNOWN_LIMITATIONS.md`) — not silently hidden, not overclaimed as
solved.
