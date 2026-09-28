"""Team 4B RAGService orchestrator (Task 7.1).

Coordinates the already-approved HybridRetriever, ConversationManager,
and LLMGenerator components to answer one query. RAGService is thin: it
never talks to Qdrant, Redis, or Ollama directly, never computes RRF or
embeddings, never builds a prompt, and never assembles the final
SourceAttribution/QueryResponse contract.

APPROVED ARCHITECTURE:

                     +-- ConversationManager
                     |
    Query --> RAGService +-- HybridRetriever
                     |
                     +-- LLMGenerator
                              |
                              v
                           Answer

SCOPE NOTE (Task 7.1 only): this module does NOT implement:
  - Task 7.2's response assembly (SourceAttribution conversion,
    dedup, sorting) or its property tests (P9-P12, P15-P17).
  - Task 8.1's API routes (`POST /api/v1/query`,
    `GET /api/v1/sessions/{id}/history`).
  - Any change to HybridRetriever, ConversationManager, LLMGenerator,
    VectorStoreManager, BM25Index, Embedder, or the Task 1.2 models.

DOCUMENTED DECISION -- session_id resolution: neither Requirement 4 nor
Task 7.1 specifies how a session_id is generated when the caller
supplies none (session auto-creation is explicitly an API/orchestration
concern this task must provide the *internal* behavior for, without
implementing the HTTP layer itself). This implementation generates a
fresh `uuid.uuid4()` string when `session_id` is `None`. `uuid4` is the
standard, collision-resistant choice for this and requires no additional
justification beyond "a unique identifier is needed and none was
supplied" -- flagged as a documented internal choice, not a quoted
specification requirement, since no other reasonable option was
seriously in contention.

DOCUMENTED DECISION -- turn persistence order: neither official document
explicitly settles whether the current user turn must be persisted
before or after retrieval/generation. This implementation:
  1. Reads conversation history BEFORE persisting the current user turn
     (so the history passed to LLMGenerator never includes the query
     it's currently answering -- avoiding an obvious duplication bug).
  2. Persists the user turn unconditionally, before retrieval/generation
     are attempted.
  3. Persists the assistant turn ONLY after `LLMGenerator.generate()`
     returns successfully.
This is not an arbitrary choice: the task brief's own "Persistence
order" section states the semantic requirements as "user query becomes
part of conversation history" (stated unconditionally) versus "assistant
answer is appended after generation" and "failed generation must not
falsely record a successful assistant answer" (both conditioned on
generation succeeding) -- only the assistant side carries a success
condition in that wording. Consequently: if retrieval or generation
fails, the user's question remains recorded (a real event that
happened, regardless of whether the system could answer it) but no
assistant turn is ever fabricated. No rollback of the user turn is
implemented, per the explicit instruction not to invent transactional
semantics the specification doesn't require.

DOCUMENTED DECISION -- retrieval_metadata contents: originally kept to
the two fields already referenced elsewhere in this project's own
documentation (`app/models/query.py`'s docstring, itself citing Property
15's naming) -- `chunks_retrieved` and `search_mode` -- rather than
inventing a larger schema. `QueryResponse.retrieval_metadata` is typed as
an intentionally open `dict[str, Any]`, which is exactly what let Stage 8
add a third key, `grounded` (an explicit bool, present only when
`LLMGenerator.generate()` produced a real signal -- see that module's own
Stage 8 note), without this module needing any structural change at all.

SEARCHMODE CONVERSION AT THE BOUNDARY (per this task's explicit
instruction not to refactor the known SearchMode duplication):
`HybridRetriever.retrieve()`'s `search_mode` parameter is typed against
its own pre-existing `Literal["hybrid", "semantic", "keyword"]` alias
(Task 3.2), while `RetrievalConfig.search_mode` (Corrective Task 1.2) is
the canonical `app.models.query.SearchMode` string-enum. Both represent
the same three values and are runtime-interchangeable (a `str, Enum`
member compares equal to, and hashes the same as, its underlying string
value -- verified directly, not assumed), but they are distinct static
types. This module performs the smallest possible conversion at its own
boundary -- reading `retrieval_config.search_mode.value` and assigning
it to a variable annotated with HybridRetriever's own Literal alias --
rather than modifying either existing type. mypy's own enum-literal
inference confirms `SearchMode.value` is already statically compatible
with that Literal for these three members, so no explicit `cast()` is
needed; the annotated intermediate variable exists purely for
readability/documentation of the conversion, not to silence a type
error. See docs/CONTRACT_DECISIONS.md item 7 for the prior note on this
same duplication.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Any, Iterator

from app.models.query import RetrievalConfig
from app.models.retrieval import RetrievalResult
from app.services.casual_intent import is_casual_message
from app.services.conversation import ConversationManager
from app.services.conversation import ConversationTurn as _ConversationTurn
from app.services.followup_context import build_enriched_retrieval_query, is_elliptical_query
from app.services.hybrid_retriever import HybridRetriever
from app.services.hybrid_retriever import SearchMode as _HybridRetrieverSearchMode
from app.services.llm_generator import LLMGenerator, StreamDelta


@dataclass
class RAGServiceResult:
    """Task 7.1's internal orchestration result.

    Deliberately NOT `QueryResponse` (Task 1.2/API contract): this
    carries the RAW `RetrievalResult` objects (not yet converted into
    `SourceAttribution`) so Task 7.2's response-assembly layer has
    everything it needs -- chunk_id, text, relevance_score, and the
    full read-side-normalized metadata dict (document_id, document_title,
    source_type, page_number, section_heading, start_timestamp,
    end_timestamp) -- without RAGService prematurely deciding how
    attributions should be sorted, deduplicated, or shaped. This is an
    internal type, not part of the public API contract; it exists only
    because Task 7.2 needs a place to receive this data from, and
    reusing `QueryResponse` for it would incorrectly imply RAGService
    already produces the final API response shape.
    """

    answer: str
    session_id: str
    retrieval_results: list[RetrievalResult]
    retrieval_metadata: dict[str, Any]


def _most_recent_user_turn(history: list[_ConversationTurn]) -> str | None:
    """MVP M6 correction -- the single most recent USER turn's own
    `content`, or `None` if `history` contains no user turn at all
    (e.g. a fresh conversation). `history` is in chronological order
    (oldest first, per `ConversationManager.get_windowed_history()`'s
    own contract), so this scans from the end backward and returns on
    the first match -- deliberately never the assistant's own answer
    text, and deliberately never more than one turn (see
    `followup_context.build_enriched_retrieval_query()`'s own docstring
    for why: using more history risks pulling in an already-superseded
    topic).
    """

    for turn in reversed(history):
        if turn.role == "user":
            return turn.content
    return None


@dataclass
class _PreparedQuery:
    """Stage 9B -- everything `handle_query()` and `handle_query_stream()`
    both need BEFORE generation, computed exactly once by
    `RAGService._prepare_query()` and shared between them, so the
    casual-intent gate, follow-up enrichment, and retrieval-invocation
    logic exist in exactly one place regardless of which of the two
    (streaming or not) a caller uses.
    """

    resolved_session_id: str
    config: RetrievalConfig
    history: list[_ConversationTurn]
    is_casual: bool
    retrieval_results: list[RetrievalResult]


class RAGService:
    """Orchestrates ConversationManager, HybridRetriever, and
    LLMGenerator to answer one query. Contains no retrieval, storage, or
    generation logic of its own -- see module docstring.
    """

    def __init__(
        self,
        hybrid_retriever: HybridRetriever,
        conversation_manager: ConversationManager,
        llm_generator: LLMGenerator,
    ) -> None:
        self._retriever = hybrid_retriever
        self._conversation_manager = conversation_manager
        self._llm_generator = llm_generator

    def _prepare_query(
        self,
        query: str,
        *,
        workspace_id: str,
        session_id: str | None,
        retrieval_config: RetrievalConfig | None,
    ) -> _PreparedQuery:
        """Everything before generation: session resolution, history
        read, persisting the user's turn, the casual-intent gate, and
        (for a non-casual query) follow-up enrichment and retrieval.
        Entirely synchronous -- `VectorStoreUnavailableError` /
        `ConversationStoreUnavailableError` propagate from THIS call
        immediately, before any generation (streaming or not) is ever
        attempted, exactly matching `handle_query()`'s original,
        pre-Stage-9B behavior.
        """

        resolved_session_id = session_id if session_id is not None else str(uuid.uuid4())
        config = retrieval_config if retrieval_config is not None else RetrievalConfig()

        # Read history BEFORE this turn is recorded -- see module
        # docstring: the history passed to LLMGenerator must never
        # include the very query it's currently being asked to answer.
        history = self._conversation_manager.get_windowed_history(resolved_session_id)

        # Persisted unconditionally, before retrieval/generation are
        # attempted -- see module docstring's ordering decision.
        self._conversation_manager.append_turn(resolved_session_id, "user", query)

        # MVP M6 correction: a deterministic, pre-retrieval casual-intent
        # gate (app/services/casual_intent.py) -- checked BEFORE
        # HybridRetriever.retrieve() is ever called, so Qdrant/BM25
        # genuinely never run for a casual message like "Hi" (not merely
        # "citations are hidden afterward"). `retrieval_results` is
        # therefore an actual empty list here, not a filtered one --
        # response assembly downstream produces zero citations for
        # exactly the same reason it always does for an empty list,
        # with no special-casing needed there at all.
        if is_casual_message(query):
            return _PreparedQuery(resolved_session_id, config, history, True, [])

        hybrid_retriever_search_mode: _HybridRetrieverSearchMode = config.search_mode.value

        # MVP M6 correction: deterministic, domain-agnostic follow-up
        # context enrichment (app/services/followup_context.py) -- the
        # RETRIEVAL query only, built from the single most recent USER
        # turn's own text. The ORIGINAL `query` (already persisted above,
        # already what `generate()` receives as its "Current Question")
        # is never modified by any of this -- only the string handed to
        # `self._retriever.retrieve()` below can differ from it.
        #
        # PHASE 5C-1 CORRECTION: `is_elliptical_query()` is a coarse,
        # domain-agnostic heuristic (any pronoun/demonstrative word
        # anywhere in the query) -- it has confirmed false positives on
        # plenty of fully self-contained questions (e.g. "What is a DBMS
        # and what are ITS key features?", "...a query THAT finds...").
        # Previously, a positive match with no previous user turn to
        # enrich from short-circuited straight to an ungrounded
        # clarification reply, skipping retrieval entirely -- correct
        # for a genuinely context-dependent query ("How does it work?"
        # with truly nothing else said), but silently wrong for a
        # false-positive one, since the query was perfectly retrievable
        # on its own. `build_enriched_retrieval_query()` already handles
        # a missing `previous_user_turn` gracefully (returns the query
        # unchanged) -- calling it unconditionally, rather than only
        # when a previous turn exists, means a false positive now simply
        # falls through to normal retrieval on the original query, and a
        # genuine no-context elliptical query still reaches
        # `LLMGenerator.generate()`, which already returns
        # `INSUFFICIENT_CONTEXT_MESSAGE` (no LLM call, no fabrication)
        # when `retrieval_results` is empty -- an honest non-answer
        # instead of a scripted clarification, not a regression in
        # safety. Genuine follow-ups (a real previous user turn exists)
        # are completely unaffected: `build_enriched_retrieval_query()`
        # enriches exactly as it always did.
        retrieval_query = query
        if is_elliptical_query(query):
            previous_user_turn = _most_recent_user_turn(history)
            retrieval_query = build_enriched_retrieval_query(query, previous_user_turn)

        retrieval_results = self._retriever.retrieve(
            retrieval_query,
            workspace_id=workspace_id,
            top_k=config.top_k,
            score_threshold=config.score_threshold,
            search_mode=hybrid_retriever_search_mode,
            collection_filter=config.collection_filter,
            document_ids=config.document_ids,
        )

        return _PreparedQuery(resolved_session_id, config, history, False, retrieval_results)

    def handle_query(
        self,
        query: str,
        *,
        workspace_id: str,
        session_id: str | None = None,
        retrieval_config: RetrievalConfig | None = None,
    ) -> RAGServiceResult:
        """Answer `query`, using `session_id`'s conversation history
        (or a freshly generated session_id if none is supplied) and
        `retrieval_config` (or its own defaults if none is supplied).

        `workspace_id` is REQUIRED (keyword-only, no default) -- MVP M3's
        mandatory multi-tenant isolation boundary, threaded straight into
        `HybridRetriever.retrieve()`'s own mandatory `workspace_id`
        parameter. This method has no code path that retrieves without
        it, and `RetrievalConfig` (the one caller-configurable knob this
        method accepts) has no `workspace_id`-shaped field a caller could
        use to influence or override it -- the two are structurally
        independent.

        Raises whatever domain exception the failing component raises
        (`VectorStoreUnavailableError`, `LLMUnavailableError`,
        `ConversationStoreUnavailableError`, `InvalidSearchModeError`,
        `InvalidConversationRoleError`) -- none of them are caught,
        wrapped, or converted into a generic exception here. See the
        module docstring's "turn persistence order" decision for exactly
        what is and isn't persisted when a failure occurs partway
        through.
        """

        prepared = self._prepare_query(
            query, workspace_id=workspace_id, session_id=session_id, retrieval_config=retrieval_config
        )

        if prepared.is_casual:
            answer = self._llm_generator.generate_conversational(query, conversation_history=prepared.history)
            self._conversation_manager.append_turn(prepared.resolved_session_id, "assistant", answer)
            return RAGServiceResult(
                answer=answer,
                session_id=prepared.resolved_session_id,
                retrieval_results=[],
                retrieval_metadata={
                    "chunks_retrieved": 0,
                    "search_mode": prepared.config.search_mode.value,
                    "casual_intent": True,
                },
            )

        # If this raises (LLMUnavailableError), no assistant turn is
        # ever appended -- the exception propagates unmodified. Note:
        # `generate()` receives the ORIGINAL `query`, never the
        # (possibly follow-up-enriched) retrieval query -- the
        # enrichment is retrieval-only, exactly as required.
        #
        # Stage 8: `generate()` now returns a `GenerationResult` (answer +
        # an explicit grounding signal) rather than a bare string -- see
        # `app/services/llm_generator.py`'s own module-level Stage 8 note.
        generation_result = self._llm_generator.generate(
            query, prepared.retrieval_results, conversation_history=prepared.history
        )

        # Only reached after successful generation.
        self._conversation_manager.append_turn(prepared.resolved_session_id, "assistant", generation_result.answer)

        retrieval_metadata: dict[str, Any] = {
            "chunks_retrieved": len(prepared.retrieval_results),
            "search_mode": prepared.config.search_mode.value,
        }
        # Stage 8: `grounded` is added ONLY when an explicit True/False
        # signal exists -- `None` (zero-retrieval short-circuit, already
        # unreachable here since retrieval_results is non-empty on this
        # path, or a genuine structured-output format violation) is
        # deliberately OMITTED rather than written as `None`, so Team 4C's
        # own `typeof retrieval_metadata.grounded === "boolean"` check
        # sees a plain absent key -- exactly the same "no explicit
        # signal" shape a backend that doesn't support Stage 8 at all
        # would already produce, per the approved "suppress citations
        # only on explicit signal" design.
        if generation_result.grounded is not None:
            retrieval_metadata["grounded"] = generation_result.grounded

        return RAGServiceResult(
            answer=generation_result.answer,
            session_id=prepared.resolved_session_id,
            retrieval_results=prepared.retrieval_results,
            retrieval_metadata=retrieval_metadata,
        )

    def handle_query_stream(
        self,
        query: str,
        *,
        workspace_id: str,
        session_id: str | None = None,
        retrieval_config: RetrievalConfig | None = None,
    ) -> Iterator[StreamDelta | RAGServiceResult]:
        """Stage 9B -- streaming counterpart to `handle_query()`. Yields
        zero or more `StreamDelta` events carrying successive answer-text
        fragments, followed by EXACTLY ONE final `RAGServiceResult` once
        generation completes -- the exact same contract
        `LLMGenerator.generate_stream()` itself follows, one level up.

        All pre-generation work (`_prepare_query()`: history read, user-
        turn persistence, the casual-intent gate, follow-up enrichment,
        retrieval) runs SYNCHRONOUSLY as part of THIS call, before any
        iterator is returned -- so `VectorStoreUnavailableError` /
        `ConversationStoreUnavailableError` raise immediately from this
        call, exactly like `handle_query()`, never deferred into the
        returned iterator. Only `LLMUnavailableError` (a failure in the
        generation phase itself) is raised lazily, when the returned
        iterator is actually consumed -- an inherent property of
        streaming the generation phase specifically.
        """

        prepared = self._prepare_query(
            query, workspace_id=workspace_id, session_id=session_id, retrieval_config=retrieval_config
        )

        if prepared.is_casual:
            return self._stream_casual_result(query, prepared)

        return self._stream_generated_result(query, prepared)

    def _stream_casual_result(self, query: str, prepared: _PreparedQuery) -> Iterator[RAGServiceResult]:
        """A casual reply has nothing to stream token-by-token in this
        orchestrator's own contract (see `LLMGenerator.generate_stream()`'s
        own scope -- it has no casual-reply streaming counterpart either,
        since `generate_conversational()` was never given one); this
        yields the single, already-complete `RAGServiceResult`, matching
        `handle_query()`'s own casual-path result exactly.
        """

        answer = self._llm_generator.generate_conversational(query, conversation_history=prepared.history)
        self._conversation_manager.append_turn(prepared.resolved_session_id, "assistant", answer)
        yield RAGServiceResult(
            answer=answer,
            session_id=prepared.resolved_session_id,
            retrieval_results=[],
            retrieval_metadata={
                "chunks_retrieved": 0,
                "search_mode": prepared.config.search_mode.value,
                "casual_intent": True,
            },
        )

    def _stream_generated_result(self, query: str, prepared: _PreparedQuery) -> Iterator[StreamDelta | RAGServiceResult]:
        for event in self._llm_generator.generate_stream(
            query, prepared.retrieval_results, conversation_history=prepared.history
        ):
            if isinstance(event, StreamDelta):
                yield event
                continue

            # The final GenerationResult -- only reached once generation
            # (or the zero-retrieval short-circuit) has fully completed.
            # Only reached after successful generation, mirroring
            # handle_query()'s own "assistant turn persisted only on
            # success" guarantee -- a mid-stream LLMUnavailableError
            # propagates out of the `for` loop above before this point is
            # ever reached, so no assistant turn is appended for it.
            self._conversation_manager.append_turn(prepared.resolved_session_id, "assistant", event.answer)

            retrieval_metadata: dict[str, Any] = {
                "chunks_retrieved": len(prepared.retrieval_results),
                "search_mode": prepared.config.search_mode.value,
            }
            if event.grounded is not None:
                retrieval_metadata["grounded"] = event.grounded

            yield RAGServiceResult(
                answer=event.answer,
                session_id=prepared.resolved_session_id,
                retrieval_results=prepared.retrieval_results,
                retrieval_metadata=retrieval_metadata,
            )
