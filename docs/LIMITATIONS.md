# Limitations

Honest, three-way split. For Team4B's retrieval/generation limitations
specifically, with full evidence citations, see
[KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) — not duplicated here in
full detail, only summarized.

## Current limitations (real, present in the product today)

- **Hindi and cross-script retrieval is weaker than same-language
  retrieval**, and is phrasing-sensitive even within Hindi alone — a
  compound-word spacing difference between a query and the source text's
  own tokenization can cause a complete retrieval miss. Several fixes
  were evaluated and rejected on real evidence; this is an open,
  unresolved limitation, not something quietly fixed later. See
  [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md).
- **The LLM occasionally narrates lexically-adjacent-but-wrong-domain
  retrieved content with confidence instead of declining** — bounded
  (never observed to leak across workspaces, only to misapply in-scope
  content from the wrong subject area within the same, correctly-isolated
  workspace).
- **Prompt injection is mitigated for one specific attack pattern, not eliminated.** A
  later query-neutralization attempt did not prevent a direct instruction-override
  attack against the live model, and a separate, lower-severity prompt-scaffold
  disclosure case also remains open — see [SECURITY.md](SECURITY.md) and
  [SECURITY_ARCHITECTURE.md](SECURITY_ARCHITECTURE.md) for the exact, dated evidence.
- **Local Ollama dependency**: generation requires a local Ollama
  instance with the configured model (`llama3`) pulled and running — no
  cloud LLM fallback exists.
- **Hardware requirement / generation latency**: local LLM generation is
  CPU-bound in this project's own development environment (no GPU
  configured) — 30–140+ seconds per AI Tutor answer was measured during
  live testing. This is a real, present characteristic, not a rare edge
  case.
- **Ingestion time scales with material length** — a long lecture
  transcript or large PDF takes proportionally longer to become "Ready";
  no explicit time-estimate UI exists.
- **Supported formats**: PDF and YouTube (transcript-based) are the two
  real, tested content paths. MP4 direct upload exists in the pipeline's
  design but has no real-world tested content in either Qdrant
  collection as of the last audit.
- **External YouTube dependency**: YouTube ingestion depends on
  `youtube-transcript-api`/`yt-dlp` and the video actually having a
  fetchable transcript track — a video with no transcript available
  (in the requested or fallback language) cannot be ingested via that
  path.
- **Local, single-machine infrastructure**: this project runs against
  local Docker containers and native services on one development
  machine. No cloud deployment, load testing, or multi-machine setup has
  been performed or is claimed anywhere in this project.
- **Rate limiting is partial, not system-wide**: only Team4B's `/api/v1/query`,
  `/query/stream`, and `/evaluate` are rate-limited (30 req/60s per caller identity,
  Redis-backed, fails open on a Redis outage). Team4A has none at all; Team4C has none;
  Team4B's own session/history/health/metrics routes have none. See
  [SECURITY.md](SECURITY.md) for the exact mechanism.
- **No monitoring/observability** stack — structured logs exist per
  service, but nothing aggregates or alerts on them.

## Known test/development limitations

- **A narrow, intermittent E2E test race**: `auth-workspace.spec.ts`'s
  logout→redirect assertion has been observed to fail under
  near-zero-latency automated timing (the client-side session cookie can
  occasionally not yet be cleared when the very next request fires,
  faster than any real human interaction). Manually root-caused and
  confirmed **not** reproducible under any realistic delay, including
  this project's own manual browser testing — the underlying security
  property (a logged-out user cannot access a protected route) is
  independently verified correct. Not fixed in this pass — see
  [DEVELOPER_HANDOFF.md](DEVELOPER_HANDOFF.md) for why, and what a real
  fix would involve.
- **One pre-existing, explained pytest failure in Team4B's suite**
  (`test_every_relevant_chunk_id_exists_in_the_canonical_collection`) —
  a stale-ground-truth-data issue (the canonical corpus was legitimately
  rebuilt after the ground truth file was authored), not a code defect.
  Documented, not silenced. See [TESTING.md](TESTING.md).
- **This browser-automation tooling's own screenshot capture** has, in
  earlier development sessions, shown a rendering artifact unrelated to
  the actual product (verified via direct DOM/computed-style inspection
  at the time). This is now moot for the specific symptom it was
  confused with — see [CHANGELOG.md](CHANGELOG.md) for the real CSS bug
  that was actually causing user-visible text fading, found and fixed in
  this pass.

## Future improvements (not limitations — explicitly deferred, see ROADMAP.md)

Anything that would require new functionality rather than fixing a
present gap belongs in [ROADMAP.md](ROADMAP.md), not here — e.g., cloud
deployment, a hosted-LLM option, additional file formats, horizontal
scaling. This document is about what the system *as built* cannot
currently do; the roadmap is about what could be built next.
