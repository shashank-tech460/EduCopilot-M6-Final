/**
 * Team B / "Team 4b" (RAG query) service contract.
 *
 * CANONICAL as of the Phase 2A contract freeze (Rev.4.4 §12 / the
 * approved cross-team architecture) -- `TeamBQueryRequest` below is the
 * frozen, authoritative request body `POST /api/v1/query` accepts:
 *
 *   { query, session_id, retrieval_config }
 *
 * matching the real, existing Team 4B `QueryRequest`/`RetrievalConfig`
 * Pydantic models exactly (app/models/query.py, inspected directly for
 * this freeze, not assumed). Tenant identity (workspace_id, user_id) is
 * DELIBERATELY ABSENT -- Rev.4.4 requires it come exclusively from the
 * internal service JWT, not implemented by this change.
 */

/**
 * Team 4B's REAL, actual `SourceAttribution` response contract
 * (app/models/query.py, inspected directly for this correction --
 * NOT the same shape as the earlier, incorrect `TeamBCitation` this
 * replaces). Required: document_id, document_title, chunk_id,
 * relevance_score. Optional, mutually-informative-but-not-exclusive:
 * page_number/section_heading (populated for a "document" source),
 * start_timestamp/end_timestamp (populated for a "video" source) --
 * there is no explicit `type` discriminator field on the real 4B
 * schema; which pair is populated is itself the signal (see
 * app/api/chat/route.ts's `toSourceAttribution` adapter).
 *
 * Distinct from, and never to be confused with, Team 4C's OWN,
 * different `SourceAttribution` shape (store/appStore.ts: `type`,
 * `sourceFile`, `fileId`, `location`, `label`) -- that is the UI-facing
 * type this one is adapted INTO, not the same type.
 */
export interface TeamBSourceAttribution {
  document_id: string;
  document_title: string;
  chunk_id: string;
  relevance_score: number;
  page_number?: number | null;
  section_heading?: string | null;
  start_timestamp?: number | null;
  end_timestamp?: number | null;
}

/** Mirrors Team 4B's real `RetrievalConfig` model exactly (app/models/
 * query.py, inspected directly): top_k in [1,50] default 5,
 * score_threshold in [0.0,1.0] default 0.3, search_mode one of the three
 * official values, collection_filter optional. */
export type TeamBSearchMode = "hybrid" | "semantic" | "keyword";

export interface TeamBRetrievalConfig {
  top_k?: number;
  score_threshold?: number;
  search_mode?: TeamBSearchMode;
  collection_filter?: string[] | null;
  /**
   * MVP M6 — document-level retrieval scope (Team 4B's frozen,
   * unmodified contract: `RetrievalConfig.document_ids`, bounded at 100
   * entries on 4B's own side). `undefined`/omitted = workspace-wide
   * (unchanged). `[]` is a deliberate, non-widening "zero eligible
   * sources" signal -- never sent to mean "no restriction". Populated
   * ONLY from `lib/sourceScope.ts`'s server-side-validated conversation
   * scope (app/api/chat/route.ts) -- never from an unvalidated browser
   * value.
   */
  document_ids?: string[];
}

export interface TeamBQueryRequest {
  query: string;
  session_id: string | null;
  retrieval_config: TeamBRetrievalConfig | null;
}

/**
 * Team 4B's REAL, actual response contract (app/models/query.py,
 * `QueryResponse`, inspected directly for this correction). Note
 * `session_id` here is always a real string (4B auto-creates/resolves
 * one even when the request's own `session_id` was `null`) --
 * `retrieval_metadata` is an intentionally open `dict[str, Any]` on the
 * 4B side (no fixed schema is specified), so it is typed the same way
 * here rather than inventing a closed shape 4B itself doesn't declare.
 * Two of its keys are read as explicit, response-level (never
 * per-citation) signals by app/api/chat/route.ts's citation-suppression
 * logic -- `chunks_retrieved` (Stage 7: a number; `<= 0` means nothing
 * was retrieved at all) and `grounded` (Stage 8: a boolean; `false`
 * means chunks WERE retrieved but the model explicitly reported it
 * could not ground an answer in them -- "retrieved-but-refused", see
 * team4b/app/services/llm_generator.py's `GenerationResult`). Both are
 * read defensively (`typeof x === "number"` / `"boolean"`) since this
 * dict's schema is intentionally open and a value could be absent,
 * non-conforming, or come from an older backend -- neither key's
 * absence is ever treated as `true`/non-zero, only as "no signal."
 */
