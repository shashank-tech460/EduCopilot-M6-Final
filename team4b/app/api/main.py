"""Team 4B FastAPI application entry point (Tasks 8.1, 9.1).

Minimal application factory + module-level `app` instance for
`uvicorn app.api.main:app`. Registers Task 8.1's two routes
(`POST /api/v1/query`, `GET /api/v1/sessions/{session_id}/history`) and
Task 9.1's evaluation route (`POST /api/v1/evaluate`) -- no `/health` or
`/metrics` (Task 10.1), and no Docker/deployment configuration (Task
11.1). Those are explicitly out of scope and are not added here as
placeholders.

PHASE 5C-2 ADDITION -- BM25 startup lifecycle: `HybridRetriever.
refresh_bm25_corpus()` has existed since Task 3.2 but was never called
by anything in the live application (see
`team4b/data/m6_phase5b_retrieval_reliability_diagnosis.md` -- confirmed
by static analysis of every route/dependency in this app AND by log
evidence: the BM25 corpus was permanently empty in every deployed
Team4A/4B process this whole engagement). `lifespan` below calls it
exactly once, synchronously, before the app starts accepting requests,
against the SAME cached `HybridRetriever` instance every query request
already uses (`app.api.dependencies.get_hybrid_retriever()`) -- no new
BM25 implementation, no duplicated wiring, no change to tokenization,
ranking, or RRF math. Deliberately non-fatal on failure: BM25 is a
ranking-quality enhancement to hybrid search, not an availability
dependency (the same principle already established for the optional
reranker -- see `HybridRetriever._finalize_results()`'s own docstring).
A refresh failure is logged clearly and the application still starts;
hybrid mode simply continues running as it always has (semantic-leg-only
ranking within RRF fusion) until a later successful refresh, rather than
never even attempting one.
"""

from __future__ import annotations

import logging
import time
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.dependencies import get_hybrid_retriever
from app.api.routes import router
from app.core.config import get_settings

# PHASE 5C-2: `logging.basicConfig()` is a no-op if the root logger
# already has a handler configured (its own documented behavior) --
# this only takes effect when NOTHING else in the process has already
# set one up (confirmed: no other module in this app calls basicConfig/
# dictConfig anywhere). Without this, every `logger.info(...)` call in
# the whole application -- not only this module's new startup log --
# was silently dropped by Python's default "last resort" handler, which
# only surfaces WARNING and above. This is why the BM25-refresh success
# log line was invisible even though the refresh itself was running;
# it does not change what is logged, only whether INFO-level messages
# that were always being emitted are actually visible.
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """PHASE 5C-2: populate the BM25 corpus once at process startup.

    Runs synchronously before `yield` (i.e. before uvicorn reports the
    app as ready and starts accepting requests) -- there is no
    concurrent request traffic yet for a blocking call to contend with,
    the same reasoning every other startup-time initialization in a
    FastAPI `lifespan` handler relies on. See this module's own
    docstring for why a failure here does not prevent startup.
    """

    retriever = get_hybrid_retriever()
    started = time.monotonic()
    try:
        chunk_count = retriever.refresh_bm25_corpus()
    except Exception as exc:  # noqa: BLE001 -- startup must never crash on this; see module docstring
        elapsed = time.monotonic() - started
        logger.error(
            "Startup BM25 corpus refresh failed -- continuing with an empty BM25 corpus; "
            "hybrid search will run as semantic-only until a future successful refresh",
            extra={"elapsed_seconds": round(elapsed, 3), "error": str(exc)},
        )
    else:
        elapsed = time.monotonic() - started
        logger.info(
            "Startup BM25 corpus refresh succeeded",
            extra={"chunk_count": chunk_count, "elapsed_seconds": round(elapsed, 3)},
        )
    yield


def create_app() -> FastAPI:
    """Build a fresh FastAPI application with Task 8.1's routes
    registered. A factory function (rather than only a module-level
    `app`) so tests can construct independent app instances and apply
    their own `dependency_overrides` without interference between
    tests.

    PHASE 5C-2: `lifespan=lifespan` is passed here too (not only used by
    the module-level `app` below), so a test that constructs its own
    `create_app()` and overrides `get_hybrid_retriever` still exercises
    the same startup wiring against its own fake, rather than silently
    skipping it.
    """

    application = FastAPI(title="Team 4B — Advanced RAG & Semantic Search", lifespan=lifespan)
    application.include_router(router)

    # SECURITY HARDENING STAGE 1: explicit, auditable CORS configuration
    # -- see Settings.cors_allowed_origins' own docstring for why this
    # defaults to an empty list (no legitimate browser origin calls this
    # purely internal, service-to-service API directly). An empty
    # `allow_origins` means CORSMiddleware never adds a permissive
    # `Access-Control-Allow-Origin` header, matching this app's
    # pre-existing (unconfigured) behavior exactly -- this makes that a
    # deliberate decision instead of an accidental omission, and gives a
    # real deployment a single, explicit setting to widen if it ever
    # legitimately needs to (never done automatically by this codebase).
    settings = get_settings()
    application.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_allowed_origins,
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    return application


app = create_app()
