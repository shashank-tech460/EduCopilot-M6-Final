"""Team 4B FastAPI routes (Tasks 8.1, 9.1, 10.1): the Conversational
Query API, the Evaluation API, and Health/Observability.

    POST /api/v1/query
    GET  /api/v1/sessions/{session_id}/history
    POST /api/v1/sessions/{session_id}/seed
    DELETE /api/v1/sessions/{session_id}
    POST /api/v1/evaluate
    GET  /health
    GET  /metrics

The first three routes are a thin HTTP boundary: they delegate to the already-
approved `RAGService` (Task 7.1) and `ConversationManager` (Task 4.1),
convert the result via `assemble_query_response` (Task 7.2), and map
domain exceptions to HTTP responses. Neither route queries Qdrant,
Redis, or Ollama directly, builds a prompt, executes retrieval, or
assembles/reorders source attributions itself -- all of that remains
exactly where earlier tasks put it.

CALL CHAIN (preserved exactly, not reimplemented):

    HTTP request -> route -> RAGService -> ConversationManager
                                         -> HybridRetriever
                                         -> LLMGenerator
                                         -> response assembly
                                         -> QueryResponse -> HTTP response

ERROR -> HTTP MAPPING (documented decision, since neither official
document prescribes exact status codes): `VectorStoreUnavailableError`,
`LLMUnavailableError`, and `ConversationStoreUnavailableError` all map
to `503 Service Unavailable` -- each represents a downstream dependency
being unreachable, which is exactly what 503 conventionally signals; a
generic message is returned (`{"detail": "..."}`, FastAPI's own
built-in `HTTPException` shape, not a custom envelope) rather than the
raw exception text, so internal connection details are never leaked to
a client. Pydantic/FastAPI's own automatic `422 Unprocessable Entity`
validation handles malformed request bodies without any code here.
A nonexistent session for the history endpoint maps to `404 Not Found`
(see that route's own docstring for why this state is distinguishable
from "existing but empty" even though the latter cannot actually occur
given `ConversationManager`'s real behavior).

TASK 10.1 (`GET /health`, `GET /metrics`): see each route's own
docstring below for exact semantics. Neither route calls
`RAGService.handle_query()`, executes retrieval, or performs LLM
generation -- both are lightweight, read-only, and cannot fail a normal
query (metrics recording in `post_query` is wrapped so it can never
itself raise and break a request; see that route's own comments).
"""

from __future__ import annotations

import itertools
import json
import logging
import time
from typing import Callable, Iterator

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.api.auth_dependency import require_query_identity
from app.api.rate_limit import rate_limited_query_identity
from app.models.evaluation import EvaluationItem, EvaluationResponse
from app.models.query import QueryRequest, QueryResponse
from app.security.service_jwt import ServiceIdentity
from app.services.conversation import (
    ConversationManager,
    ConversationStoreUnavailableError,
    InvalidConversationRoleError,
)
from app.services.evaluation import (
    BatchTooLargeError,
    EvaluationExecutionError,
    EvaluationPersistenceError,
    EvaluationPipeline,
)
from app.services.llm_generator import LLMGenerator, LLMUnavailableError, StreamDelta
from app.services.metrics import MetricsCollector
from app.services.rag_service import RAGService, RAGServiceResult
from app.services.response_assembly import assemble_query_response
from app.services.vector_store import (
    VectorStoreManager,
    VectorStoreUnavailableError,
)

from .dependencies import (
    get_conversation_manager,
    get_evaluation_pipeline,
    get_llm_generator,
    get_metrics_collector,
    get_rag_service,
    get_vector_store_manager,
)

router = APIRouter()
logger = logging.getLogger(__name__)


