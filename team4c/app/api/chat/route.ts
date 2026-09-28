import { auth } from "@/lib/auth";
import { assertConversationOwnership } from "@/lib/conversationAuth";
import { connectToDatabase } from "@/lib/mongodb";
import { OwnershipError } from "@/lib/ownership";
import { getOrCreateRagSessionId } from "@/lib/ragSession";
import { restoreSessionIfMissing } from "@/lib/restoreSession";
import { resolveEffectiveDocumentIds } from "@/lib/sourceScope";
import { filterWorkspaceReferences } from "@/lib/workspaceFilter";
import { ConversationModel } from "@/models/Conversation";
import { FileModel } from "@/models/File";
import { MessageModel } from "@/models/Message";
import { getTeamBService } from "@/services/teamB";
import { TeamBQueryError } from "@/services/teamB/client";
import type { SourceAttribution } from "@/store/appStore";
import type { TeamBQueryResponse, TeamBSourceAttribution, TeamBStreamEvent } from "@/types/teamB";
import type { UIMessage } from "ai";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";

interface ChatRequestBody {
  messages: UIMessage[];
  workspaceId: string;
  conversationId: string;
  videoTimestamp: number | null;
}

/**
 * PHASE 2E CORRECTION: adapts Team 4B's REAL `SourceAttribution` response
 * shape (types/teamB.ts's `TeamBSourceAttribution` -- document_id,
 * document_title, chunk_id, relevance_score, page_number?,
 * section_heading?, start_timestamp?, end_timestamp?, confirmed directly
 * against app/models/query.py) into Team 4C's OWN, existing, UI-facing
 * `SourceAttribution` shape (store/appStore.ts) -- these are genuinely
 * different types with the same name in different codebases, never to be
 * confused with each other.
 *
 * There is no explicit `type` discriminator on Team 4B's real schema --
 * which of the two mutually-exclusive-in-practice field pairs is
 * populated (`page_number`/`section_heading` for a document source vs.
 * `start_timestamp`/`end_timestamp` for a video source) is itself the
 * signal, exactly as app/models/query.py's own docstring describes.
 * `chunk_id`/`relevance_score`/`section_heading` are carried through onto
 * the existing type's new, additive, optional fields (added by this same
 * correction -- store/appStore.ts) so no data Team 4B actually sends is
 * silently dropped, even though the current UI doesn't render all of it
 * yet. `disabled` is left unset here; the actual Requirement 3.5
 * workspace-safety check happens next, against real workspace files,
 * completely unchanged by this correction.
 *
 * Stage 7 correction: `attribution.document_title` (Team 4B's real,
 * ingestion-pipeline-assigned value) is the STORAGE identifier Team 4A
 * ingested the document under -- confirmed by live verification to be a
 * hash-like generated name (e.g. "839acd8ee30b41ed8d92293da7bda1d0.pdf"),
 * never the name the user actually uploaded. The user-facing display
 * name now always prefers `originalName` -- the SAME `File.originalName`
 * this route already fetches from its own, authoritative MongoDB (never
 * from Team B, never client-supplied) for the Requirement 3.5 workspace
 * check just below -- resolved by `document_id`, i.e. from the correct
 * document AND already scoped to the correct (active) workspace's own
 * File query. Team B's `document_title` is kept only as a last-resort
 * fallback for the (should-not-happen-for-an-authorized-citation) case
 * where no matching File is found, so a citation is never dropped or
 * left blank outright. `fileId`/`location`/`chunkId`/`relevanceScore`/
 * `fileUrl` -- the actual citation LINK and identity -- are completely
 * unchanged by this correction; only the human-readable label differs.
 */
function toSourceAttribution(
  attribution: TeamBSourceAttribution,
  fileUrl: string | undefined,
  originalName: string | undefined
): SourceAttribution {
  const isPdf = attribution.page_number != null || attribution.section_heading != null;
  const location = isPdf ? attribution.page_number ?? 0 : attribution.start_timestamp ?? 0;
  const displayName = originalName ?? attribution.document_title;
  return {
    type: isPdf ? "pdf_page" : "video_timestamp",
    sourceFile: displayName,
    fileId: attribution.document_id,
    location,
    label: isPdf ? `${displayName}, page ${location}` : `${displayName} at ${location}s`,
    fileUrl,
    chunkId: attribution.chunk_id,
    relevanceScore: attribution.relevance_score,
    sectionHeading: attribution.section_heading ?? undefined,
  };
}

