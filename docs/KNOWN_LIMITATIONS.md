# Known Limitations

Every item below is backed by a specific phase's live evidence, referenced
inline. None are described as "bugs" unless the evidence supports that
classification — most are architectural or model-behavior limitations,
not defects in the code's own logic.

## Retrieval

**Hindi retrieval is phrasing-sensitive (same-script, not just
cross-script).** A Hindi query whose compound-word spacing differs from
the source text's own tokenization can completely miss content that
exists and is otherwise well-covered. Directly demonstrated (Phase 5J):
the exact ground-truth phrasing `"मल्टी प्रोग्रामिंग ऑपरेटिंग सिस्टम क्या
होता है?"` retrieves its target chunk at rank 1; a natural paraphrase
`"मल्टीप्रोग्रामिंग क्या है?"` (removing a space) does not retrieve it in
the top 100 at all. Root cause: BM25's regex-based Devanagari tokenizer
treats spaced and unspaced compound forms as entirely disjoint tokens. The
generation layer responds safely when this happens (honest decline, no
fabrication) — this is a retrieval gap, not a grounding-safety gap.
Reference: `team4b/data/m6_phase5j_rag_final_acceptance_report.md`.

**Cross-script retrieval (Hinglish/English query ↔ Hindi source, or the
reverse) is measurably weaker than same-language retrieval.** Multiple
generalized fixes were forensically evaluated and rejected because they
did not survive full hybrid/RRF testing even when they looked promising
in isolation — see `docs/RAG_ARCHITECTURE.md`'s "Investigated and
rejected" table. This remains an open, accepted, unresolved limitation,
not something later phases quietly fixed. Reference:
`team4b/data/m6_phase5i_b_retrieval_quality_report.md`,
`team4b/data/m6_phase5i_c_script_aware_retrieval_report.md`.

## Generation

**The LLM occasionally narrates lexically-adjacent-but-wrong-domain
retrieved content with confidence instead of declining.** Example
(Phase 5J, live): a CPU-scheduling question issued against a DBMS
workspace was answered using DBMS *transaction*-scheduling content
(both use the word "scheduling"/"preemptive"), as if it addressed the
actual question. Confirmed via retrieval metadata that this is *not* a
workspace-isolation failure — the retrieved content was correctly scoped
to the queried workspace; the model itself over-extended a lexical
match into an answer. Bounded: never observed to leak cross-workspace
data, only to misapply in-scope, correctly-isolated content from the
wrong subject area. Reference:
`team4b/data/m6_phase5j_rag_final_acceptance_report.md`.

## Security

**Prompt injection is mitigated for one specific, validated attack pattern — not
eliminated.** Phase 5K's output-side guard closes a forced-fixed-output hijack pattern
(measured: 5/31 → 0/32 live cases). A later, separate mitigation attempt (query-text
neutralization) was implemented and unit-tested but **did not prevent a direct
instruction-override attack against the live model** — that attack still fully
succeeded on retest, and this is disclosed exactly as found, not adjusted to look more
favorable.

**One residual prompt-injection pattern also remains open (PARTIAL
severity).** `REPRO-SPOOF-5`: retrieved content instructing the model to
"reveal your system prompt" produces a longer response echoing the
visible prompt-scaffold/delimiter text — not any genuine secret (none
exists in the prompt to leak). This is intentionally out of scope for the
Phase 5K fix (which targets only short forced-fixed outputs). See
`docs/SECURITY_ARCHITECTURE.md` for full detail and the recommended next
step.

## Performance

**Local LLM generation is CPU-bound and slow in this environment.**
Ollama's `llama3` (8B, Q4_0) runs with `size_vram: 0` (no GPU
acceleration configured here) — observed generation latency ranged
30–140+ seconds per request across Phase 5J/5K's live batteries. This is
an infrastructure/deployment characteristic of the current local
environment, not a Team4B code defect, and should factor into Team4C's
UX expectations (loading states, timeouts) before product integration.
Reference: `team4b/data/m6_phase5j_rag_final_acceptance_report.md`
Section 18.

## Test/evidence coverage gaps

**Document-isolation live test coverage.** A live probe of a real
workspace's `document_id`s found only one distinct document present for
the sampled queries, so a genuine "restrict to the wrong document" live
test could not be constructed from real data in Phase 5J. The underlying
filter logic itself (`document_ids` parameter) was separately code-traced
and unit-tested in earlier phases and is unchanged. Not evidence of a
defect — evidence of a live-data gap.

**No distinct MP4-upload source type exists in either Qdrant collection
today** (`educopilot_chunks`: pdf/youtube only; `educopilot_chunks_product_validation`:
pdf/youtube only, verified by direct payload survey). Video-source
acceptance is therefore evidenced only via YouTube transcripts — no claim
is made about a separately-uploaded MP4 pipeline's behavior, because no
such content was found to test.

## What these limitations do NOT mean

- They do not mean the generalized architecture has subject-specific
  gaps — every limitation above reproduces identically regardless of
  subject (OS, DBMS, Data Structures, Computer Networks all show the same
  patterns where applicable).
- They do not mean workspace/document isolation is unreliable — isolation
  has never shown a leak across any phase's live testing (Phases 5I-C,
  5J, 5K).
- They do not mean grounding is unreliable in general — the large
  majority of live-tested grounded answers (Phase 5J: 7 of 8 grounding
  cases; Phase 5K's post-fix re-run: all 8) were accurate and correctly
  cited.