@router.post("/api/v1/query", response_model=QueryResponse)
def post_query(
    request: QueryRequest,
    rag_service: RAGService = Depends(get_rag_service),
    metrics_collector: MetricsCollector = Depends(get_metrics_collector),
    # SECURITY HARDENING STAGE 1: composes the existing auth check with a
    # new per-identity rate limit (app/api/rate_limit.py) -- this route
    # drives a real LLM generation per call.
    _identity: ServiceIdentity = Depends(rate_limited_query_identity),
) -> QueryResponse:
    """Answer `request.query`, auto-creating/resolving the session and
    resolving retrieval configuration exactly as `RAGService.handle_query()`
    already does (see that method's own docstring) -- this route adds
    no session-management or configuration-resolution logic of its own.

    MVP M3: `workspace_id` is read EXCLUSIVELY from `_identity` (the
    already-verified internal service JWT, Phase 2B/2E) and passed to
    `rag_service.handle_query()` -- `request` (the canonical
    `{query, session_id, retrieval_config}` body) has no `workspace_id`
    field to read from at all (Phase 2A's frozen contract, unchanged),
    so there is no client-suppliable value that could override it even
    if this route's logic were buggy.

    TASK 10.1: records query timing/count/hit/error into
    `metrics_collector` and logs a single timing line at the end of
    every attempt. The log line intentionally includes ONLY the query
    LENGTH, duration, success/hit flags, and (on failure) the exception
    type name -- never the query text, the answer text, retrieved
    context, or any other user content, per the explicit instruction not
    to log sensitive/user data unnecessarily. Metrics recording itself
    is wrapped so that a bug in the metrics/logging code can never turn
    an otherwise-successful query into a failed HTTP response.
    """

    start_time = time.monotonic()
    succeeded = False
    hit = False
    rag_result = None

    try:
        rag_result = rag_service.handle_query(
            request.query,
            workspace_id=_identity.workspace_id,
            session_id=request.session_id,
            retrieval_config=request.retrieval_config,
        )
        succeeded = True
        hit = rag_result.retrieval_metadata.get("chunks_retrieved", 0) > 0

    except VectorStoreUnavailableError as exc:
        logger.exception(
            "Vector store operation failed during query handling"
        )
        _record_query_metrics(
            metrics_collector,
            start_time,
            succeeded=False,
            hit=False,
            error_type=type(exc).__name__,
        )
        raise HTTPException(
            status_code=503,
            detail="Vector store is currently unavailable.",
        ) from exc

    except LLMUnavailableError as exc:
        logger.exception(
            "LLM generation failed during query handling"
        )
        _record_query_metrics(
            metrics_collector,
            start_time,
            succeeded=False,
            hit=False,
            error_type=type(exc).__name__,
        )
        raise HTTPException(
            status_code=503,
            detail="Language model service is currently unavailable.",
        ) from exc

    except ConversationStoreUnavailableError as exc:
        logger.exception(
            "Conversation store operation failed during query handling"
        )
        _record_query_metrics(
            metrics_collector,
            start_time,
            succeeded=False,
            hit=False,
            error_type=type(exc).__name__,
        )
        raise HTTPException(
            status_code=503,
            detail="Conversation store is currently unavailable.",
        ) from exc

    except HTTPException:
        raise

    except Exception as exc:
        logger.exception(
            "Unexpected error during query handling"
        )
        _record_query_metrics(
            metrics_collector,
            start_time,
            succeeded=False,
            hit=False,
            error_type=type(exc).__name__,
        )
        raise HTTPException(
            status_code=500,
            detail="An unexpected error occurred while processing the query.",
        ) from exc

    _record_query_metrics(
        metrics_collector,
        start_time,
        succeeded=succeeded,
        hit=hit,
        error_type=None,
    )
    return assemble_query_response(rag_result)