export interface TeamBQueryResponse {
  answer: string;
  session_id: string;
  source_attributions: TeamBSourceAttribution[];
  retrieval_metadata: Record<string, unknown>;
}

/**
 * Extra context consumed ONLY by this repository's local mock simulation
 * of Team B (services/teamB/mock.ts) -- NEVER part of the canonical,
 * over-the-wire contract a real Team B backend receives. The real Team B
 * `QueryRequest` schema has no "workspace" concept in its body at all
 * (tenant identity comes from the JWT, once implemented) and no
 * `videoTimestamp` field in its authoritative schema (app/models/
 * query.py, confirmed directly) -- these two fields exist here only
 * because `mockTeamB` is a local, Mongo-backed simulation standing in
 * for a real network call (it queries `FileModel` directly and grounds
 * "what's on screen right now" answers), not a thin HTTP client with
 * nothing of its own to add. `services/teamB/client.ts` (the REAL
 * client) explicitly does not read or forward either field onto the
 * wire -- see that file's request-body construction.
 *
 * KNOWN, REPORTED GAP (Phase 2A audit finding, not resolved by this
 * change): `videoTimestamp` therefore currently has NO defined transport
 * mechanism to a real Team B backend under the canonical contract --
 * Team 4B's authoritative schema has no field for it, and inventing one
 * here would be exactly the kind of out-of-scope Team B schema change
 * this task prohibits. This is intentionally left as an open contract
 * question for the next phase, not silently resolved.
 */
export interface TeamBMockOnlyContext {
  workspaceId: string;
  videoTimestamp: number | null;
}

/**
 * Phase 2E: the server-verified identity `realTeamB.query()` needs to
 * mint the Phase 2B internal service JWT -- analogous to
 * `TeamASubmitContext` (types/teamA.ts), kept as a SEPARATE interface
 * from `TeamBMockOnlyContext` above because these two are genuinely
 * different concerns: `TeamBMockOnlyContext` is consumed ONLY by the
 * local mock simulation and NEVER reaches a real backend at all;
 * `TeamBAuthContext` is consumed ONLY by the REAL client, to mint a
 * token, and is likewise never part of the canonical wire BODY (the
 * JWT carries this identity instead). Snake_case (`workspace_id`)
 * matches the JWT claim name directly, deliberately distinct from
 * `TeamBMockOnlyContext.workspaceId`'s camelCase (an internal-4C-model
 * naming convention predating this phase, kept as-is).
 */
export interface TeamBAuthContext {
  sub: string;
  workspace_id: string;
}

/**
 * Step 7 — session restoration after Team 4B's Redis session TTL expires.
 * Mirrors the real `POST /api/v1/sessions/{session_id}/seed` contract
 * (team4b/app/api/routes.py's `SeedTurn`/`SeedSessionRequest`) exactly:
 * `turns` in chronological (oldest-first) order, `timestamp` optional.
 */
export interface TeamBSeedTurn {
  role: "user" | "assistant";
  content: string;
  timestamp?: number;
}

export interface TeamBSeedResponse {
  session_id: string;
  seeded: boolean;
  turn_count: number;
}

