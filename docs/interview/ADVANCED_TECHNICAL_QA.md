# Advanced Technical Q&A

Harder follow-up questions — the kind that probe whether you understand a design decision's
actual boundary conditions, not just its headline description. Assumes you've read the
[learning/](../learning/) deep-dives first; each answer here goes one level past what those
already cover.

---

**Q1. The generation-authority filter is described as "fail-closed." Construct a scenario
where fail-closed behavior is actually *worse* for the user than fail-open would be.**

**Answer:** If MongoDB has a brief network blip during a query, every candidate whose
document_id can't be confirmed gets dropped — potentially all of them, if the outage is total —
so the student gets "insufficient context" instead of a real, correct answer that a fail-open
design would still have produced (since the content genuinely was current, MongoDB was just
briefly unreachable). This is a real, accepted trade-off: the system chooses to risk a false
"I don't know" over the risk of ever showing stale or deleted content as if it were current.
It's a deliberate asymmetry in what kind of wrongness is considered acceptable, not a claim
that fail-closed is strictly better in every dimension.

**Where this shows up in the code:** `GenerationAuthorityClient` raises
`GenerationAuthorityUnavailableError` only on a *total* connection failure, but a per-document
miss is silently excluded — meaning even a partial Mongo degradation (some documents' lookups
succeed, others time out) could inconsistently exclude a subset of otherwise-valid content
within the same query.

---

**Q2. The BM25 index is rebuilt fresh per query per workspace, explicitly for tenancy
isolation. What's the actual performance cost of this design, and why was it accepted anyway?**