@router.post("/api/v1/query/stream")
def post_query_stream(
    request: QueryRequest,
    rag_service: RAGService = Depends(get_rag_service),
    metrics_collector: MetricsCollector = Depends(get_metrics_collector),
    # SECURITY HARDENING STAGE 1: see post_query's identical comment above.
    _identity: ServiceIdentity = Depends(rate_limited_query_identity),
) -> StreamingResponse:
    """Stage 9B -- streaming counterpart to `POST /api/v1/query` above.

    ADDITIVE ONLY: `post_query()` above is completely unmodified -- same
    function, same behavior, same response model -- so every existing
    caller (the evaluation pipeline, this project's own non-streaming
    tests) is entirely unaffected. This is a separate route for callers
    that want real, token-by-token delivery instead.

    WIRE FORMAT: newline-delimited JSON (NDJSON), one object per line,
    `Content-Type: application/x-ndjson`:
        {"type": "delta", "text": "..."}  -- zero or more, in arrival order
        {"type": "done", "answer": ..., "session_id": ..., "source_attributions": [...], "retrieval_metadata": {...}}
            -- exactly one, always last on success (the exact same
            `QueryResponse` shape `post_query()` returns as its whole
            body, just delivered as the stream's final line instead)
        {"type": "error", "detail": "..."} -- instead of "done", only if
            generation itself fails after streaming has already started

    STATUS-CODE HONESTY (a real, disclosed trade-off of streaming, not
    an oversight): `RAGService.handle_query_stream()`'s own
    PRE-generation work (session/history read, the casual-intent gate,
    retrieval) runs SYNCHRONOUSLY as part of the call below, so a
    `VectorStoreUnavailableError`/`ConversationStoreUnavailableError`
    from that phase still maps to the EXACT SAME 503 `post_query()`
    itself returns, BEFORE any 200/streaming response is ever committed
    -- no regression for those failure classes. This route additionally
    "primes" the returned event iterator by pulling exactly one item
    from it before constructing the `StreamingResponse` (see the
    `next(events, _NO_EVENTS)` call below): since `LLMGenerator.
    generate_stream()`'s own first real work (opening the Ollama HTTP
    connection) happens before its first `yield`, an Ollama that's
    unreachable from the very start of a request is ALSO still caught
    here and mapped to the same 503 `post_query()` would raise for an
    `LLMUnavailableError` -- not merely an in-band error line. Only a
    genuinely MID-generation failure (Ollama's connection drops after
    some tokens were already produced) can no longer be reported as a
    distinct HTTP status, because the 200 status is unavoidably already
    committed to the client by that point -- this is an inherent
    constraint of HTTP streaming (the same trade-off every streaming
    LLM API makes), not something this route's own logic could avoid;
    that one case is reported as an in-band `{"type": "error"}` line,
    which Team 4C's client treats identically to this route's own 503.
    """

    start_time = time.monotonic()

    try:
        events: Iterator[StreamDelta | RAGServiceResult] = rag_service.handle_query_stream(
            request.query,
            workspace_id=_identity.workspace_id,
            session_id=request.session_id,
            retrieval_config=request.retrieval_config,
        )
        _NO_EVENTS = object()
        first_event = next(events, _NO_EVENTS)
    except VectorStoreUnavailableError as exc:
        logger.exception("Vector store operation failed during streaming query handling")
        raise HTTPException(status_code=503, detail="Vector store is currently unavailable.") from exc
    except ConversationStoreUnavailableError as exc:
        logger.exception("Conversation store operation failed during streaming query handling")
        raise HTTPException(status_code=503, detail="Conversation store is currently unavailable.") from exc
    except LLMUnavailableError as exc:
        logger.exception("LLM generation failed during streaming query handling (before any output was sent)")
        raise HTTPException(status_code=503, detail="Language model service is currently unavailable.") from exc

    primed_events: Iterator[StreamDelta | RAGServiceResult] = (
        iter(()) if first_event is _NO_EVENTS else itertools.chain([first_event], events)
    )

    def ndjson_lines() -> Iterator[str]:
        succeeded = False
        hit = False
        try:
            for event in primed_events:
                if isinstance(event, RAGServiceResult):
                    succeeded = True
                    hit = event.retrieval_metadata.get("chunks_retrieved", 0) > 0
                    payload = assemble_query_response(event)
                    yield json.dumps({"type": "done", **payload.model_dump()}) + "\n"
                else:
                    yield json.dumps({"type": "delta", "text": event.text}) + "\n"
        except LLMUnavailableError:
            # Reached only for a MID-generation failure -- see this
            # route's own docstring's "status-code honesty" note. The
            # 200 status is already committed by this point; this is
            # the one failure class that can only be reported in-band.
            logger.exception("LLM generation failed during streaming query handling (mid-stream)")
            yield json.dumps({"type": "error", "detail": "Language model service is currently unavailable."}) + "\n"
        except Exception:  # noqa: BLE001 -- any other mid-stream failure is reported uniformly, never leaked raw
            logger.exception("Unexpected error during streaming query handling (mid-stream)")
            yield json.dumps({"type": "error", "detail": "An unexpected error occurred while processing the query."}) + "\n"
        finally:
            _record_query_metrics(
                metrics_collector,
                start_time,
                succeeded=succeeded,
                hit=hit,
                error_type=None if succeeded else "stream_error",
            )

    return StreamingResponse(ndjson_lines(), media_type="application/x-ndjson")