/**
 * Stage 9B — real token streaming. Mirrors Team 4B's own NDJSON wire
 * events exactly (`POST /api/v1/query/stream`, team4b/app/api/routes.py):
 * a `"delta"` event carries one genuinely-generated text fragment as it
 * arrives (never a client-side-simulated chunk of an already-complete
 * answer); a `"done"` event carries the SAME shape as `TeamBQueryResponse`
 * (answer, session_id, source_attributions, retrieval_metadata) --
 * Team 4B deliberately delays citations and the Stage 8 grounding signal
 * until generation is fully finished, exactly as `TeamBQueryResponse`
 * already does for the non-streaming route, so no new response shape is
 * invented here; a `"error"` event means generation failed AFTER the
 * HTTP response was already committed (streaming had begun) -- the
 * disclosed trade-off of HTTP streaming, see team4b's own Stage 9B report
 * -- and is never followed by a `"done"` event for the same request.
 */
export interface TeamBStreamDelta {
  type: "delta";
  text: string;
}

export type TeamBStreamDone = TeamBQueryResponse & { type: "done" };

export interface TeamBStreamError {
  type: "error";
  detail: string;
}

export type TeamBStreamEvent = TeamBStreamDelta | TeamBStreamDone | TeamBStreamError;

export interface TeamBService {
  query(request: TeamBQueryRequest & Partial<TeamBMockOnlyContext> & Partial<TeamBAuthContext>): Promise<TeamBQueryResponse>;

  /**
   * Stage 9B — the streaming counterpart to `query()` above, yielding
   * `TeamBStreamEvent`s as they genuinely arrive. OPTIONAL for the same
   * reason `hasSession`/`seedSession`/`deleteSession` are: every existing
   * `TeamBService`-shaped test double across this codebase (~90+ call
   * sites in tests/unit/chat-api.test.ts alone) implements only `query()`,
   * predating this feature, and none of them should be forced to change.
   * `app/api/chat/route.ts` calls this ONLY when a given implementation
   * provides it, falling back to `query()` (plus the pre-existing
   * simulated word-by-word replay) otherwise -- see that route's own
   * comments for the exact fallback contract.
   */
  queryStream?(
    request: TeamBQueryRequest & Partial<TeamBMockOnlyContext> & Partial<TeamBAuthContext>
  ): AsyncIterable<TeamBStreamEvent>;

  /**
   * Whether `sessionId` currently has a live (non-expired) session on
   * Team 4B — backed by `GET /api/v1/sessions/{id}/history` (a 404 there
   * means "missing"). STEP 2 REMEDIATION: this endpoint now requires the
   * same internal service JWT as `query`/`seedSession` (previously the
   * only unauthenticated internal-service route) — `auth` is required
   * here for exactly the same reason it's required on `seedSession`.
   * OPTIONAL on this interface: every existing `TeamBService`-shaped test
   * double across this codebase implements only `query()`, and adding a
   * required method here would force every one of those (unrelated to
   * this feature) to be rewritten. Callers (`lib/restoreSession.ts`) skip
   * restoration entirely when a given implementation doesn't provide
   * this — never a hard runtime dependency.
   */
  hasSession?(sessionId: string, auth: TeamBAuthContext): Promise<boolean>;

  /** Restores `sessionId`'s history on Team 4B from `turns` — see
   * `hasSession`'s docstring for why this is optional. */
  seedSession?(
    sessionId: string,
    turns: TeamBSeedTurn[],
    auth: TeamBAuthContext
  ): Promise<TeamBSeedResponse>;

  /**
   * STEP 5 — best-effort cleanup of `sessionId`'s Redis history on Team
   * 4B, called when the Team 4C Conversation it belongs to is deleted.
   * Backed by `DELETE /api/v1/sessions/{id}` (Step 3 remediation), gated
   * by the same internal service JWT as every other session route.
   * OPTIONAL for the same reason `hasSession`/`seedSession` are: never a
   * hard runtime dependency for existing test doubles. Callers treat a
   * failure here as non-fatal — the Team 4C-side deletion (the
   * authoritative one) must never be blocked or reverted by Team 4B
   * being unreachable.
   */
  deleteSession?(sessionId: string, auth: TeamBAuthContext): Promise<boolean>;
}
