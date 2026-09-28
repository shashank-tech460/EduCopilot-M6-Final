"""Stage 3 -- regression coverage for `app/api/main.py`'s `lifespan`
startup hook (PHASE 5C-2: calls `HybridRetriever.refresh_bm25_corpus()`
once at process startup).

ROOT CAUSE THIS GUARDS (see team4b/data/m6_phase5b_retrieval_reliability_
diagnosis.md and m6_phase5c_retrieval_fix_report.md): before this hook
existed, nothing in the live application ever called
`refresh_bm25_corpus()`, so the BM25 leg was permanently empty in every
deployed process -- degrading hybrid search to semantic-only ranking
within Reciprocal Rank Fusion, which silently caps every candidate's
normalized relevance_score near 0.5 (a single-leg-only RRF contribution
against a 2-leg maximum), pushing genuinely relevant candidates below the
default 0.3 score_threshold for weaker/shorter query phrasings. This was
one of two confirmed contributing mechanisms behind the historically
reported "F1" zero-citation failures.

No existing test in this project exercised `lifespan` at all (every
`test_api.py` test constructs `TestClient(app)` without the `with`
context manager that triggers FastAPI/Starlette lifespan events, and
overrides `get_rag_service` directly rather than `get_hybrid_retriever`)
-- so a future accidental removal of this startup call would regress F1
silently, with every existing test suite still green. This file closes
that specific gap.

`lifespan()` calls `get_hybrid_retriever()` as a plain function call, not
through FastAPI's `Depends()` resolution -- `app.dependency_overrides`
only intercepts request-time dependency resolution, so it cannot reach
this call (confirmed directly: an earlier version of this test used
`dependency_overrides` and the fake was never invoked). The fake is
therefore installed via `unittest.mock.patch` on the exact name
`lifespan()` looks up (`app.api.main.get_hybrid_retriever`, the name as
imported into this module's own namespace).
"""

from __future__ import annotations
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.api.main import create_app


class _FakeHybridRetrieverForLifespan:
    """Minimal stand-in exposing only what `lifespan` calls -- no real
    Qdrant/BM25/embedder construction, matching this project's existing
    convention of never requiring live infra for a unit test."""

    def __init__(self, *, raises: bool = False) -> None:
        self.refresh_calls = 0
        self._raises = raises

    def refresh_bm25_corpus(self) -> int:
        self.refresh_calls += 1
        if self._raises:
            raise RuntimeError("simulated Qdrant scroll failure")
        return 42


def test_lifespan_refreshes_the_bm25_corpus_exactly_once_at_startup():
    fake_retriever = _FakeHybridRetrieverForLifespan()
    app = create_app()

    with patch("app.api.main.get_hybrid_retriever", return_value=fake_retriever):
        with TestClient(app):
            pass

    assert fake_retriever.refresh_calls == 1


def test_a_failed_startup_refresh_does_not_prevent_the_app_from_starting():
    """PHASE 5C-2's own documented contract: BM25 is a ranking-quality
    enhancement, not an availability dependency -- a refresh failure at
    startup must be logged and swallowed, never crash the app."""

    fake_retriever = _FakeHybridRetrieverForLifespan(raises=True)
    app = create_app()

    with patch("app.api.main.get_hybrid_retriever", return_value=fake_retriever):
        with TestClient(app) as client:
            response = client.get("/openapi.json")

    assert response.status_code == 200
    assert fake_retriever.refresh_calls == 1