def _record_query_metrics(
    metrics_collector: MetricsCollector,
    start_time: float,
    *,
    succeeded: bool,
    hit: bool,
    error_type: str | None,
) -> None:
    """Records timing/count/hit/error and logs one timing line. Wrapped
    in its own try/except so that ANY failure here (a bug in this code,
    an unexpected exception from the collector) is logged and swallowed
    rather than turning an already-successful query into a 500 -- per
    the explicit instruction that observability code must be
    non-critical to core query execution.
    """

    duration_seconds = time.monotonic() - start_time

    try:
        metrics_collector.record_query(
            duration_seconds=duration_seconds,
            succeeded=succeeded,
            hit=hit,
        )
        logger.info(
            "Query processed",
            extra={
                "duration_seconds": duration_seconds,
                "succeeded": succeeded,
                "hit": hit,
                "error_type": error_type,
            },
        )

    except Exception:  # noqa: BLE001 -- observability must never break a request
        logger.warning(
            "Failed to record query metrics",
            exc_info=True,
        )


class HistoryTurn(BaseModel):
    """Minimal API representation of one stored conversation turn.

    Deliberately not `ConversationTurn` itself (a plain dataclass, not a
    Pydantic model, and an internal component type from Task 4.1) --
    this is the smallest sensible, genuinely-Pydantic shape for HTTP/
    OpenAPI purposes, carrying exactly the three fields the official
    specification actually stores: role, content, timestamp. No other
    fields are added.
    """

    role: str
    content: str
    timestamp: float


class SessionHistoryResponse(BaseModel):
    """Minimal API response for GET history: the session_id echoed back
    plus the COMPLETE (never windowed) stored history, in original
    chronological order -- exactly what `ConversationManager.get_history()`
    already returns, serialized. No official Pydantic model for this
    response exists in Task 1.2's contract (only `QueryResponse` and
    `SourceAttribution` are specified there), so this is a Task 8.1-local
    addition, kept intentionally minimal per the explicit instruction not
    to invent an elaborate schema.
    """

    session_id: str
    history: list[HistoryTurn]


@router.get(
    "/api/v1/sessions/{session_id}/history",
    response_model=SessionHistoryResponse,
)
def get_session_history(
    session_id: str,
    conversation_manager: ConversationManager = Depends(
        get_conversation_manager
    ),
    _identity: ServiceIdentity = Depends(require_query_identity),
) -> SessionHistoryResponse:
    """Return the complete stored conversation history for `session_id`,
    in original chronological order -- never the configured 5-turn
    prompting window (`get_windowed_history`, used only internally by
    `RAGService`/`LLMGenerator`). Read-only: this route never appends,
    trims, or otherwise mutates stored history.

    Raises `404` if `session_id` has never been created (no Redis key
    exists for it) -- distinguished from "exists but has zero turns",
    a state that cannot actually be produced by `ConversationManager`'s
    own API (a session's Redis key is only ever created by
    `append_turn`, which always adds at least one turn in the same
    operation), but the check is implemented as the philosophically
    correct one regardless, per the explicit instruction not to assume
    an empty result means the session exists.

    STEP 2 REMEDIATION: previously the ONLY internal-service route with
    no authentication at all -- gated by the same `require_query_identity`
    JWT dependency as `/query` and `/seed` now, for the identical reason:
    a conversation's full history (both the student's question and the
    assistant's answer) is exactly as sensitive as the live query path
    that produces it, and should never have been reachable by an
    unauthenticated caller merely because that caller knows/guesses a
    session_id.
    """

    try:
        exists = conversation_manager.session_exists(session_id)
    except ConversationStoreUnavailableError as exc:
        raise HTTPException(
            status_code=503,
            detail="Conversation store is currently unavailable.",
        ) from exc

    if not exists:
        raise HTTPException(
            status_code=404,
            detail=f"Session {session_id!r} was not found.",
        )

    try:
        turns = conversation_manager.get_history(session_id)
    except ConversationStoreUnavailableError as exc:
        raise HTTPException(
            status_code=503,
            detail="Conversation store is currently unavailable.",
        ) from exc

    return SessionHistoryResponse(
        session_id=session_id,
        history=[
            HistoryTurn(
                role=turn.role,
                content=turn.content,
                timestamp=turn.timestamp,
            )
            for turn in turns
        ],
    )


class SeedTurn(BaseModel):
    """One historical turn a caller wants restored into a missing/expired
    Redis session. `timestamp` is optional (unlike `HistoryTurn`, which
    always echoes a real stored value back) -- a caller restoring from its
    own durable store (Team 4C's MongoDB) has a real original timestamp to
    supply and should; `None` falls back to `ConversationManager`'s own
    clock, exactly like `append_turn`'s existing default.
    """

    role: str
    content: str
    timestamp: float | None = None