**Answer:** Rebuilding a BM25 index from scratch on every single query is real, avoidable-in-
principle computational work that a single global persistent index wouldn't incur. It was
accepted because the alternative — a shared global index — would let cross-workspace documents
influence IDF (term-rarity) statistics even if results were filtered afterward, which is a
correctness/isolation violation, not just a performance question. The design prioritizes
provable tenant isolation over raw retrieval latency, on the reasoning that a workspace's chunk
count is generally small enough (a handful of documents' worth) that the rebuild cost stays
acceptable in practice.

**A fair follow-up to ask yourself:** at what corpus size per workspace would this become a
real bottleneck, and is there a caching strategy (e.g., a per-workspace cached index,
invalidated on ingestion) that would preserve isolation without the full-rebuild cost? This
isn't answered in the current codebase — a legitimate open design question.

---

**Q3. Citations are built only from retrieval metadata, "never from the model's free text."
Does this fully prevent a misleading answer, or only a fabricated citation?**

**Answer:** Only the latter. A documented, real example exists of the model correctly citing a
real, in-scope chunk while still *misapplying* it — answering a CPU-scheduling question using
retrieved DBMS transaction-scheduling content, because both use the word "scheduling." The
citation itself was completely accurate (the right chunk, the right page); the model's
*use* of that chunk to answer a different question than the one actually asked was the real
failure. Citation-fabrication and answer-misapplication are two structurally different failure
modes, and this architecture only rules out the first one by construction — the second remains
a real, disclosed, LLM-reasoning-level limitation.

**Why this distinction matters for a viva answer:** it shows you understand grounding is not a
single property — a system can be perfectly grounded (every cited chunk is real and in-scope)
while still producing a subtly wrong answer.

---

**Q4. The stuck-stream watchdog recreates the `useChat()` instance after 240 seconds. What
happens to the *original*, now-abandoned request on Team4B's side?**

**Answer:** Nothing changes on Team4B's side at all — it has no idea the client stopped
listening, and completes (or fails) the request exactly as it would have otherwise. The
watchdog is purely a client-side recovery mechanism; it doesn't cancel the in-flight server-side
work. In the actual bug this fixes (a dev-mode Fast Refresh orphaning the listener), the
backend genuinely does finish and produce a real answer — the fix's entire value is letting the
*student* recover and try again, not stopping wasted backend work. A more complete fix would
also cancel the abandoned request server-side (e.g., via an `AbortController` propagated
through the fetch), which isn't described as implemented here.

**Follow-up worth having an answer ready for:** *"So could this watchdog theoretically fire
while a real answer is still silently being generated, then a retry sends a second, redundant
request?"* Yes, in principle — the fix addresses the *symptom* (a stuck UI) precisely, not
every possible resource-efficiency consequence of an abandoned stream.

---

**Q5. RRF with `k=60` and cosine-normalized vector scores are combined into one fused ranking.
Is it mathematically meaningful to say a fused score of 0.6 is "twice as relevant" as 0.3?**

**Answer:** No, and this is worth being precise about. RRF's fused score is a function of rank
*position* across lists, not a calibrated relevance probability — a 0.6 vs. 0.3 fused score
tells you the first result was ranked more favorably across the two retrieval legs, but not by
a proportionally meaningful "twice as good" amount in any absolute sense. The normalization
(dividing by the theoretical maximum) makes the *range* comparable across queries (always
0 to 1), not the *magnitude* semantically interpretable as a probability or confidence level.
This matters if the number is ever surfaced to a student or used as a threshold for a different
purpose than ranking — treating it as a calibrated confidence score would be a real
misunderstanding of what RRF actually computes.

---

**Q6. The service JWT has a 300-second TTL and no revocation mechanism. Construct the actual
worst-case exposure window for a leaked token, precisely.**

**Answer:** Up to 300 seconds *from the moment that specific token was minted*, not from the
moment it leaked — since `exp` is a fixed timestamp set at minting, a token that leaks
immediately after being minted has nearly the full 300 seconds of validity remaining; a token
that leaks 290 seconds after minting has almost none left. There is no way to invalidate a
token early once issued — the system's only defense against a leaked token is that window
being short, not any active revocation capability. This is an accepted, documented trade-off for
a local-development system, explicitly not claimed as production-hardened.

**A sharper follow-up:** *"Since Team4C mints a fresh token per call rather than reusing one,
does that reduce the actual exposure in practice?"* Yes, meaningfully — a leaked single request
(and its token) only grants that narrow window for that one call's scope/audience, not a
standing credential a caller could reuse indefinitely, since each subsequent call mints an
entirely new token anyway.

---

**Q7. The `_is_forced_fixed_output()` guard only checks answers of 6 tokens or fewer. Why not
simply raise that limit to catch longer hijacked answers too?**

**Answer:** Because the guard's actual detection mechanism — checking whether the *entire*
answer appears as a verbatim contiguous quote inside a single retrieved chunk — becomes
increasingly unreliable as a discriminator at longer lengths. A short, exact quote match is
strong evidence of a hijack (legitimate answers are rarely word-for-word identical to a chunk of
source text); a longer coincidental match becomes statistically more plausible for a genuinely
correct, well-grounded answer that simply quotes its source closely, which is normal and
desirable behavior, not an attack. Raising the threshold naively would risk false-positiving on
exactly the kind of accurate, closely-quoted answers the system is trying to produce. The real
fix for longer hijacked answers would need a fundamentally different detection signal, not just
a larger token-count parameter on the same mechanism.

---

**Q8. Team4A holds a distributed lock for up to 4 hours (`ingestion_lock_lease_seconds`). What
happens to a legitimate second upload attempt for the same document during that window, and is
that the right user experience?**

**Answer:** A second attempt for the same `document_id` within the lease window gets rejected
(`DocumentAlreadyLockedError` → typically surfaced as a 409) — even if the *first* attempt has
actually already crashed and is just sitting on an unexpired lease. This is a real, honest gap:
the lock's correctness guarantee (no two attempts race) comes at the cost of a legitimate retry
being blocked for up to 4 hours if the first attempt silently died without releasing it. Whether
this is "the right" UX is a judgment call the codebase doesn't fully resolve — it prioritizes
correctness (never two racing writers) over retry availability, accepting a bounded, long
worst-case wait as the cost.

**A good way to extend this answer:** note that this is a different mechanism from
stale-job-recovery, which operates on the *legacy* Celery pipeline's job-status field, not on
the canonical path's lock — the canonical path currently has no equivalent "detect and release
an abandoned lock early" mechanism described in the research gathered for this document; that
would be worth verifying directly in the code before asserting it doesn't exist at all.

---

**Q9. Two completely independent bugs in this project — the BM25-corpus-never-refreshed issue
and the elliptical-query false-positive issue — both silently degraded answer quality with
*no error thrown anywhere*. What does this suggest about the limits of test coverage alone for
a system like this?**

**Answer:** Both bugs are structurally the kind that unit tests are poorly suited to catch in
isolation — each individual function involved (`refresh_bm25_corpus()`, `is_elliptical_query()`)
worked exactly as designed and as tested; the actual defect was in *integration/wiring*
(a function existing but never being called) or in a *heuristic's real-world false-positive
rate* (only visible against realistic, varied questions, not a small hand-picked test set). This
is precisely why this project's validation approach explicitly includes live, scripted
acceptance batteries against real running services in addition to unit tests — some classes of
bugs genuinely only surface when the whole system runs together against realistic inputs, not
from testing components in isolation, however thoroughly.

**Where this is stated directly in the project's own documentation:**
[TESTING.md](../TESTING.md)'s "Integration/acceptance test approach" section explains exactly
this reasoning for why live batteries exist alongside pytest.

---

**Q10. If you had to pick the single most architecturally interesting decision in this entire
project to defend in a viva, which would you pick and why?**

**Answer (a model answer, not the only valid one):** The generation-authority fail-closed
filter, because it's the one mechanism that most directly encodes a value judgment about what
kind of wrongness is acceptable — the system would rather tell a student "I don't have enough
information" than ever risk answering from content that might be stale, superseded, or deleted.
That's a genuine trade-off between availability and a specific kind of correctness, made
explicit and deliberate rather than left as an accident of implementation, and it touches
almost every other part of the system: it's why retrieval reads MongoDB at all, why it's the
*only* place Team4B touches Mongo, and why "fail-closed" appears as a named, repeated principle
in the documentation rather than just an implementation detail.