/**
 * Maps a failed Team B call (real client's `TeamBQueryError`, or any
 * other unexpected error) to the SAME safe, non-leaking client response
 * this route has always returned — extracted unchanged from the
 * pre-Stage-9B inline `catch` block so both the non-streaming fallback
 * path and Stage 9B's streaming path's own priming failure produce
 * byte-identical responses for the same failure.
 */
function teamBErrorResponse(error: unknown): Response {
  if (error instanceof TeamBQueryError) {
    if (error.status === 401) {
      return new Response(JSON.stringify({ error: "Query service authentication failed." }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (error.status === 403) {
      return new Response(JSON.stringify({ error: "Query service authorization failed." }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (error.status === 422) {
      return new Response(JSON.stringify({ error: "Invalid query request." }), {
        status: 422,
        headers: { "Content-Type": "application/json" },
      });
    }
    console.error(`[chat] Team B query failed with status ${error.status}`);
    return new Response(JSON.stringify({ error: "The query service is temporarily unavailable." }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }
  console.error("[chat] Team B query failed:", error instanceof Error ? error.message : "Unknown error");
  return new Response(JSON.stringify({ error: "The query service is temporarily unavailable." }), {
    status: 502,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Everything that happens once a COMPLETE answer is known — whether it
 * came back in one piece from `teamB.query()` (the fallback path) or as
 * a streaming `"done"` event's own `TeamBQueryResponse`-shaped payload
 * (Stage 9B's real streaming path). Extracted unchanged from the
 * pre-Stage-9B body of this route (citation suppression, workspace-scoped
 * citation filtering, diagnostic logging, title auto-generation, and —
 * crucially — Message persistence) so BOTH paths apply the exact same
 * Stage 7/Stage 8 grounding rules and persist messages at the exact same
 * point: only once a complete, successful answer exists. Never called for
 * a failed or partial (mid-stream-error) response — that is exactly how
 * this route ensures a partial/failed answer is never saved as if it
 * were complete.
 */
async function finalizeAnswer({
  answer,
  source_attributions,
  retrieval_metadata,
  workspaceId,
  conversationId,
  conversationTitle,
  queryText,
}: {
  answer: string;
  source_attributions: TeamBQueryResponse["source_attributions"];
  retrieval_metadata: TeamBQueryResponse["retrieval_metadata"];
  workspaceId: string;
  conversationId: string;
  conversationTitle: string;
  queryText: string;
}): Promise<{ attributions: SourceAttribution[] | undefined }> {
  // Stage 7 — `retrieval_metadata.chunks_retrieved` (app/models/query.py's
  // documented, if intentionally-open, field -- app/services/rag_service.py
  // sets it to the EXACT count of retrieval results the real backend
  // found, 0 for a casual/greeting message or genuinely zero-relevance
  // retrieval) is read here as an explicit, backend-supplied signal for
  // whether this answer was actually grounded in retrieved material --
  // never inferred from the answer's own text via a frontend keyword/
  // phrase heuristic. `null` (missing, non-numeric, or -- as today --
  // simply absent on some already-existing test doubles) means "this
  // backend didn't supply the signal," which intentionally falls back to
  // the pre-existing `source_attributions.length > 0` check below rather
  // than ever WIDENING what gets shown; it can only ever narrow (force a
  // citation-bearing response to render with none) when the backend
  // explicitly reports zero retrieved chunks, never the reverse.
  const chunksRetrieved =
    typeof retrieval_metadata?.chunks_retrieved === "number" ? retrieval_metadata.chunks_retrieved : null;
  const retrievalConfirmedZero = chunksRetrieved !== null && chunksRetrieved <= 0;

  // Stage 8 — `retrieval_metadata.grounded` (team4b/app/services/
  // llm_generator.py's `GenerationResult.grounded`, threaded through by
  // RAGService) is an EXPLICIT backend signal for "chunks were
  // retrieved, but the model itself reported it could not actually
  // answer from them" (retrieved-but-refused) — genuinely different
  // from Stage 7's `chunks_retrieved === 0` (nothing was retrieved at
  // all). `chunks_retrieved > 0` alone never proves an answer is
  // grounded; only an explicit `grounded: false` does. Per the approved
  // design, this ONLY ever narrows (suppresses) on an explicit `false`
  // signal — a missing/non-boolean value (an older backend, a zero-
  // retrieval short-circuit that never set it, or a live, measured,
  // real compliance gap where the model's own output didn't conform to
  // the required structured-JSON format) is treated as "no signal" and
  // NEVER suppresses citations that would otherwise render — it is
  // never treated as though it were `true` either. See team4b's own
  // Stage 8 report for the live compliance measurements this design is
  // based on.
  const grounded = typeof retrieval_metadata?.grounded === "boolean" ? retrieval_metadata.grounded : null;
  const retrievalConfirmedRefused = grounded === false;

  // Real files in the ACTIVE workspace only — this is the actual security
  // boundary for Requirement 3.5, not anything the client or Team B claims.
  const workspaceFiles = await FileModel.find({ workspaceId });
  const workspaceFileIds = workspaceFiles.map((file) => file._id.toString());
  const fileUrlById = new Map(workspaceFiles.map((file) => [file._id.toString(), file.storageUrl]));
  // Stage 7 — the authoritative, user-facing filename for each of THIS
  // workspace's own files, keyed by the same File._id every other map
  // here already uses. Never Team B's own document_title.
  const fileNameById = new Map(workspaceFiles.map((file) => [file._id.toString(), file.originalName]));

  const attributions =
    source_attributions && source_attributions.length > 0 && !retrievalConfirmedZero && !retrievalConfirmedRefused
      ? filterWorkspaceReferences(
          source_attributions.map((attribution) =>
            toSourceAttribution(
              attribution,
              fileUrlById.get(attribution.document_id),
              fileNameById.get(attribution.document_id)
            )
          ),
          workspaceFileIds
        )
      : undefined;

  // Stage 7 — Team B reported zero retrieved chunks but still returned a
  // non-empty source_attributions array (should not happen given
  // app/services/response_assembly.py's own contract -- it builds
  // source_attributions 1:1 from the same retrieval results
  // chunks_retrieved counts -- but this route never trusts that
  // invariant blindly). Worth a server-side log: it means the two
  // signals genuinely disagreed, which the citations-suppression logic
  // above already resolved safely (by suppressing), but is still an
  // anomaly worth surfacing rather than silently swallowing.
  if (retrievalConfirmedZero && source_attributions && source_attributions.length > 0) {
    console.warn(
      `[chat] Team B reported chunks_retrieved: ${chunksRetrieved} but returned ${source_attributions.length} source_attribution(s) — citations suppressed for conversation ${conversationId}.`
    );
  }

  // Stage 8 — logged whenever the explicit grounding signal actually
  // suppressed a would-be-shown citation set (chunks WERE retrieved,
  // but the model reported it couldn't ground an answer in them). Not
  // an anomaly like the log above — this is the retrieved-but-refused
  // case working exactly as designed — but still worth a real record,
  // both for operational visibility and as the basis for measuring
  // actual model compliance/behavior over time.
  if (retrievalConfirmedRefused && source_attributions && source_attributions.length > 0) {
    console.warn(
      `[chat] Team B reported grounded: false with ${source_attributions.length} retrieved chunk(s) (retrieved-but-refused) — citations suppressed for conversation ${conversationId}.`
    );
  }

  // Property 13 — a citation Team B returned that references a file
  // outside the active workspace is disabled (above), but that event is
  // also worth a server-side security log: it means either Team B's mock
  // (or, later, the real Query_API) is returning a fileId this workspace
  // doesn't own, which is exactly the class of response this filtering
  // exists to catch. Logged server-side, not sent to the client — the
  // client only ever sees the already-safe `disabled: true` state.
  const unauthorizedAttributions = attributions?.filter(
    (attribution) => attribution.disabled && !workspaceFileIds.includes(attribution.fileId)
  );
  if (unauthorizedAttributions && unauthorizedAttributions.length > 0) {
    console.warn(
      `[chat] Team B returned ${unauthorizedAttributions.length} citation(s) referencing file(s) outside workspace ${workspaceId} — filtered before sending to client.`
    );
  }

  // MVP M5: Team 4C remains the durable conversation/message store —
  // Mongo, not Team 4B's ephemeral Redis session, is the system of
  // record. Persists both turns once the full answer is known. Only
  // AUTHORIZED, already-workspace-filtered attributions are stored
  // (never a disabled/unauthorized one) -- mapped into `Message`'s own,
  // pre-existing citation shape (`{fileId, type: "video"|"pdf", ...}`,
  // distinct from `SourceAttribution`'s `"pdf_page"/"video_timestamp"`
  // naming), which this route does not redesign.
  const storedCitations = attributions
    ?.filter((attribution) => !attribution.disabled)
    .map((attribution) => ({
      fileId: attribution.fileId,
      type: attribution.type === "pdf_page" ? ("pdf" as const) : ("video" as const),
      pageNumber: attribution.type === "pdf_page" ? attribution.location : undefined,
      timestampSeconds: attribution.type === "video_timestamp" ? attribution.location : undefined,
    }));

  await MessageModel.create({ conversationId, role: "user", content: queryText });

  // Stage 6 — auto-generates a conversation's title from its first user
  // message. Only ever replaces the literal default title ("New
  // conversation", set at creation by
  // app/api/workspaces/[id]/conversations/route.ts) -- a title the user
  // has since customized, or one already generated by an earlier
  // message in this same conversation, is never touched. The in-memory
  // `conversationTitle` check below is just an optimization to skip
  // the extra write on every non-first message; the actual safety
  // net against two concurrent first messages both winning is the
  // `title: "New conversation"` filter re-checked ATOMICALLY by MongoDB
  // at write time inside `findOneAndUpdate` -- once either request's
  // write lands, the other's identical filter no longer matches, so a
  // conversation can never be (re)titled twice from this path. An
  // empty/whitespace-only message never produces an empty/placeholder
  // title. Best-effort: a failure here is logged and swallowed, never
  // allowed to block message persistence or the streamed response.
  const trimmedQueryText = queryText.trim();
  if (conversationTitle === "New conversation" && trimmedQueryText.length > 0) {
    const generatedTitle =
      trimmedQueryText.length > 60 ? `${trimmedQueryText.slice(0, 60).trimEnd()}…` : trimmedQueryText;
    try {
      await ConversationModel.findOneAndUpdate(
        { _id: conversationId, title: "New conversation" },
        { $set: { title: generatedTitle } }
      );
    } catch (error) {
      console.warn(
        `[chat] Failed to auto-generate title for conversation ${conversationId} (best-effort, non-fatal):`,
        error instanceof Error ? error.message : "Unknown error"
      );
    }
  }

  await MessageModel.create({
    conversationId,
    role: "assistant",
    content: answer,
    citations: storedCitations && storedCitations.length > 0 ? storedCitations : undefined,
  });

  return { attributions };
}

/**
 * POST /api/chat — Accion Labs Requirement 2 (Chat Interface with
 * Streaming Responses) and Requirement 3 (Source Attribution). Consumes
 * Team B's Query_API via `getTeamBService()` (services/teamB/index.ts) —
 * the mock by default, per docs/decisions.md's mock-first strategy, but
 * the REAL Team4B backend when `USE_MOCK_TEAM_B=false` is set. This
 * route itself never knows or cares which one it's talking to — see
 * `getTeamBService()`'s own docstring.
 *
 * STAGE 9B: when the active `TeamBService` implements the optional
 * `queryStream()` (both `realTeamB` and `mockTeamB` now do), this route
 * forwards Team B's OWN genuinely-incremental token deltas straight to
 * the browser as they arrive — real streaming, not a client-side replay
 * of an already-complete answer. Citations and the Stage 7/Stage 8
 * grounding signal are deliberately delayed until Team B's own `"done"`
 * event (see `finalizeAnswer()` above), because both require the
 * complete answer and retrieval results, exactly as they did before this
 * change. Any `TeamBService` implementation that does NOT provide
 * `queryStream()` (every existing test double in
 * tests/unit/chat-api.test.ts) falls through to the ORIGINAL, unchanged
 * `query()` + simulated word-by-word replay path below — byte-for-byte
 * the same behavior this route has always had for those callers.
 *
 * SECURITY: `workspaceId` arrives in the request body from the client
 * (unavoidable — the client is the one that knows which workspace it's
 * asking about), but it is never trusted on its own. `assertOwnership()`
 * — the same helper every other route in this app uses — is the actual
 * authorization boundary: a workspaceId for a workspace the caller
 * doesn't own fails here exactly as it does everywhere else.
 *
 * Requirement 3.5: citations returned by Team B are NOT trusted as-is —
 * this route fetches the ACTIVE workspace's real files from MongoDB and
 * runs the existing `filterWorkspaceReferences()` (lib/workspaceFilter.ts,
 * already built for exactly this) before ever sending attributions to the
 * client. The client renders whatever `disabled` state it's given; it
 * never independently decides whether a citation is valid.
 */
export async function POST(request: Request) {
  const session = await auth();

  if (!session?.user?.id) {
    return new Response(JSON.stringify({ error: "Unauthorized." }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const body: ChatRequestBody = await request.json();
  const { messages, workspaceId, conversationId, videoTimestamp } = body;

  await connectToDatabase();

  // MVP M5: authorizes the WORKSPACE first (unchanged), then the
  // CONVERSATION itself -- a conversationId the browser supplies for a
  // conversation it doesn't own (wrong workspace, another user's,
  // nonexistent) is rejected HERE, before Team 4B is ever called. The
  // browser is never trusted to supply a ragSessionId/session_id
  // directly for an existing conversation -- only a conversationId,
  // which this server-side check resolves into the real, authorized
  // Conversation document.
  let conversation;
  try {
    conversation = await assertConversationOwnership(conversationId, workspaceId, session.user.id);
  } catch (error) {
    if (error instanceof OwnershipError) {
      return new Response(JSON.stringify({ error: "Not found." }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw error;
  }

  // Reads (or, for a pre-M5 conversation, atomically backfills) the
  // ONE stable ragSessionId for this Conversation -- see
  // lib/ragSession.ts for the concurrency-safe mechanism. `null` here
  // can only mean the conversation vanished between the authorization
  // check above and this call (a genuine, if narrow, TOCTOU window);
  // treated the same as "not found" rather than silently querying Team
  // 4B with no session context.
  const ragSessionId = await getOrCreateRagSessionId(conversationId);
  if (ragSessionId === null) {
    return new Response(JSON.stringify({ error: "Not found." }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  // MVP M6 — the server-persisted, authoritative source scope for this
  // conversation. `resolveEffectiveDocumentIds` RE-validates against
  // current File state every call (never trusts a stale persisted
  // scope, and never trusts anything the browser sent in THIS request
  // body -- the chat request has no document_ids field to begin with).
  // `null` = workspace-wide (unchanged). A non-null result -- even `[]`,
  // if every previously-selected File is no longer ready/authorized --
  // is passed through to Team 4B EXACTLY as resolved; it is never
  // widened back to `null` here.
  const effectiveDocumentIds = await resolveEffectiveDocumentIds(conversation.sourceScopeDocumentIds, workspaceId);

  const lastUserMessage = [...messages].reverse().find((message) => message.role === "user");
  const queryText = lastUserMessage
    ? lastUserMessage.parts
        .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
        .map((part) => part.text)
        .join("")
    : "";

  const teamB = getTeamBService();

  // If Team 4B's Redis session for this conversation has expired (its
  // TTL, independent of this Conversation's own lifetime), restore it
  // from Team 4C's own durable Message history before querying --
  // otherwise Team 4B would silently proceed with empty history, no
  // error, no signal to the caller. STEP 8: when restoration is genuinely
  // NECESSARY (real prior history exists) but CANNOT be completed, this
  // now fails the request explicitly instead of silently querying with
  // lost context -- distinguishing Team B being unreachable (502, same
  // contract as a query-time Team B outage below) from a failure to even
  // read this app's own history (500). A session that's alive, or a
  // conversation with nothing to restore, is entirely unaffected --
  // zero messages have been persisted yet at this point either way, so
  // failing here can never produce a duplicate/stray persisted message.
  const restoration = await restoreSessionIfMissing(teamB, ragSessionId, conversationId, {
    sub: session.user.id,
    workspace_id: workspaceId,
  });
  if (restoration.status === "team-b-unavailable") {
    console.error(`[chat] Could not restore conversation context for ${conversationId} — Team B unavailable.`);
    return new Response(JSON.stringify({ error: "The query service is temporarily unavailable." }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (restoration.status === "internal-error") {
    console.error(`[chat] Could not read conversation history for ${conversationId} to restore context.`);
    return new Response(JSON.stringify({ error: "An unexpected error occurred." }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  // CANONICAL CONTRACT (Phase 2A freeze, unchanged): the real, over-the-
  // wire request to Team B is `{query, session_id, retrieval_config}` —
  // workspaceId/videoTimestamp below are TeamBMockOnlyContext, consumed
  // exclusively by the local mock's own simulation. Phase 2E adds
  // `sub`/`workspace_id` (TeamBAuthContext) — server-verified identity
  // used ONLY by the real client to mint the Phase 2B internal service
  // JWT, never forwarded into the wire body either.
  //
  // MVP M5: `session_id` is now the real, stable, authorized
  // Conversation's own `ragSessionId` (never `conversationId` itself,
  // never `null` for an existing conversation) — the Phase 2A audit's
  // documented gap ("no ragSessionId field exists yet") is resolved as
  // of this task.
  const teamBRequest = {
    query: queryText,
    session_id: ragSessionId,
    retrieval_config: effectiveDocumentIds === null ? null : { document_ids: effectiveDocumentIds },
    workspaceId,
    videoTimestamp,
    sub: session.user.id,
    workspace_id: workspaceId,
  };

  if (teamB.queryStream) {
    // Stage 9B — real streaming path. `.next()` is called ONCE, here,
    // outside `createUIMessageStream`'s `execute` callback, before this
    // route has committed to returning a stream at all — mirroring Team
    // 4B's own "priming" pattern (team4b/app/api/routes.py's
    // `post_query_stream`): a failure Team B reports before any token is
    // produced (retrieval failure, conversation-store failure, Ollama
    // unreachable) throws HERE and still maps to the exact same 401/403/
    // 422/502 responses `teamBErrorResponse()` has always produced —
    // this route never silently degrades a pre-generation failure into a
    // 200 response with an empty or error-shaped stream body.
    const events = teamB.queryStream(teamBRequest)[Symbol.asyncIterator]();
    let primed: IteratorResult<TeamBStreamEvent>;
    try {
      primed = await events.next();
    } catch (error) {
      return teamBErrorResponse(error);
    }

    if (primed.done) {
      // No event at all — Team B never produced any usable output.
      // Treated the same as any other pre-generation failure: a real
      // error status, no stream, nothing persisted.
      return new Response(JSON.stringify({ error: "The query service is temporarily unavailable." }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (primed.value.type === "error") {
      // An in-band error on the very FIRST event — same treatment as
      // above.
      console.error(`[chat] Team B streaming query failed before any token: ${primed.value.detail}`);
      return new Response(JSON.stringify({ error: "The query service is temporarily unavailable." }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }

    const firstEvent: TeamBStreamEvent = primed.value;

    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        const id = crypto.randomUUID();
        writer.write({ type: "text-start", id });

        let doneEvent: TeamBQueryResponse | null = null;
        let current: TeamBStreamEvent | undefined = firstEvent;
        let anyDeltaWritten = false;

        while (current) {
          if (current.type === "delta") {
            writer.write({ type: "text-delta", id, delta: current.text });
            anyDeltaWritten = true;
          } else if (current.type === "done") {
            doneEvent = current;
            break;
          } else {
            // A failure Team B reports AFTER streaming has begun — the
            // HTTP response is already committed to 200, so this is
            // reported the only way it safely can be: ending the stream
            // via `onError` below. Crucially, `doneEvent` is still
            // `null` here, so `finalizeAnswer()` is NEVER called and NO
            // message is ever persisted for this partial answer.
            throw new Error(current.detail);
          }
          const next = await events.next();
          current = next.done ? undefined : next.value;
        }

        if (!doneEvent) {
          // The stream ended (Team B closed the connection) without ever
          // sending a "done" event — likewise never finalized/persisted.
          writer.write({ type: "text-end", id });
          throw new Error("The query service ended the stream unexpectedly.");
        }

        // Stage 2 — confirmed root cause of the reported "response
        // bubble appears empty or stuck" issue: Team4B's own
        // casual-intent and zero-retrieval short-circuits
        // (RAGService._stream_casual_result / the "if not
        // retrieved_results" branch in LLMGenerator.generate_stream())
        // yield ONLY a final "done" event with a real, complete
        // `answer` — never any prior "delta" events at all, since there
        // was never anything to incrementally generate. Without this
        // fallback, this loop above would forward zero text-delta
        // events for that entire request: the FULL answer would still
        // be correctly persisted by finalizeAnswer() below, but the
        // BROWSER would never receive any of it, leaving the assistant
        // bubble genuinely empty despite a real, complete, already-saved
        // answer existing server-side. This is a very common path (any
        // greeting, or any question retrieval finds nothing for), not
        // an obscure edge case — confirmed via a regression test built
        // directly from Team4B's own zero-retrieval response shape.
        if (!anyDeltaWritten && doneEvent.answer) {
          writer.write({ type: "text-delta", id, delta: doneEvent.answer });
        }
        writer.write({ type: "text-end", id });

        const { attributions } = await finalizeAnswer({
          answer: doneEvent.answer,
          source_attributions: doneEvent.source_attributions,
          retrieval_metadata: doneEvent.retrieval_metadata,
          workspaceId,
          conversationId,
          conversationTitle: conversation.title,
          queryText,
        });

        if (attributions) {
          writer.write({ type: "data-citations", data: attributions });
        }
      },
      onError: (error) => (error instanceof Error ? error.message : "An error occurred."),
    });

    return createUIMessageStreamResponse({ stream });
  }

  // Fallback — no `queryStream()` on the active TeamBService (every
  // existing test double, and any future implementation that hasn't
  // adopted Stage 9B yet). Byte-for-byte the same behavior this route
  // has always had: a single, complete, non-streaming `query()` call,
  // followed by a client-side word-by-word simulated replay.
  let queryResult: TeamBQueryResponse;
  try {
    queryResult = await teamB.query(teamBRequest);
  } catch (error) {
    // Phase 2E error handling: map the real 4B failure categories to
    // safe, non-leaking client responses. Never expose the private
    // signing key, internal service topology, or a raw exception/stack
    // trace, and never silently produce a successful-looking answer for
    // an authentication/authorization/validation failure.
    return teamBErrorResponse(error);
  }
  const { answer, source_attributions, retrieval_metadata } = queryResult;
  // MVP M5: 4B's own returned `session_id` is intentionally NOT
  // destructured/used here — the authoritative session identity is
  // Team 4C's own `ragSessionId` (already sent as the request's
  // `session_id` above); 4B's response echoes back whatever it was
  // given (or generates one for a `null` request, which this route
  // never sends for an existing conversation), so re-reading it here
  // would be redundant with, not additive to, what this route already
  // knows.

  const { attributions } = await finalizeAnswer({
    answer,
    source_attributions,
    retrieval_metadata,
    workspaceId,
    conversationId,
    conversationTitle: conversation.title,
    queryText,
  });

  // Splits the mock's canned answer into small chunks and writes them as
  // separate text-delta events, spaced out slightly — this is what
  // actually produces incremental rendering on the client (Requirement
  // 2.2 / Property 2) for a `TeamBService` that doesn't support real
  // streaming, via the real UI message stream protocol rather than
  // sending the whole answer in a single chunk.
  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      const id = crypto.randomUUID();
      writer.write({ type: "text-start", id });

      const words = answer.split(" ");
      for (const word of words) {
        writer.write({ type: "text-delta", id, delta: `${word} ` });
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      writer.write({ type: "text-end", id });

      if (attributions) {
        writer.write({ type: "data-citations", data: attributions });
      }
    },
    onError: (error) => (error instanceof Error ? error.message : "An error occurred."),
  });

  return createUIMessageStreamResponse({ stream });
}