class SeedSessionRequest(BaseModel):
    """Request body for `POST /api/v1/sessions/{session_id}/seed`. `turns`
    should be in chronological (oldest-first) order -- the same order
    `append_turn` is called in, which is what determines the restored
    session's actual ordering (Redis list append order, not the
    `timestamp` field itself -- see `ConversationManager._read_range`).
    """

    turns: list[SeedTurn]


class SeedSessionResponse(BaseModel):
    """Response for the seed endpoint. `seeded=False` is an ordinary,
    successful outcome (the session already existed, or a concurrent seed
    was already in flight) -- not an error -- see
    `ConversationManager.seed_history`'s own docstring.
    """

    session_id: str
    seeded: bool
    turn_count: int


@router.post(
    "/api/v1/sessions/{session_id}/seed",
    response_model=SeedSessionResponse,
)
def post_seed_session(
    session_id: str,
    request: SeedSessionRequest,
    conversation_manager: ConversationManager = Depends(get_conversation_manager),
    _identity: ServiceIdentity = Depends(require_query_identity),
) -> SeedSessionResponse:
    """Restore a missing/expired Redis session from caller-supplied
    history (Requirement 4/5's Redis TTL means a long-idle conversation's
    context is otherwise silently lost -- Team 4C's MongoDB is the durable
    system of record this restores FROM).

    SECURITY: gated by the exact same internal-service-JWT dependency as
    `POST /api/v1/query` (`require_query_identity`) -- this is
    deliberately NOT a public/unauthenticated endpoint, unlike
    `GET /sessions/{id}/history` above (a pre-existing, separate route
    this task does not touch). Only a caller holding a valid, correctly-
    scoped internal service JWT can seed a session.

    IDEMPOTENT / CONCURRENCY-SAFE: delegates entirely to
    `ConversationManager.seed_history()` (see its own docstring for the
    Redis-lock mechanism) -- this route adds no locking, retry, or
    session-existence logic of its own. Never duplicates turns into an
    already-populated session, and is safe to call repeatedly or from
    multiple concurrent requests for the same `session_id`.

    Does not call `RAGService`, execute retrieval, or perform LLM
    generation -- this is a pure history-restoration write, not a query.
    """

    try:
        seeded = conversation_manager.seed_history(
            session_id,
            [(turn.role, turn.content, turn.timestamp) for turn in request.turns],  # type: ignore[misc]
        )
    except InvalidConversationRoleError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except ConversationStoreUnavailableError as exc:
        raise HTTPException(
            status_code=503,
            detail="Conversation store is currently unavailable.",
        ) from exc

    return SeedSessionResponse(
        session_id=session_id,
        seeded=seeded,
        turn_count=len(request.turns),
    )


class DeleteSessionResponse(BaseModel):
    """STEP 3 REMEDIATION response for `DELETE /api/v1/sessions/{id}`.
    `deleted=False` is an ordinary, successful outcome (there was no
    session to delete) -- not an error -- mirroring `SeedSessionResponse`'s
    own `seeded` field's same convention.
    """

    session_id: str
    deleted: bool


@router.delete(
    "/api/v1/sessions/{session_id}",
    response_model=DeleteSessionResponse,
)
def delete_session(
    session_id: str,
    conversation_manager: ConversationManager = Depends(get_conversation_manager),
    _identity: ServiceIdentity = Depends(require_query_identity),
) -> DeleteSessionResponse:
    """STEP 3 REMEDIATION: delete `session_id`'s stored Redis history --
    best-effort cleanup support for Team 4C deleting a Conversation (a
    later stage wires the actual caller; this route is the Team 4B-side
    primitive it will use).

    SECURITY: gated by the same internal-service-JWT dependency as
    `/query`/`/seed`/`/history` -- never a public/unauthenticated
    endpoint.

    Delegates entirely to `ConversationManager.delete_session()` (exact-
    key deletion, see its own docstring) -- this route adds no filtering,
    pattern, or bulk-delete logic of its own, and can only ever remove
    the one named session. Deleting a session that doesn't exist is a
    safe, ordinary no-op (`deleted: false`), not a 404 -- the caller's
    own intent ("this session should not exist anymore") is already
    satisfied either way.
    """

    try:
        deleted = conversation_manager.delete_session(session_id)
    except ConversationStoreUnavailableError as exc:
        raise HTTPException(
            status_code=503,
            detail="Conversation store is currently unavailable.",
        ) from exc

    return DeleteSessionResponse(session_id=session_id, deleted=deleted)


@router.post(
    "/api/v1/evaluate",
    response_model=EvaluationResponse,
)
def post_evaluate(
    items: list[EvaluationItem],
    evaluation_pipeline: EvaluationPipeline = Depends(
        get_evaluation_pipeline
    ),
    _identity: ServiceIdentity = Depends(rate_limited_query_identity),
) -> EvaluationResponse:
    """ADDED IN TASK 9.1. Evaluate a batch of caller-supplied
    query/response/context triples via RAGAS (Requirement 8). Does NOT
    execute retrieval, generation, or any part of the normal RAG query
    path -- `items` are the complete, self-contained evaluation input.

    SECURITY HARDENING STAGE 1: previously had NO authentication
    dependency at all -- the only route in this file in that state.
    Gated with the SAME `require_query_identity` every other route here
    already uses, now composed with a rate limit too
    (`rate_limited_query_identity`, app/api/rate_limit.py) since this
    route can drive a real RAGAS/embedding batch per call (not a new
    "evaluate" scope): this system has exactly
    one internal-service scope for Team 4B ("query"), already shared by
    `/query`, `/query/stream`, and every `/sessions/*` route, and nothing
    about batch evaluation needs a narrower one.

    The request body is a raw JSON array (`list[EvaluationItem]`), not
    an envelope object -- neither official document describes an
    envelope, so the simplest shape matching "a batch of triples" is
    used. Batch-size validation (`Settings.evaluation_batch_max_size`,
    default 50) happens inside `EvaluationPipeline.evaluate_batch()`
    before any evaluation is attempted; `BatchTooLargeError` maps to
    `422` here, consistent with FastAPI/Pydantic's own automatic
    validation semantics for oversized/malformed input. A persistence
    failure maps to `503`, since Requirement 8 requires timestamped
    storage as part of the contract. A total evaluator failure
    (`EvaluationExecutionError` -- the underlying RAGAS/LLM/embeddings
    stack unreachable or erroring, distinct from a per-metric failure
    within an otherwise-successful item, which never raises at all)
    also maps to `503`.
    """

    try:
        return evaluation_pipeline.evaluate_batch(items)

    except BatchTooLargeError as exc:
        raise HTTPException(
            status_code=422,
            detail=str(exc),
        ) from exc

    except EvaluationPersistenceError as exc:
        raise HTTPException(
            status_code=503,
            detail="Evaluation result storage is currently unavailable.",
        ) from exc

    except EvaluationExecutionError as exc:
        raise HTTPException(
            status_code=503,
            detail="Evaluation service is currently unavailable.",
        ) from exc


class ComponentHealth(BaseModel):
    """Minimal per-component health representation for `GET /health`.
    No official Pydantic model for this exists in Task 1.2's contract,
    so this is a Task 10.1-local addition, kept intentionally minimal.
    """

    status: str  # "healthy" | "unavailable"
    detail: str | None = None


class HealthResponse(BaseModel):
    """`GET /health`'s response: an overall status plus one
    `ComponentHealth` per required component (rag, vector_store, redis,
    llm) -- Requirement 9's own four named components, exactly.
    """

    status: str  # "healthy" | "degraded"
    components: dict[str, ComponentHealth]


def _check_component(
    check_fn: Callable[[], bool],
) -> ComponentHealth:
    """Runs one component's health check, tolerating ANY failure mode:
    a `False` return value, or the check itself raising. Never lets an
    exception from a health check propagate and break the `/health`
    endpoint -- per the explicit requirement that "health endpoint
    remains stable when a dependency check raises an exception."
    """

    try:
        return (
            ComponentHealth(status="healthy")
            if check_fn()
            else ComponentHealth(
                status="unavailable",
                detail="Health check reported the component as unavailable.",
            )
        )

    except Exception as exc:  # noqa: BLE001 -- any failure means "unavailable", never a crash
        return ComponentHealth(
            status="unavailable",
            detail=f"Health check raised {type(exc).__name__}.",
        )


@router.get("/health", response_model=HealthResponse)
def get_health(
    vector_store: VectorStoreManager = Depends(get_vector_store_manager),
    conversation_manager: ConversationManager = Depends(
        get_conversation_manager
    ),
    llm_generator: LLMGenerator = Depends(get_llm_generator),
) -> HealthResponse:
    """Reports the health of Requirement 9's four required components:
    `rag`, `vector_store`, `redis`, `llm`. Always returns HTTP 200 --
    failures are represented IN THE BODY (per-component `"unavailable"`
    status, plus an overall `"degraded"` status when any component is
    down), never hidden behind an unconditional "everything is fine."
    This is a documented decision (neither official document prescribes
    an HTTP status-code contract for `/health`): a `503` here could
    cause infrastructure (e.g. a load balancer or orchestrator) to kill
    an otherwise-healthy application process merely because one
    downstream dependency is temporarily degraded, which is a stronger
    and more destructive action than this task's own requirement (accurate
    component-level reporting) calls for.

    "rag" HEALTH, EXPLAINED (fixed during this task's own review -- see
    below for why the first version of this was wrong): "rag" is a
    DERIVED rollup of the other three, not an independent probe of its
    own -- there is no separate external "RAG service" to check (per
    the explicit instruction not to invent one). It is `"healthy"` only
    when `vector_store`, `redis`, AND `llm` are ALL healthy, because
    `RAGService.handle_query()`'s actual implementation (Task 7.1)
    genuinely requires all three to succeed: it calls
    `ConversationManager.append_turn()` (Redis) unconditionally before
    retrieval (`vector_store`) or generation (`llm`) are even attempted,
    so a real query fails end-to-end if ANY of the three is down --
    "rag" reporting that accurately is the whole point of naming it as
    its own required component, distinct from redundantly repeating one
    of the other three.

    An EARLIER VERSION OF THIS FUNCTION reported "rag" as unconditionally
    `"healthy"` on the reasoning that "reaching this function's body at
    all means the RAGService dependency graph was constructed
    successfully." That reasoning is correct but the conclusion is not
    useful: since none of `RAGService`'s constituent components open a
    network connection at construction time (confirmed by inspecting
    each `__init__`), that check could NEVER fail here regardless of
    whether Qdrant/Redis/Ollama were actually reachable -- making "rag"
    tautological and non-diagnostic in every real scenario. Fixed here
    to be a genuine, meaningful signal instead.

    Lightweight and read-only: no LLM generation, no retrieval, no
    Qdrant/Redis writes -- each check is a single cheap call
    (`VectorStoreManager.check_health()`, `ConversationManager.check_health()`,
    `LLMGenerator.check_health()`), documented in their own modules.
    """

    dependency_components = {
        "vector_store": _check_component(vector_store.check_health),
        "redis": _check_component(conversation_manager.check_health),
        "llm": _check_component(llm_generator.check_health),
    }

    rag_healthy = all(
        component.status == "healthy"
        for component in dependency_components.values()
    )

    rag_component = (
        ComponentHealth(status="healthy")
        if rag_healthy
        else ComponentHealth(
            status="unavailable",
            detail=(
                "RAGService requires vector_store, redis, and llm "
                "to all be healthy; at least one is not."
            ),
        )
    )

    components = {
        "rag": rag_component,
        **dependency_components,
    }

    overall_status = (
        "healthy"
        if all(
            component.status == "healthy"
            for component in components.values()
        )
        else "degraded"
    )

    return HealthResponse(
        status=overall_status,
        components=components,
    )


class MetricsResponse(BaseModel):
    """`GET /metrics`'s response. No official Pydantic model exists for
    this in Task 1.2's contract, so this is a Task 10.1-local addition,
    kept to exactly the four fields Requirement 9 names: query count,
    average latency, hit rate, error rate. See `app/services/metrics.py`
    for exact semantics and zero-query behavior.
    """

    query_count: int
    average_latency_seconds: float | None
    hit_rate: float | None
    error_rate: float | None


@router.get(
    "/metrics",
    response_model=MetricsResponse,
)
def get_metrics(
    metrics_collector: MetricsCollector = Depends(get_metrics_collector),
) -> MetricsResponse:
    """Returns real, accumulated query-processing metrics (see
    `app/services/metrics.py`'s module docstring for exact semantics) --
    never fabricated/static values. Lightweight and read-only: reads an
    in-memory snapshot, executes no query, no retrieval, no LLM call.
    """

    snapshot = metrics_collector.snapshot()

    return MetricsResponse(
        query_count=snapshot.query_count,
        average_latency_seconds=snapshot.average_latency_seconds,
        hit_rate=snapshot.hit_rate,
        error_rate=snapshot.error_rate,
    )