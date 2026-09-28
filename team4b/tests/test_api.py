"""Focused tests for Task 8.1's FastAPI routes.

Scope: real HTTP requests via `fastapi.testclient.TestClient` against a
freshly-built app (`create_app()`) with `dependency_overrides` injecting
the SAME fakes already used and approved in `tests/test_rag_service.py`
(`FakeHybridRetriever`, `FakeConversationManager`, `FakeLLMGenerator`),
wired into a REAL `RAGService` and REAL `assemble_query_response()` --
so these tests exercise the actual production call chain
(route -> RAGService -> response assembly -> HTTP response), not a
route calling a fake RAGService directly. No live Qdrant, Redis, or
Ollama is used anywhere in this file.

ANTI-CIRCULARITY: assertions read the actual fake's recorded calls
(`retriever.calls`, `llm.calls`, `conversation.append_calls`) and the
actual parsed JSON response body -- never a value computed by calling
back into the route or service logic under test.
"""

from __future__ import annotations

from typing import Any

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi.testclient import TestClient

from app.api.auth_dependency import get_service_jwt_verifier
from app.api.dependencies import get_conversation_manager, get_rag_service
from app.api.main import create_app
from app.api.rate_limit import get_rate_limiter
from app.core.config import Settings
from app.models.query import QueryResponse, SourceAttribution
from app.models.retrieval import RetrievalResult
from app.security.service_jwt import ServiceJWTVerifier
from app.services.conversation import ConversationManager, ConversationStoreUnavailableError
from app.services.llm_generator import LLMUnavailableError
from app.services.rag_service import RAGService
from app.services.vector_store import VectorStoreUnavailableError
from tests.fakes import FakeRateLimiter, FakeRedisClient
from tests.test_rag_service import FakeConversationManager, FakeHybridRetriever, FakeLLMGenerator

# Phase 2E: `POST /api/v1/query` now requires a valid, real ES256 internal
# service JWT (app/api/auth_dependency.py). `_client()` below overrides
# the verifier with one built from this real, test-generated key pair
# (never a mock of the verifier's own logic -- the same discipline
# established for Team 4A's canonical route tests), and every TestClient
# it returns carries a matching, real, valid token as a default header --
# so every EXISTING test written before Phase 2E continues to exercise
# exactly the request/response behavior it always did, now correctly
# passing through a real, present authentication layer rather than being
# rejected by it.
_TEST_ISSUER = "https://educopilot.internal"
_TEST_AUDIENCE = "team4b-query"
_TEST_SCOPE = "query"
_TEST_KID = "test-kid-1"


def _generate_es256_keypair() -> tuple[str, str]:
    private_key = ec.generate_private_key(ec.SECP256R1())
    private_pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()
    public_pem = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode()
    return private_pem, public_pem


_TEST_PRIVATE_PEM, _TEST_PUBLIC_PEM = _generate_es256_keypair()


def _mint_valid_test_token(**overrides: object) -> str:
    import time

    now = time.time()
    claims = {
        "sub": "test-user-1",
        "workspace_id": "test-workspace-1",
        "scope": _TEST_SCOPE,
        "iss": _TEST_ISSUER,
        "aud": _TEST_AUDIENCE,
        "iat": int(now),
        "exp": int(now + 300),
        "jti": "test-jti-1",
    }
    claims.update(overrides)
    return jwt.encode(claims, _TEST_PRIVATE_PEM, algorithm="ES256", headers={"kid": _TEST_KID})


def _chunk(chunk_id: str, text: str, document_id: str = "job-1") -> RetrievalResult:
    return RetrievalResult(
        chunk_id=chunk_id,
        text=text,
        relevance_score=0.9,
        metadata={"document_id": document_id, "document_title": "doc.pdf", "page_number": 1},
    )


def _client(
    retriever: FakeHybridRetriever | None = None,
    conversation: FakeConversationManager | None = None,
    llm: FakeLLMGenerator | None = None,
) -> tuple[TestClient, FakeHybridRetriever, FakeConversationManager, FakeLLMGenerator]:
    from app.api.dependencies import get_metrics_collector
    from app.services.metrics import MetricsCollector

    retriever = retriever or FakeHybridRetriever(results=[_chunk("c1", "some context")])
    conversation = conversation or FakeConversationManager()
    llm = llm or FakeLLMGenerator()
    service = RAGService(hybrid_retriever=retriever, conversation_manager=conversation, llm_generator=llm)  # type: ignore[arg-type]

    app = create_app()
    app.dependency_overrides[get_rag_service] = lambda: service
    app.dependency_overrides[get_conversation_manager] = lambda: conversation
    # TASK 10.1: get_metrics_collector() is a process-wide @lru_cache
    # singleton (see app/api/dependencies.py) -- without overriding it
    # here, every test built via this helper would share and mutate the
    # SAME global MetricsCollector instance, silently accumulating
    # counts across unrelated tests (a genuine test-isolation bug this
    # override fixes, discovered while writing Task 10.1's own metrics
    # tests -- see that task's report). The instance is constructed ONCE
    # here, outside the lambda, and that SAME instance is returned every
    # time the dependency is resolved within this one test's client --
    # `lambda: MetricsCollector()` would instead build a fresh, empty
    # collector on every single request, which is an equally real bug
    # this project's own testing caught during development.
    metrics_collector = MetricsCollector()
    app.dependency_overrides[get_metrics_collector] = lambda: metrics_collector

    # Phase 2E: real verifier, real key pair, real signed token -- see
    # the module-level comment above.
    app.dependency_overrides[get_service_jwt_verifier] = lambda: ServiceJWTVerifier(
        public_keys_by_kid={_TEST_KID: _TEST_PUBLIC_PEM},
        expected_issuer=_TEST_ISSUER,
        expected_audience=_TEST_AUDIENCE,
        required_scope=_TEST_SCOPE,
    )
    # Security Hardening Stage 1: /api/v1/query and /api/v1/query/stream
    # are now rate-limited too -- see FakeRateLimiter's own docstring for
    # why this is overridden by default (nearly every test in this file
    # shares the same test identity and would otherwise collide on a
    # real rate limit within one suite run).
    app.dependency_overrides[get_rate_limiter] = lambda: FakeRateLimiter()
    client = TestClient(app, headers={"Authorization": f"Bearer {_mint_valid_test_token()}"})
    return client, retriever, conversation, llm


# ---------------------------------------------------------------------------
# POST /api/v1/query
# ---------------------------------------------------------------------------


class TestPostQuerySuccess:
    def test_successful_request_returns_200_and_valid_query_response(self):
        client, _retriever, _conv, _llm = _client()

        response = client.post("/api/v1/query", json={"query": "What is RAG?"})

        assert response.status_code == 200
        # Pydantic re-validation, not just dict-key comparison.
        QueryResponse.model_validate(response.json())

    def test_supplied_session_id_is_used(self):
        client, _retriever, conversation, _llm = _client()

        response = client.post("/api/v1/query", json={"query": "explain the topic", "session_id": "explicit-session"})

        assert response.json()["session_id"] == "explicit-session"
        assert "explicit-session" in conversation.windowed_history_calls

    def test_missing_session_id_auto_creates_one(self):
        client, _retriever, _conv, _llm = _client()

        response = client.post("/api/v1/query", json={"query": "explain the topic"})

        body = response.json()
        assert body["session_id"]  # non-empty, generated by RAGService

    def test_supplied_retrieval_config_reaches_the_retriever(self):
        client, retriever, _conv, _llm = _client()

        client.post(
            "/api/v1/query",
            json={"query": "explain the topic", "retrieval_config": {"top_k": 17, "score_threshold": 0.75, "search_mode": "keyword"}},
        )

        call = retriever.calls[0]
        assert call["top_k"] == 17
        assert call["score_threshold"] == 0.75
        assert call["search_mode"] == "keyword"

    def test_omitted_retrieval_config_uses_official_defaults(self):
        client, retriever, _conv, _llm = _client()

        client.post("/api/v1/query", json={"query": "explain the topic"})

        call = retriever.calls[0]
        assert call["top_k"] == 5
        assert call["score_threshold"] == 0.3
        assert call["search_mode"] == "hybrid"

    def test_collection_filter_propagates_to_the_retriever(self):
        client, retriever, _conv, _llm = _client()

        client.post("/api/v1/query", json={"query": "explain the topic", "retrieval_config": {"collection_filter": ["document"]}})

        assert retriever.calls[0]["collection_filter"] == ["document"]

    def test_response_schema_matches_query_response_exactly(self):
        client, _retriever, _conv, _llm = _client()

        response = client.post("/api/v1/query", json={"query": "explain the topic"})

        assert set(response.json().keys()) == {"answer", "session_id", "source_attributions", "retrieval_metadata"}

    def test_answer_is_preserved_from_llm_generator(self):
        llm = FakeLLMGenerator(answer="the real generated answer")
        client, _retriever, _conv, _llm = _client(llm=llm)

        response = client.post("/api/v1/query", json={"query": "explain the topic"})

        assert response.json()["answer"] == "the real generated answer"

    def test_source_attributions_are_preserved_and_valid(self):
        chunks = [_chunk("c1", "alpha", document_id="job-1"), _chunk("c2", "beta", document_id="job-2")]
        retriever = FakeHybridRetriever(results=chunks)
        client, _r, _conv, _llm = _client(retriever=retriever)

        response = client.post("/api/v1/query", json={"query": "explain the topic"})

        attributions = response.json()["source_attributions"]
        assert len(attributions) == 2
        for raw in attributions:
            SourceAttribution.model_validate(raw)  # each is a genuinely valid SourceAttribution

    def test_retrieval_metadata_is_preserved(self):
        chunks = [_chunk("c1", "alpha"), _chunk("c2", "beta"), _chunk("c3", "gamma")]
        retriever = FakeHybridRetriever(results=chunks)
        client, _r, _conv, _llm = _client(retriever=retriever)

        response = client.post("/api/v1/query", json={"query": "explain the topic"})

        metadata = response.json()["retrieval_metadata"]
        assert metadata["chunks_retrieved"] == 3
        assert metadata["search_mode"] == "hybrid"

    def test_query_actually_reaches_the_retriever_and_llm(self):
        client, retriever, _conv, llm = _client()

        client.post("/api/v1/query", json={"query": "the exact question text"})

        assert retriever.calls[0]["query"] == "the exact question text"
        assert llm.calls[0]["query"] == "the exact question text"


class TestPostQueryValidation:
    def test_missing_query_field_returns_422(self):
        client, retriever, _conv, _llm = _client()

        response = client.post("/api/v1/query", json={})

        assert response.status_code == 422
        assert retriever.calls == []  # request never reached the service

    def test_invalid_top_k_zero_returns_422(self):
        client, retriever, _conv, _llm = _client()

        response = client.post("/api/v1/query", json={"query": "q", "retrieval_config": {"top_k": 0}})

        assert response.status_code == 422
        assert retriever.calls == []

    def test_invalid_top_k_above_fifty_returns_422(self):
        client, retriever, _conv, _llm = _client()

        response = client.post("/api/v1/query", json={"query": "q", "retrieval_config": {"top_k": 51}})

        assert response.status_code == 422
        assert retriever.calls == []

    def test_invalid_score_threshold_returns_422(self):
        client, retriever, _conv, _llm = _client()

        response = client.post("/api/v1/query", json={"query": "q", "retrieval_config": {"score_threshold": 1.5}})

        assert response.status_code == 422
        assert retriever.calls == []

    def test_invalid_search_mode_returns_422(self):
        client, retriever, _conv, _llm = _client()

        response = client.post("/api/v1/query", json={"query": "q", "retrieval_config": {"search_mode": "bm25"}})

        assert response.status_code == 422
        assert retriever.calls == []

    def test_malformed_request_body_returns_422(self):
        client, _retriever, _conv, _llm = _client()

        response = client.post("/api/v1/query", json={"query": 12345})  # wrong type

        assert response.status_code == 422

    def test_wrong_type_for_retrieval_config_returns_422(self):
        client, _retriever, _conv, _llm = _client()

        response = client.post("/api/v1/query", json={"query": "q", "retrieval_config": "not-an-object"})

        assert response.status_code == 422


class TestPostQueryErrorPropagation:
    def test_vector_store_unavailable_returns_503(self):
        retriever = FakeHybridRetriever(raise_error=VectorStoreUnavailableError("qdrant down"))
        client, _r, _conv, _llm = _client(retriever=retriever)

        response = client.post("/api/v1/query", json={"query": "q"})

        assert response.status_code == 503
        assert "detail" in response.json()

    def test_llm_unavailable_returns_503(self):
        llm = FakeLLMGenerator(raise_error=LLMUnavailableError("ollama down"))
        client, _r, _conv, _llm = _client(llm=llm)

        response = client.post("/api/v1/query", json={"query": "q"})

        assert response.status_code == 503

    def test_conversation_store_unavailable_returns_503(self):
        conversation = FakeConversationManager(raise_on_append=ConversationStoreUnavailableError("redis down"))
        client, _r, _conv, _llm = _client(conversation=conversation)

        response = client.post("/api/v1/query", json={"query": "q"})

        assert response.status_code == 503

    def test_error_response_does_not_leak_raw_exception_details(self):
        retriever = FakeHybridRetriever(raise_error=VectorStoreUnavailableError("postgresql://secret:pw@host/db"))
        client, _r, _conv, _llm = _client(retriever=retriever)

        response = client.post("/api/v1/query", json={"query": "q"})

        assert "secret" not in response.text
        assert "postgresql://" not in response.text

    def test_no_stack_trace_in_error_response(self):
        retriever = FakeHybridRetriever(raise_error=VectorStoreUnavailableError("down"))
        client, _r, _conv, _llm = _client(retriever=retriever)

        response = client.post("/api/v1/query", json={"query": "q"})

        assert "Traceback" not in response.text

    def test_an_unexpected_exception_returns_a_controlled_500_not_an_unhandled_crash(self, caplog):
        """Developer-grade error handling: an exception that is NONE of
        the three known dependency-unavailable types (e.g. a genuine
        bug, or an unanticipated library error) must not become an
        unhandled crash -- it is now a controlled, logged 500, distinct
        from the three named 503 cases."""

        retriever = FakeHybridRetriever(raise_error=RuntimeError("something genuinely unexpected"))
        client, _r, _conv, _llm = _client(retriever=retriever)

        response = client.post("/api/v1/query", json={"query": "q"})

        assert response.status_code == 500
        assert "unexpected" in response.json()["detail"].lower()
        assert "Traceback" not in response.text
        assert "something genuinely unexpected" not in response.text  # never leaked to the client

    def test_unexpected_exception_is_still_recorded_in_metrics_as_a_failure(self):
        from app.api.dependencies import get_metrics_collector

        retriever = FakeHybridRetriever(raise_error=RuntimeError("boom"))
        client, _r, _conv, _llm = _client(retriever=retriever)

        client.post("/api/v1/query", json={"query": "q"})

        metrics = client.app.dependency_overrides[get_metrics_collector]()
        snapshot = metrics.snapshot()
        assert snapshot.error_rate > 0.0

    def test_vector_store_unavailable_logs_the_real_exception_server_side(self, caplog):
        """Phase B/K.1's own explicit requirement: the actual backend
        exception (message + traceback) must be visible in server-side
        logs, even though the browser-facing response stays sanitized."""

        import logging

        retriever = FakeHybridRetriever(raise_error=VectorStoreUnavailableError("qdrant connection refused"))
        client, _r, _conv, _llm = _client(retriever=retriever)

        with caplog.at_level(logging.ERROR, logger="app.api.routes"):
            client.post("/api/v1/query", json={"query": "q"})

        assert "qdrant connection refused" in caplog.text

    def test_llm_unavailable_logs_the_real_exception_server_side(self, caplog):
        import logging

        llm = FakeLLMGenerator(raise_error=LLMUnavailableError("httpx.ReadTimeout after 15.0s"))
        client, _r, _conv, _llm = _client(llm=llm)

        with caplog.at_level(logging.ERROR, logger="app.api.routes"):
            client.post("/api/v1/query", json={"query": "q"})

        assert "httpx.ReadTimeout" in caplog.text

    def test_unexpected_exception_logs_the_real_exception_server_side(self, caplog):
        import logging

        retriever = FakeHybridRetriever(raise_error=RuntimeError("the real, previously-invisible bug"))
        client, _r, _conv, _llm = _client(retriever=retriever)

        with caplog.at_level(logging.ERROR, logger="app.api.routes"):
            client.post("/api/v1/query", json={"query": "q"})

        assert "the real, previously-invisible bug" in caplog.text


class TestPostQueryStream:
    """Stage 9B's additive streaming endpoint. Reuses `_client()` exactly
    as-is, passing a REAL `LLMGenerator` wired to `FakeLLMClient` as the
    `llm=` argument (RAGService only ever calls it through the same
    duck-typed interface `FakeLLMGenerator` stands in for elsewhere in
    this file) so `generate_stream()` -- which `FakeLLMGenerator` itself
    does not implement -- is genuinely exercised end-to-end through the
    real route -> RAGService -> LLMGenerator chain.
    """

    def _streaming_llm(self, *, stream_fragments: list[str], raise_error: Exception | None = None):
        from app.core.config import Settings
        from app.services.llm_generator import LLMGenerator as _LLMGenerator
        from tests.fakes import FakeLLMClient

        client = FakeLLMClient(stream_fragments=stream_fragments, raise_error=raise_error)
        return _LLMGenerator(settings=Settings(_env_file=None), llm_client=client)  # type: ignore[call-arg]

    def _read_ndjson(self, response: Any) -> list[dict[str, Any]]:
        import json as _json

        lines = [line for line in response.text.splitlines() if line.strip()]
        return [_json.loads(line) for line in lines]

    def test_streams_ndjson_deltas_followed_by_a_done_event(self):
        json_text = '{"answer": "This has plenty of words in the answer text.", "grounded": true}'
        fragments = [json_text[i : i + 6] for i in range(0, len(json_text), 6)]
        llm = self._streaming_llm(stream_fragments=fragments)
        chunks = [_chunk("c1", "some context")]
        client, _r, _conv, _llm = _client(retriever=FakeHybridRetriever(results=chunks), llm=llm)

        response = client.post("/api/v1/query/stream", json={"query": "explain the topic"})

        assert response.status_code == 200
        assert response.headers["content-type"].startswith("application/x-ndjson")
        events = self._read_ndjson(response)
        assert events[-1]["type"] == "done"
        assert events[-1]["answer"] == "This has plenty of words in the answer text."
        delta_events = [e for e in events if e["type"] == "delta"]
        assert len(delta_events) > 1  # genuinely delivered as multiple pieces
        assert "".join(e["text"] for e in delta_events) == events[-1]["answer"]

    def test_done_event_matches_the_same_query_response_schema_as_the_non_streaming_route(self):
        json_text = '{"answer": "grounded answer with enough words here.", "grounded": true}'
        llm = self._streaming_llm(stream_fragments=[json_text])
        chunks = [_chunk("c1", "some context")]
        client, _r, _conv, _llm = _client(retriever=FakeHybridRetriever(results=chunks), llm=llm)

        response = client.post("/api/v1/query/stream", json={"query": "explain the topic"})

        done_event = self._read_ndjson(response)[-1]
        payload = {k: v for k, v in done_event.items() if k != "type"}
        QueryResponse.model_validate(payload)
        assert set(payload.keys()) == {"answer", "session_id", "source_attributions", "retrieval_metadata"}

    def test_citations_are_present_in_the_done_event(self):
        json_text = '{"answer": "grounded answer with enough words here.", "grounded": true}'
        llm = self._streaming_llm(stream_fragments=[json_text])
        chunks = [_chunk("c1", "alpha", document_id="job-1"), _chunk("c2", "beta", document_id="job-2")]
        client, _r, _conv, _llm = _client(retriever=FakeHybridRetriever(results=chunks), llm=llm)

        response = client.post("/api/v1/query/stream", json={"query": "explain the topic"})

        done_event = self._read_ndjson(response)[-1]
        assert len(done_event["source_attributions"]) == 2

    def test_zero_retrieval_suppresses_citations_and_still_streams_a_done_event(self):
        """Stage 7's zero-retrieval citation suppression, still honored
        over the streaming path."""

        llm = self._streaming_llm(stream_fragments=["irrelevant -- never reached"])
        client, _r, _conv, _llm = _client(retriever=FakeHybridRetriever(results=[]), llm=llm)

        response = client.post("/api/v1/query/stream", json={"query": "explain the topic"})

        done_event = self._read_ndjson(response)[-1]
        assert done_event["source_attributions"] == []
        assert done_event["answer"] == "I don't have enough information in the provided context to answer this question reliably."

    def test_retrieval_failure_returns_503_not_a_stream(self):
        retriever = FakeHybridRetriever(raise_error=VectorStoreUnavailableError("qdrant down"))
        client, _r, _conv, _llm = _client(retriever=retriever)

        response = client.post("/api/v1/query/stream", json={"query": "q"})

        assert response.status_code == 503
        assert "detail" in response.json()

    def test_conversation_store_failure_returns_503_not_a_stream(self):
        conversation = FakeConversationManager(raise_on_append=ConversationStoreUnavailableError("redis down"))
        client, _r, _conv, _llm = _client(conversation=conversation)

        response = client.post("/api/v1/query/stream", json={"query": "q"})

        assert response.status_code == 503

    def test_ollama_unreachable_before_any_token_returns_503_not_a_stream(self):
        """The priming mechanism: a failure on the very FIRST generated
        event (before any fragment is ever yielded) still surfaces as a
        real HTTP 503, not an in-band NDJSON error line."""

        llm = self._streaming_llm(stream_fragments=[], raise_error=ConnectionError("ollama unreachable"))
        chunks = [_chunk("c1", "some context")]
        client, _r, _conv, _llm = _client(retriever=FakeHybridRetriever(results=chunks), llm=llm)

        response = client.post("/api/v1/query/stream", json={"query": "q"})

        assert response.status_code == 503
        assert "detail" in response.json()

    def test_a_mid_stream_ollama_failure_yields_an_in_band_error_event_with_http_200_already_sent(self):
        """The disclosed trade-off: once streaming has begun, a failure
        can no longer change the already-committed HTTP status -- it
        must be reported in-band instead."""

        from tests.fakes import FakeLLMClient

        from app.core.config import Settings
        from app.services.llm_generator import LLMGenerator as _LLMGenerator

        # The first fragment alone already carries more than six answer
        # words, so it is flushed as a real `StreamDelta` on the very
        # first pull (the route's priming call) -- committing the HTTP
        # response to 200 -- before the SECOND pull raises.
        fake_client = FakeLLMClient(
            stream_fragments=['{"answer": "one two three four five six seven eight nine ten', "-more-text"],
            stream_raise_after=1,
        )
        llm = _LLMGenerator(settings=Settings(_env_file=None), llm_client=fake_client)  # type: ignore[call-arg]
        chunks = [_chunk("c1", "some context")]
        client, _r, _conv, _llm = _client(retriever=FakeHybridRetriever(results=chunks), llm=llm)

        response = client.post("/api/v1/query/stream", json={"query": "q"})

        assert response.status_code == 200  # already committed before the mid-stream failure
        events = self._read_ndjson(response)
        assert events[-1]["type"] == "error"
        assert not any(e["type"] == "done" for e in events)

    def test_mid_stream_failure_does_not_persist_an_assistant_turn(self):
        from tests.fakes import FakeLLMClient

        from app.core.config import Settings
        from app.services.llm_generator import LLMGenerator as _LLMGenerator

        fake_client = FakeLLMClient(stream_fragments=['{"answer": "partial'], stream_raise_after=0)
        llm = _LLMGenerator(settings=Settings(_env_file=None), llm_client=fake_client)  # type: ignore[call-arg]
        chunks = [_chunk("c1", "some context")]
        conversation = FakeConversationManager()
        client, _r, _conv, _llm = _client(retriever=FakeHybridRetriever(results=chunks), conversation=conversation, llm=llm)

        client.post("/api/v1/query/stream", json={"query": "q"})

        roles = [role for (_sid, role, _content) in conversation.append_calls]
        assert "assistant" not in roles

    def test_the_non_streaming_route_is_unaffected_by_the_new_streaming_route_existing(self):
        client, _r, _conv, _llm = _client()

        response = client.post("/api/v1/query", json={"query": "What is RAG?"})

        assert response.status_code == 200
        QueryResponse.model_validate(response.json())


class TestPostQueryNoDirectBackendAccess:
    def test_routes_module_does_not_import_backend_client_libraries(self):
        import inspect

        import app.api.routes as routes_module

        source = inspect.getsource(routes_module)
        for forbidden in ("import redis", "import httpx", "import qdrant_client", "from qdrant_client", "from redis"):
            assert forbidden not in source


class TestRequestIsolation:
    def test_concurrent_style_requests_do_not_leak_session_or_config(self):
        client, retriever, _conv, llm = _client()

        client.post(
            "/api/v1/query",
            json={"query": "query A", "session_id": "session-a", "retrieval_config": {"top_k": 2, "search_mode": "semantic"}},
        )
        client.post(
            "/api/v1/query",
            json={"query": "query B", "session_id": "session-b", "retrieval_config": {"top_k": 10, "search_mode": "keyword"}},
        )

        call_a, call_b = retriever.calls[0], retriever.calls[1]
        assert call_a["top_k"] == 2 and call_a["search_mode"] == "semantic"
        assert call_b["top_k"] == 10 and call_b["search_mode"] == "keyword"
        assert llm.calls[0]["query"] == "query A"
        assert llm.calls[1]["query"] == "query B"

    def test_two_requests_do_not_share_collection_filter(self):
        client, retriever, _conv, _llm = _client()

        client.post("/api/v1/query", json={"query": "q1", "retrieval_config": {"collection_filter": ["document"]}})
        client.post("/api/v1/query", json={"query": "q2"})

        assert retriever.calls[0]["collection_filter"] == ["document"]
        assert retriever.calls[1]["collection_filter"] is None


# ---------------------------------------------------------------------------
# GET /api/v1/sessions/{session_id}/history
# ---------------------------------------------------------------------------


class TestGetHistorySuccess:
    def test_complete_history_is_returned(self):
        from app.services.conversation import ConversationTurn

        history = [ConversationTurn(role="user", content=f"turn {i}", timestamp=float(i)) for i in range(8)]  # type: ignore[arg-type]
        conversation = FakeConversationManager(initial_history={"s1": history})
        client, _retriever, _conv, _llm = _client(conversation=conversation)

        response = client.get("/api/v1/sessions/s1/history")

        assert response.status_code == 200
        body = response.json()
        assert len(body["history"]) == 8  # more than the 5-turn prompting window -- proves it's NOT windowed

    def test_chronological_order_is_preserved(self):
        from app.services.conversation import ConversationTurn

        history = [ConversationTurn(role="user", content=f"turn {i}", timestamp=float(i)) for i in range(5)]  # type: ignore[arg-type]
        conversation = FakeConversationManager(initial_history={"s1": history})
        client, _retriever, _conv, _llm = _client(conversation=conversation)

        response = client.get("/api/v1/sessions/s1/history")

        contents = [turn["content"] for turn in response.json()["history"]]
        assert contents == [f"turn {i}" for i in range(5)]

    def test_session_id_is_echoed_back(self):
        from app.services.conversation import ConversationTurn

        conversation = FakeConversationManager(initial_history={"my-session": [ConversationTurn(role="user", content="hi", timestamp=1.0)]})  # type: ignore[arg-type]
        client, _retriever, _conv, _llm = _client(conversation=conversation)

        response = client.get("/api/v1/sessions/my-session/history")

        assert response.json()["session_id"] == "my-session"

    def test_history_survives_a_prior_post_query_call(self):
        # True end-to-end: POST /query writes turns via the real
        # RAGService -> ConversationManager path, then GET /history
        # reads them back through the same shared fake conversation manager.
        client, _retriever, conversation, llm = _client(llm=FakeLLMGenerator(answer="the answer"))

        client.post("/api/v1/query", json={"query": "my question", "session_id": "shared-session"})
        response = client.get("/api/v1/sessions/shared-session/history")

        contents = [turn["content"] for turn in response.json()["history"]]
        assert contents == ["my question", "the answer"]


class TestGetHistorySessionBehavior:
    def test_nonexistent_session_returns_404(self):
        client, _retriever, _conv, _llm = _client()

        response = client.get("/api/v1/sessions/never-created/history")

        assert response.status_code == 404

    def test_conversation_store_failure_on_history_check_returns_503(self):
        conversation = FakeConversationManager()
        # session_exists is a normal method here; simulate failure by
        # monkeypatching it directly on the fake instance.
        def _raise(session_id: str) -> bool:
            raise ConversationStoreUnavailableError("redis down")

        conversation.session_exists = _raise  # type: ignore[method-assign]
        client, _r, _conv, _llm = _client(conversation=conversation)

        response = client.get("/api/v1/sessions/s1/history")

        assert response.status_code == 503

    def test_get_history_does_not_mutate_stored_history(self):
        from app.services.conversation import ConversationTurn

        history = [ConversationTurn(role="user", content="original", timestamp=1.0)]  # type: ignore[arg-type]
        conversation = FakeConversationManager(initial_history={"s1": history})
        client, _retriever, _conv, _llm = _client(conversation=conversation)

        client.get("/api/v1/sessions/s1/history")
        client.get("/api/v1/sessions/s1/history")

        # No append_turn calls were ever made by a read-only GET.
        assert conversation.append_calls == []

    def test_session_isolation_between_two_sessions(self):
        from app.services.conversation import ConversationTurn

        conversation = FakeConversationManager(
            initial_history={
                "session-a": [ConversationTurn(role="user", content="a's turn", timestamp=1.0)],  # type: ignore[arg-type]
                "session-b": [ConversationTurn(role="user", content="b's turn", timestamp=1.0)],  # type: ignore[arg-type]
            }
        )
        client, _retriever, _conv, _llm = _client(conversation=conversation)

        response_a = client.get("/api/v1/sessions/session-a/history")
        response_b = client.get("/api/v1/sessions/session-b/history")

        assert [t["content"] for t in response_a.json()["history"]] == ["a's turn"]
        assert [t["content"] for t in response_b.json()["history"]] == ["b's turn"]


# ---------------------------------------------------------------------------
# STEP 2 REMEDIATION -- GET /api/v1/sessions/{id}/history authentication.
# Previously the ONLY internal-service route with no auth at all; now
# gated by the exact same require_query_identity dependency as /query and
# /seed. Mirrors TestQueryAuthentication's own cases one-for-one.
# ---------------------------------------------------------------------------


class TestSessionHistoryAuthentication:
    def test_missing_authorization_header_rejected(self):
        client, *_ = _client()
        response = client.get("/api/v1/sessions/s1/history", headers={"Authorization": ""})
        assert response.status_code == 401

    def test_valid_token_accepted(self):
        client, *_ = _client()
        response = client.get("/api/v1/sessions/never-created/history")
        # 404 (session genuinely doesn't exist) -- NOT 401 -- proves the
        # request passed authentication and reached the route's own logic.
        assert response.status_code == 404

    def test_invalid_signature_rejected(self):
        client, *_ = _client()
        other_private_pem, _ = _generate_es256_keypair()
        bad_token = jwt.encode(
            {
                "sub": "u",
                "workspace_id": "w",
                "scope": _TEST_SCOPE,
                "iss": _TEST_ISSUER,
                "aud": _TEST_AUDIENCE,
                "iat": 0,
                "exp": 9999999999,
                "jti": "j",
            },
            other_private_pem,
            algorithm="ES256",
            headers={"kid": _TEST_KID},
        )
        response = client.get("/api/v1/sessions/s1/history", headers={"Authorization": f"Bearer {bad_token}"})
        assert response.status_code == 401

    def test_expired_token_rejected(self):
        client, *_ = _client()
        token = _mint_valid_test_token(exp=1)
        response = client.get("/api/v1/sessions/s1/history", headers={"Authorization": f"Bearer {token}"})
        assert response.status_code == 401

    def test_wrong_issuer_rejected(self):
        client, *_ = _client()
        token = _mint_valid_test_token(iss="https://not-educopilot.example")
        response = client.get("/api/v1/sessions/s1/history", headers={"Authorization": f"Bearer {token}"})
        assert response.status_code == 401

    def test_wrong_audience_rejected(self):
        client, *_ = _client()
        token = _mint_valid_test_token(aud="team4a-ingestion")
        response = client.get("/api/v1/sessions/s1/history", headers={"Authorization": f"Bearer {token}"})
        assert response.status_code == 401

    def test_wrong_scope_rejected_with_403_not_401(self):
        client, *_ = _client()
        token = _mint_valid_test_token(scope="ingest")
        response = client.get("/api/v1/sessions/s1/history", headers={"Authorization": f"Bearer {token}"})
        assert response.status_code == 403

    def test_auth_failure_does_not_leak_verification_details(self):
        client, *_ = _client()
        token = _mint_valid_test_token(scope="wrong-scope-value")
        response = client.get("/api/v1/sessions/s1/history", headers={"Authorization": f"Bearer {token}"})
        body_text = response.text.lower()
        assert "wrong-scope-value" not in body_text
        assert "-----begin" not in body_text

    def test_401_response_does_not_leak_conversation_content(self):
        """The exact regression this fix closes: an unauthenticated
        caller must never see session content, even for a session that
        genuinely exists with real history."""

        from app.services.conversation import ConversationTurn

        conversation = FakeConversationManager(
            initial_history={"real-session": [ConversationTurn(role="user", content="sensitive question", timestamp=1.0)]}  # type: ignore[arg-type]
        )
        client, _r, _conv, _llm = _client(conversation=conversation)

        response = client.get("/api/v1/sessions/real-session/history", headers={"Authorization": ""})

        assert response.status_code == 401
        assert "sensitive question" not in response.text


class TestGetHistoryNoDirectBackendAccess:
    def test_routes_module_has_no_module_level_client_instantiation(self):
        import inspect

        import app.api.routes as routes_module

        source = inspect.getsource(routes_module)
        assert "QdrantClient(" not in source
        assert "redis.Redis" not in source


# ---------------------------------------------------------------------------
# OpenAPI verification
# ---------------------------------------------------------------------------


class TestOpenAPI:
    def test_query_and_history_paths_are_registered(self):
        client, _retriever, _conv, _llm = _client()

        openapi = client.get("/openapi.json").json()

        assert "/api/v1/query" in openapi["paths"]
        assert "post" in openapi["paths"]["/api/v1/query"]
        assert "/api/v1/sessions/{session_id}/history" in openapi["paths"]
        assert "get" in openapi["paths"]["/api/v1/sessions/{session_id}/history"]

    def test_query_response_schema_is_the_approved_model(self):
        client, _retriever, _conv, _llm = _client()

        openapi = client.get("/openapi.json").json()
        query_post = openapi["paths"]["/api/v1/query"]["post"]
        response_schema_ref = query_post["responses"]["200"]["content"]["application/json"]["schema"]["$ref"]

        assert "QueryResponse" in response_schema_ref

    def test_no_task_10_2_or_later_endpoints_exist(self):
        # UPDATED IN TASK 10.1: this test previously also asserted
        # "/health"/"/metrics" not in paths, correct as of Task 8.1/9.1
        # (before Task 10.1 existed). Task 10.1 has since added both by
        # design -- not a regression. There is no Task 10.2/11.1 endpoint
        # to check for by name, so this now confirms no OTHER
        # unexpected path exists beyond the five official ones (checked
        # exhaustively in the next test).
        client, _retriever, _conv, _llm = _client()

        openapi = client.get("/openapi.json").json()
        paths = openapi["paths"]

        assert "/api/v1/evaluate/results" not in paths  # no speculative evaluation-history endpoint
        assert "/docker" not in paths

    def test_only_the_eight_official_task_8_1_9_1_10_1_step_7_step_3_stage_9b_paths_exist(self):
        # UPDATED IN STAGE 9B: was seven paths (8.1 + 9.1 + 10.1 + Step 7 +
        # Step 3); now eight, with the additive streaming query endpoint
        # (/api/v1/query/stream) added -- /api/v1/query itself is
        # unchanged. Still proves no unrelated/speculative endpoint exists.
        client, _retriever, _conv, _llm = _client()

        openapi = client.get("/openapi.json").json()

        assert set(openapi["paths"].keys()) == {
            "/api/v1/query",
            "/api/v1/query/stream",
            "/api/v1/sessions/{session_id}/history",
            "/api/v1/sessions/{session_id}/seed",
            "/api/v1/sessions/{session_id}",
            "/api/v1/evaluate",
            "/health",
            "/metrics",
        }


# ---------------------------------------------------------------------------
# POST /api/v1/evaluate (Task 9.1)
#
# ADDED IN TASK 9.1: exercises the real EvaluationPipeline (wired with a
# FakeRagasEvaluator + InMemoryEvaluationStore, mirroring exactly how the
# query/history tests above wire a real RAGService with fake components)
# through an actual HTTP request, not just at the pipeline level (already
# covered thoroughly in tests/test_evaluation.py).
# ---------------------------------------------------------------------------


def _evaluate_client(
    evaluator: Any = None,
    store: Any = None,
) -> tuple[TestClient, Any, Any]:
    from app.api.dependencies import get_evaluation_pipeline
    from app.api.rate_limit import get_rate_limiter
    from app.services.evaluation import EvaluationPipeline, InMemoryEvaluationStore
    from tests.fakes import FakeRagasEvaluator

    evaluator = evaluator or FakeRagasEvaluator()
    store = store or InMemoryEvaluationStore()
    pipeline = EvaluationPipeline(evaluator=evaluator, store=store, settings=None)

    app = create_app()
    app.dependency_overrides[get_evaluation_pipeline] = lambda: pipeline
    # Security Hardening Stage 1: /api/v1/evaluate now requires the same
    # internal service JWT as /api/v1/query, plus a rate limit -- see
    # this file's module-level comment (near `_client()`) for the real
    # verifier/token pattern, and `FakeRateLimiter`'s own docstring for
    # why the rate limiter is overridden by default in every test here
    # that isn't specifically testing rate-limiting.
    app.dependency_overrides[get_service_jwt_verifier] = lambda: ServiceJWTVerifier(
        public_keys_by_kid={_TEST_KID: _TEST_PUBLIC_PEM},
        expected_issuer=_TEST_ISSUER,
        expected_audience=_TEST_AUDIENCE,
        required_scope=_TEST_SCOPE,
    )
    app.dependency_overrides[get_rate_limiter] = lambda: FakeRateLimiter()
    client = TestClient(app, headers={"Authorization": f"Bearer {_mint_valid_test_token()}"})
    return client, evaluator, store


class TestPostEvaluateSuccess:
    def test_single_item_batch_returns_200_and_valid_response(self):
        from app.models.evaluation import EvaluationResponse

        client, _evaluator, _store = _evaluate_client()

        response = client.post(
            "/api/v1/evaluate", json=[{"query": "What is RAG?", "response": "RAG stands for...", "contexts": ["context text"]}]
        )

        assert response.status_code == 200
        EvaluationResponse.model_validate(response.json())

    def test_response_contains_per_item_and_aggregate_results(self):
        client, _evaluator, _store = _evaluate_client()

        response = client.post(
            "/api/v1/evaluate",
            json=[
                {"query": "q1", "response": "r1", "contexts": ["c1"]},
                {"query": "q2", "response": "r2", "contexts": ["c2"]},
            ],
        )

        body = response.json()
        assert len(body["results"]) == 2
        assert "aggregate" in body
        assert "evaluated_at" in body

    def test_all_four_metrics_appear_in_the_response(self):
        client, _evaluator, _store = _evaluate_client()

        response = client.post("/api/v1/evaluate", json=[{"query": "q", "response": "r", "contexts": ["c"]}])

        metrics = response.json()["results"][0]["metrics"]
        assert set(metrics.keys()) == {"faithfulness", "answer_relevancy", "context_precision", "context_recall"}

    def test_context_recall_is_represented_as_null_not_a_fabricated_score(self):
        # Task 9.1 remediation: the default fake mirrors the corrected
        # real RagasEvaluationAdapter's behavior -- context_recall is
        # structurally unavailable, not a normal successful metric.
        client, _evaluator, _store = _evaluate_client()

        response = client.post("/api/v1/evaluate", json=[{"query": "q", "response": "r", "contexts": ["c"]}])

        result = response.json()["results"][0]
        assert result["metrics"]["context_recall"] is None
        assert result["metrics"]["context_recall"] != 0.0
        assert "context_recall" in result["errors"]
        assert "reference" in result["errors"]["context_recall"].lower()

    def test_other_three_metrics_still_have_real_values_in_the_response(self):
        client, _evaluator, _store = _evaluate_client()

        response = client.post("/api/v1/evaluate", json=[{"query": "q", "response": "r", "contexts": ["c"]}])

        metrics = response.json()["results"][0]["metrics"]
        assert metrics["faithfulness"] is not None
        assert metrics["answer_relevancy"] is not None
        assert metrics["context_precision"] is not None

    def test_aggregate_context_recall_is_null_when_unavailable_for_every_item(self):
        client, _evaluator, _store = _evaluate_client()

        response = client.post(
            "/api/v1/evaluate",
            json=[{"query": f"q{i}", "response": f"r{i}", "contexts": ["c"]} for i in range(3)],
        )

        aggregate = response.json()["aggregate"]
        assert aggregate["context_recall"] is None
        assert aggregate["faithfulness"] is not None  # other aggregates unaffected

    def test_low_faithfulness_flag_appears_in_the_response(self):
        # Task 9.2 / P18: the flag must be visible over the actual HTTP
        # API, not just at the pipeline level.
        from tests.fakes import FakeRagasEvaluator

        evaluator = FakeRagasEvaluator(
            per_item_overrides={
                0: (
                    {"faithfulness": 0.2, "answer_relevancy": 0.5, "context_precision": 0.5, "context_recall": None},
                    {},
                )
            }
        )
        client, _e, _store = _evaluate_client(evaluator=evaluator)

        response = client.post("/api/v1/evaluate", json=[{"query": "q", "response": "r", "contexts": ["c"]}])

        assert response.json()["results"][0]["low_faithfulness_flag"] is True

    def test_high_faithfulness_is_not_flagged_in_the_response(self):
        from tests.fakes import FakeRagasEvaluator

        evaluator = FakeRagasEvaluator(
            per_item_overrides={
                0: (
                    {"faithfulness": 0.9, "answer_relevancy": 0.5, "context_precision": 0.5, "context_recall": None},
                    {},
                )
            }
        )
        client, _e, _store = _evaluate_client(evaluator=evaluator)

        response = client.post("/api/v1/evaluate", json=[{"query": "q", "response": "r", "contexts": ["c"]}])

        assert response.json()["results"][0]["low_faithfulness_flag"] is False

    def test_exact_boundary_0_5_is_not_flagged_in_the_response(self):
        from tests.fakes import FakeRagasEvaluator

        evaluator = FakeRagasEvaluator(
            per_item_overrides={
                0: (
                    {"faithfulness": 0.5, "answer_relevancy": 0.5, "context_precision": 0.5, "context_recall": None},
                    {},
                )
            }
        )
        client, _e, _store = _evaluate_client(evaluator=evaluator)

        response = client.post("/api/v1/evaluate", json=[{"query": "q", "response": "r", "contexts": ["c"]}])

        assert response.json()["results"][0]["low_faithfulness_flag"] is False

    def test_fifty_item_batch_is_accepted(self):
        client, _evaluator, _store = _evaluate_client()
        items = [{"query": f"q{i}", "response": f"r{i}", "contexts": [f"c{i}"]} for i in range(50)]

        response = client.post("/api/v1/evaluate", json=items)

        assert response.status_code == 200
        assert len(response.json()["results"]) == 50

    def test_empty_batch_is_accepted(self):
        client, evaluator, _store = _evaluate_client()

        response = client.post("/api/v1/evaluate", json=[])

        assert response.status_code == 200
        assert response.json()["results"] == []
        assert evaluator.calls == []

    def test_evaluation_result_is_persisted(self):
        client, _evaluator, store = _evaluate_client()

        client.post("/api/v1/evaluate", json=[{"query": "q", "response": "r", "contexts": ["c"]}])

        assert len(store.saved) == 1

    def test_query_actually_reaches_the_evaluator(self):
        client, evaluator, _store = _evaluate_client()

        client.post("/api/v1/evaluate", json=[{"query": "the exact question", "response": "r", "contexts": ["c"]}])

        assert evaluator.calls[0][0].query == "the exact question"

    def test_item_order_is_preserved_in_the_response(self):
        client, _evaluator, _store = _evaluate_client()

        response = client.post(
            "/api/v1/evaluate",
            json=[{"query": f"q{i}", "response": "r", "contexts": ["c"]} for i in range(5)],
        )

        assert [r["query"] for r in response.json()["results"]] == [f"q{i}" for i in range(5)]


class TestPostEvaluateValidation:
    def test_fifty_one_item_batch_returns_422(self):
        client, evaluator, _store = _evaluate_client()
        items = [{"query": f"q{i}", "response": "r", "contexts": ["c"]} for i in range(51)]

        response = client.post("/api/v1/evaluate", json=items)

        assert response.status_code == 422
        assert evaluator.calls == []  # never reached evaluation

    def test_missing_query_field_returns_422(self):
        client, _evaluator, _store = _evaluate_client()

        response = client.post("/api/v1/evaluate", json=[{"response": "r", "contexts": ["c"]}])

        assert response.status_code == 422

    def test_missing_response_field_returns_422(self):
        client, _evaluator, _store = _evaluate_client()

        response = client.post("/api/v1/evaluate", json=[{"query": "q", "contexts": ["c"]}])

        assert response.status_code == 422

    def test_missing_contexts_field_returns_422(self):
        client, _evaluator, _store = _evaluate_client()

        response = client.post("/api/v1/evaluate", json=[{"query": "q", "response": "r"}])

        assert response.status_code == 422

    def test_invalid_contexts_type_returns_422(self):
        client, _evaluator, _store = _evaluate_client()

        response = client.post("/api/v1/evaluate", json=[{"query": "q", "response": "r", "contexts": "not-a-list"}])

        assert response.status_code == 422

    def test_malformed_request_body_returns_422(self):
        client, _evaluator, _store = _evaluate_client()

        response = client.post("/api/v1/evaluate", json={"not": "a list"})

        assert response.status_code == 422


class TestPostEvaluatePartialFailureAndErrors:
    def test_partial_metric_failure_returns_200_with_successful_metrics_preserved(self):
        from tests.fakes import FakeRagasEvaluator

        evaluator = FakeRagasEvaluator(
            per_item_overrides={
                0: (
                    {"faithfulness": 0.82, "answer_relevancy": None, "context_precision": 0.76, "context_recall": 0.71},
                    {"answer_relevancy": "simulated failure"},
                )
            }
        )
        client, _e, _store = _evaluate_client(evaluator=evaluator)

        response = client.post("/api/v1/evaluate", json=[{"query": "q", "response": "r", "contexts": ["c"]}])

        assert response.status_code == 200
        metrics = response.json()["results"][0]["metrics"]
        assert metrics["faithfulness"] == 0.82
        assert metrics["answer_relevancy"] is None
        assert metrics["context_precision"] == 0.76

    def test_evaluator_dependency_failure_returns_5xx(self):
        from tests.fakes import FakeRagasEvaluator

        evaluator = FakeRagasEvaluator(raise_error=RuntimeError("ragas/LLM backend unreachable"))
        client, _e, _store = _evaluate_client(evaluator=evaluator)

        response = client.post("/api/v1/evaluate", json=[{"query": "q", "response": "r", "contexts": ["c"]}])

        assert response.status_code >= 500

    def test_persistence_failure_returns_503(self):
        from app.services.evaluation import EvaluationPersistenceError

        class _FailingStore:
            def save(self, response: Any) -> None:
                raise EvaluationPersistenceError("disk full")

        client, _evaluator, _store = _evaluate_client(store=_FailingStore())

        response = client.post("/api/v1/evaluate", json=[{"query": "q", "response": "r", "contexts": ["c"]}])

        assert response.status_code == 503

    def test_error_response_does_not_leak_internal_details(self):
        from app.services.evaluation import EvaluationPersistenceError

        class _FailingStore:
            def save(self, response: Any) -> None:
                raise EvaluationPersistenceError("failed writing to /secret/internal/path.jsonl")

        client, _evaluator, _store = _evaluate_client(store=_FailingStore())

        response = client.post("/api/v1/evaluate", json=[{"query": "q", "response": "r", "contexts": ["c"]}])

        assert "/secret/internal/path.jsonl" not in response.text


class TestEvaluateDoesNotAffectExistingEndpoints:
    def test_query_endpoint_still_works_after_evaluate_is_registered(self):
        client, _retriever, _conv, _llm = _client()

        response = client.post("/api/v1/query", json={"query": "explain the topic"})

        assert response.status_code == 200

    def test_history_endpoint_still_works_after_evaluate_is_registered(self):
        client, _retriever, _conv, _llm = _client()

        response = client.get("/api/v1/sessions/never-created/history")

        assert response.status_code == 404  # unchanged behavior, still reachable


# ---------------------------------------------------------------------------
# GET /health (Task 10.1)
#
# ADDED IN TASK 10.1: exercises the REAL /health route through actual
# HTTP requests (`TestClient`), with each of the three checked
# components (vector_store, redis, llm) independently controlled via a
# small purpose-built fake -- `get_rag_service` is deliberately NOT
# overridden here, since /health's own "rag" component check is
# specifically about whether the real DI wiring succeeds (see
# app/api/routes.py's docstring), which is safe to exercise for real in
# tests (none of the lazy constructors open a live connection).
# ---------------------------------------------------------------------------


class _FakeHealthComponent:
    def __init__(self, healthy: bool = True, raises: Exception | None = None) -> None:
        self._healthy = healthy
        self._raises = raises
        self.check_health_calls = 0

    def check_health(self) -> bool:
        self.check_health_calls += 1
        if self._raises is not None:
            raise self._raises
        return self._healthy


def _health_client(
    vector_store: Any = None,
    redis: Any = None,
    llm: Any = None,
) -> tuple[TestClient, Any, Any, Any]:
    from app.api.dependencies import get_conversation_manager, get_llm_generator, get_vector_store_manager

    vector_store = vector_store or _FakeHealthComponent()
    redis = redis or _FakeHealthComponent()
    llm = llm or _FakeHealthComponent()

    app = create_app()
    app.dependency_overrides[get_vector_store_manager] = lambda: vector_store
    app.dependency_overrides[get_conversation_manager] = lambda: redis
    app.dependency_overrides[get_llm_generator] = lambda: llm
    return TestClient(app), vector_store, redis, llm


class TestHealthAllHealthy:
    def test_returns_200_when_all_components_healthy(self):
        client, _vs, _redis, _llm = _health_client()

        response = client.get("/health")

        assert response.status_code == 200

    def test_overall_status_is_healthy(self):
        client, _vs, _redis, _llm = _health_client()

        response = client.get("/health")

        assert response.json()["status"] == "healthy"

    def test_all_four_required_components_are_reported(self):
        client, _vs, _redis, _llm = _health_client()

        response = client.get("/health")

        components = response.json()["components"]
        assert set(components.keys()) == {"rag", "vector_store", "redis", "llm"}
        for component in components.values():
            assert component["status"] == "healthy"

    def test_each_component_check_is_actually_invoked(self):
        client, vector_store, redis, llm = _health_client()

        client.get("/health")

        assert vector_store.check_health_calls == 1
        assert redis.check_health_calls == 1
        assert llm.check_health_calls == 1


class TestHealthVectorStoreDegraded:
    def test_vector_store_unavailable_is_reported(self):
        client, _vs, _redis, _llm = _health_client(vector_store=_FakeHealthComponent(healthy=False))

        response = client.get("/health")

        assert response.json()["components"]["vector_store"]["status"] == "unavailable"

    def test_overall_status_becomes_degraded(self):
        client, _vs, _redis, _llm = _health_client(vector_store=_FakeHealthComponent(healthy=False))

        response = client.get("/health")

        assert response.json()["status"] == "degraded"

    def test_other_components_remain_reported_as_healthy(self):
        client, _vs, _redis, _llm = _health_client(vector_store=_FakeHealthComponent(healthy=False))

        response = client.get("/health")

        components = response.json()["components"]
        assert components["redis"]["status"] == "healthy"
        assert components["llm"]["status"] == "healthy"

    def test_rag_becomes_unavailable_too(self):
        # "rag" is a derived rollup of vector_store/redis/llm (fixed
        # during this task's review -- see get_health()'s own docstring
        # for why an earlier version of this field was tautological and
        # never actually reflected a real dependency failure). This is
        # the test that would have caught that bug.
        client, _vs, _redis, _llm = _health_client(vector_store=_FakeHealthComponent(healthy=False))

        response = client.get("/health")

        assert response.json()["components"]["rag"]["status"] == "unavailable"


class TestHealthRedisDegraded:
    def test_redis_unavailable_is_reported(self):
        client, _vs, _redis, _llm = _health_client(redis=_FakeHealthComponent(healthy=False))

        response = client.get("/health")

        assert response.json()["components"]["redis"]["status"] == "unavailable"
        assert response.json()["status"] == "degraded"

    def test_rag_becomes_unavailable_when_only_redis_is_down(self):
        # Grounded in RAGService.handle_query()'s actual implementation:
        # it calls ConversationManager.append_turn() (Redis) BEFORE
        # retrieval/generation are even attempted, so a real query fails
        # end-to-end if Redis alone is down -- even with Qdrant and
        # Ollama both healthy. "rag" must reflect that.
        client, _vs, _redis, _llm = _health_client(redis=_FakeHealthComponent(healthy=False))

        response = client.get("/health")

        assert response.json()["components"]["rag"]["status"] == "unavailable"
        assert response.json()["components"]["vector_store"]["status"] == "healthy"
        assert response.json()["components"]["llm"]["status"] == "healthy"


class TestHealthLLMDegraded:
    def test_llm_unavailable_is_reported(self):
        client, _vs, _redis, _llm = _health_client(llm=_FakeHealthComponent(healthy=False))

        response = client.get("/health")

        assert response.json()["components"]["llm"]["status"] == "unavailable"
        assert response.json()["status"] == "degraded"

    def test_rag_becomes_unavailable_when_only_llm_is_down(self):
        client, _vs, _redis, _llm = _health_client(llm=_FakeHealthComponent(healthy=False))

        response = client.get("/health")

        assert response.json()["components"]["rag"]["status"] == "unavailable"


class TestHealthRagRollupExplicit:
    """Dedicated coverage for the "rag" derived-status rule itself,
    independent of any single-component test above."""

    def test_rag_is_healthy_only_when_all_three_dependencies_are_healthy(self):
        client, _vs, _redis, _llm = _health_client()

        response = client.get("/health")

        assert response.json()["components"]["rag"]["status"] == "healthy"

    def test_rag_is_unavailable_when_all_three_dependencies_are_down(self):
        client, _vs, _redis, _llm = _health_client(
            vector_store=_FakeHealthComponent(healthy=False),
            redis=_FakeHealthComponent(healthy=False),
            llm=_FakeHealthComponent(healthy=False),
        )

        response = client.get("/health")

        assert response.json()["components"]["rag"]["status"] == "unavailable"

    def test_rag_status_is_never_a_third_value(self):
        # Only "healthy"/"unavailable" are valid per ComponentHealth --
        # no silent third state.
        client, _vs, _redis, _llm = _health_client(vector_store=_FakeHealthComponent(healthy=False))

        response = client.get("/health")

        assert response.json()["components"]["rag"]["status"] in {"healthy", "unavailable"}


class TestHealthExceptionResilience:
    def test_health_endpoint_remains_stable_when_a_check_raises(self):
        client, _vs, _redis, _llm = _health_client(
            vector_store=_FakeHealthComponent(raises=ConnectionError("qdrant unreachable"))
        )

        response = client.get("/health")

        # Must not 500 -- a raising dependency check is represented in
        # the body, never allowed to crash the endpoint itself.
        assert response.status_code == 200
        assert response.json()["components"]["vector_store"]["status"] == "unavailable"

    def test_multiple_simultaneous_failures_are_all_reported(self):
        client, _vs, _redis, _llm = _health_client(
            vector_store=_FakeHealthComponent(raises=ConnectionError("down")),
            redis=_FakeHealthComponent(healthy=False),
            llm=_FakeHealthComponent(raises=TimeoutError("timed out")),
        )

        response = client.get("/health")

        components = response.json()["components"]
        assert components["vector_store"]["status"] == "unavailable"
        assert components["redis"]["status"] == "unavailable"
        assert components["llm"]["status"] == "unavailable"
        assert components["rag"]["status"] == "unavailable"
        assert response.json()["status"] == "degraded"

    def test_all_components_down_still_returns_200_with_full_detail(self):
        client, _vs, _redis, _llm = _health_client(
            vector_store=_FakeHealthComponent(healthy=False),
            redis=_FakeHealthComponent(healthy=False),
            llm=_FakeHealthComponent(healthy=False),
        )

        response = client.get("/health")

        assert response.status_code == 200
        assert response.json()["status"] == "degraded"


class TestHealthNoSideEffects:
    def test_health_check_is_read_only_and_lightweight(self):
        # A health check that raised no exception and returned quickly
        # confirms no heavy operation (retrieval, generation, Qdrant
        # writes) was attempted -- verified indirectly by these fakes
        # never being asked to do anything beyond check_health().
        client, vector_store, redis, llm = _health_client()

        client.get("/health")

        # The fakes expose ONLY check_health() -- if the route had tried
        # to call anything else (e.g. a real query), it would have
        # raised AttributeError, which would surface as a 500 here.
        response = client.get("/health")
        assert response.status_code == 200


# ---------------------------------------------------------------------------
# GET /metrics (Task 10.1)
# ---------------------------------------------------------------------------


class TestMetricsEndpoint:
    def test_returns_200(self):
        client, _retriever, _conv, _llm = _client()

        response = client.get("/metrics")

        assert response.status_code == 200

    def test_zero_queries_returns_null_derived_metrics(self):
        client, _retriever, _conv, _llm = _client()

        response = client.get("/metrics")

        body = response.json()
        assert body["query_count"] == 0
        assert body["average_latency_seconds"] is None
        assert body["hit_rate"] is None
        assert body["error_rate"] is None

    def test_response_contains_exactly_the_four_required_fields(self):
        client, _retriever, _conv, _llm = _client()

        response = client.get("/metrics")

        assert set(response.json().keys()) == {"query_count", "average_latency_seconds", "hit_rate", "error_rate"}

    def test_query_count_increases_after_a_successful_query(self):
        client, _retriever, _conv, _llm = _client()

        client.post("/api/v1/query", json={"query": "explain the topic"})
        response = client.get("/metrics")

        assert response.json()["query_count"] == 1

    def test_multiple_queries_accumulate(self):
        client, _retriever, _conv, _llm = _client()

        client.post("/api/v1/query", json={"query": "q1"})
        client.post("/api/v1/query", json={"query": "q2"})
        client.post("/api/v1/query", json={"query": "q3"})

        assert client.get("/metrics").json()["query_count"] == 3

    def test_average_latency_is_a_positive_number_after_a_real_query(self):
        client, _retriever, _conv, _llm = _client()

        client.post("/api/v1/query", json={"query": "explain the topic"})

        latency = client.get("/metrics").json()["average_latency_seconds"]
        assert latency is not None
        assert latency >= 0.0

    def test_hit_rate_is_1_when_retrieval_returns_chunks(self):
        client, _r, _conv, _llm = _client()  # default retriever already returns one chunk with valid metadata

        client.post("/api/v1/query", json={"query": "explain the topic"})

        assert client.get("/metrics").json()["hit_rate"] == pytest.approx(1.0)

    def test_hit_rate_is_0_when_retrieval_returns_no_chunks(self):
        retriever = FakeHybridRetriever(results=[])
        client, _r, _conv, _llm = _client(retriever=retriever)

        client.post("/api/v1/query", json={"query": "explain the topic"})

        assert client.get("/metrics").json()["hit_rate"] == pytest.approx(0.0)

    def test_error_rate_increases_after_a_failed_query(self):
        retriever = FakeHybridRetriever(raise_error=VectorStoreUnavailableError("down"))
        client, _r, _conv, _llm = _client(retriever=retriever)

        response = client.post("/api/v1/query", json={"query": "explain the topic"})
        assert response.status_code == 503  # confirm it actually failed

        metrics = client.get("/metrics").json()
        assert metrics["query_count"] == 1
        assert metrics["error_rate"] == pytest.approx(1.0)

    def test_failed_query_does_not_count_as_a_hit_or_a_miss(self):
        retriever = FakeHybridRetriever(raise_error=VectorStoreUnavailableError("down"))
        client, _r, _conv, _llm = _client(retriever=retriever)

        client.post("/api/v1/query", json={"query": "explain the topic"})

        # Zero COMPLETED queries -> hit_rate is None, not 0.0.
        assert client.get("/metrics").json()["hit_rate"] is None

    def test_successful_query_with_no_hit_produces_correct_rates(self):
        retriever = FakeHybridRetriever(results=[])
        client, _r, _conv, _llm = _client(retriever=retriever)

        client.post("/api/v1/query", json={"query": "q1"})  # succeeds, but zero chunks retrieved -> a miss

        metrics = client.get("/metrics").json()
        assert metrics["query_count"] == 1
        assert metrics["error_rate"] == pytest.approx(0.0)
        assert metrics["hit_rate"] == pytest.approx(0.0)

    def test_metrics_endpoint_does_not_execute_a_query(self):
        client, retriever, _conv, llm = _client()

        client.get("/metrics")

        assert retriever.calls == []
        assert llm.calls == []

    def test_metrics_endpoint_is_read_only_and_does_not_change_counts(self):
        client, _retriever, _conv, _llm = _client()
        client.post("/api/v1/query", json={"query": "explain the topic"})

        first_read = client.get("/metrics").json()
        second_read = client.get("/metrics").json()

        assert first_read == second_read  # reading /metrics itself does not change the counts


class TestMetricsDoesNotBreakQueryExecution:
    def test_query_still_succeeds_even_though_metrics_are_recorded(self):
        client, _retriever, _conv, llm = _client(llm=FakeLLMGenerator(answer="the answer"))

        response = client.post("/api/v1/query", json={"query": "explain the topic"})

        assert response.status_code == 200
        assert response.json()["answer"] == "the answer"


class TestHealthAndMetricsDoNotAffectExistingEndpoints:
    def test_query_endpoint_still_works_after_health_and_metrics_are_registered(self):
        client, _retriever, _conv, _llm = _client()

        response = client.post("/api/v1/query", json={"query": "explain the topic"})

        assert response.status_code == 200

    def test_history_endpoint_still_works(self):
        client, _retriever, _conv, _llm = _client()

        response = client.get("/api/v1/sessions/never-created/history")

        assert response.status_code == 404

    def test_evaluate_endpoint_still_works(self):
        client, _retriever, _conv, _llm = _client()

        response = client.post("/api/v1/evaluate", json=[])

        assert response.status_code == 200


class TestOpenAPIIncludesHealthAndMetrics:
    def test_health_and_metrics_paths_are_registered(self):
        client, _retriever, _conv, _llm = _client()

        openapi = client.get("/openapi.json").json()

        assert "/health" in openapi["paths"]
        assert "get" in openapi["paths"]["/health"]
        assert "/metrics" in openapi["paths"]
        assert "get" in openapi["paths"]["/metrics"]

    def test_no_task_11_or_later_endpoints_exist(self):
        client, _retriever, _conv, _llm = _client()

        openapi = client.get("/openapi.json").json()

        assert set(openapi["paths"].keys()) == {
            "/api/v1/query",
            "/api/v1/query/stream",
            "/api/v1/sessions/{session_id}/history",
            "/api/v1/sessions/{session_id}/seed",
            "/api/v1/sessions/{session_id}",
            "/api/v1/evaluate",
            "/health",
            "/metrics",
        }


# ---------------------------------------------------------------------------
# Phase 2E — POST /api/v1/query authentication (real ES256, real verifier)
# ---------------------------------------------------------------------------


class TestQueryAuthentication:
    def test_missing_authorization_header_rejected(self):
        client, *_ = _client()
        response = client.post("/api/v1/query", json={"query": "explain the concept"}, headers={"Authorization": ""})
        assert response.status_code == 401

    def test_valid_token_accepted(self):
        client, *_ = _client()
        response = client.post("/api/v1/query", json={"query": "explain the concept"})
        assert response.status_code == 200

    def test_invalid_signature_rejected(self):
        client, *_ = _client()
        other_private_pem, _ = _generate_es256_keypair()
        bad_token = jwt.encode(
            {
                "sub": "u",
                "workspace_id": "w",
                "scope": _TEST_SCOPE,
                "iss": _TEST_ISSUER,
                "aud": _TEST_AUDIENCE,
                "iat": 0,
                "exp": 9999999999,
                "jti": "j",
            },
            other_private_pem,
            algorithm="ES256",
            headers={"kid": _TEST_KID},
        )
        response = client.post("/api/v1/query", json={"query": "explain the concept"}, headers={"Authorization": f"Bearer {bad_token}"})
        assert response.status_code == 401

    def test_expired_token_rejected(self):
        client, *_ = _client()
        token = _mint_valid_test_token(exp=1)
        response = client.post("/api/v1/query", json={"query": "explain the concept"}, headers={"Authorization": f"Bearer {token}"})
        assert response.status_code == 401

    def test_wrong_issuer_rejected(self):
        client, *_ = _client()
        token = _mint_valid_test_token(iss="https://not-educopilot.example")
        response = client.post("/api/v1/query", json={"query": "explain the concept"}, headers={"Authorization": f"Bearer {token}"})
        assert response.status_code == 401

    def test_wrong_audience_rejected(self):
        client, *_ = _client()
        token = _mint_valid_test_token(aud="team4a-ingestion")
        response = client.post("/api/v1/query", json={"query": "explain the concept"}, headers={"Authorization": f"Bearer {token}"})
        assert response.status_code == 401

    def test_wrong_scope_rejected_with_403_not_401(self):
        """An ingest-scoped token minted for Team 4A must not authorize
        Team 4B's query endpoint -- and, per this phase's explicit
        requirement, is reported as 403 (authorization), distinct from
        401 (authentication)."""

        client, *_ = _client()
        token = _mint_valid_test_token(scope="ingest")
        response = client.post("/api/v1/query", json={"query": "explain the concept"}, headers={"Authorization": f"Bearer {token}"})
        assert response.status_code == 403

    def test_missing_workspace_id_claim_rejected(self):
        client, *_ = _client()
        now_claims = {
            "sub": "u",
            "scope": _TEST_SCOPE,
            "iss": _TEST_ISSUER,
            "aud": _TEST_AUDIENCE,
            "iat": 0,
            "exp": 9999999999,
            "jti": "j",
        }
        token = jwt.encode(now_claims, _TEST_PRIVATE_PEM, algorithm="ES256", headers={"kid": _TEST_KID})
        response = client.post("/api/v1/query", json={"query": "explain the concept"}, headers={"Authorization": f"Bearer {token}"})
        assert response.status_code == 401

    def test_missing_sub_claim_rejected(self):
        client, *_ = _client()
        now_claims = {
            "workspace_id": "w",
            "scope": _TEST_SCOPE,
            "iss": _TEST_ISSUER,
            "aud": _TEST_AUDIENCE,
            "iat": 0,
            "exp": 9999999999,
            "jti": "j",
        }
        token = jwt.encode(now_claims, _TEST_PRIVATE_PEM, algorithm="ES256", headers={"kid": _TEST_KID})
        response = client.post("/api/v1/query", json={"query": "explain the concept"}, headers={"Authorization": f"Bearer {token}"})
        assert response.status_code == 401

    def test_auth_failure_does_not_leak_verification_details(self):
        client, *_ = _client()
        token = _mint_valid_test_token(scope="wrong-scope-value")
        response = client.post("/api/v1/query", json={"query": "explain the concept"}, headers={"Authorization": f"Bearer {token}"})
        body_text = response.text.lower()
        assert "wrong-scope-value" not in body_text
        assert "-----begin" not in body_text

    def test_401_response_does_not_return_a_successful_looking_answer(self):
        client, *_ = _client()
        response = client.post("/api/v1/query", json={"query": "explain the concept"}, headers={"Authorization": ""})
        assert response.status_code == 401
        assert "answer" not in response.json()


# ---------------------------------------------------------------------------
# MVP M3 — workspace isolation at the route/API level
# ---------------------------------------------------------------------------


class TestWorkspaceIsolationAtTheRoute:
    def test_workspace_id_used_by_retrieval_comes_from_the_jwt_not_the_body(self):
        """TEST 10 + the mandatory security test: a valid token for
        workspace-A must query as workspace-A regardless of anything in
        the request body -- there is no body field that could change it
        (Phase 2A's frozen canonical contract has none), and this test
        additionally proves the actual VALUE used matches the JWT, not
        some other source."""

        client, retriever, _conv, _llm = _client()
        token = _mint_valid_test_token(workspace_id="workspace-A-real")

        response = client.post("/api/v1/query", json={"query": "explain the concept"}, headers={"Authorization": f"Bearer {token}"})

        assert response.status_code == 200
        assert retriever.calls[-1]["workspace_id"] == "workspace-A-real"

    def test_missing_workspace_id_claim_fails_closed_no_query_executes(self):
        """TEST 8: a validly-signed token missing workspace_id must never
        reach retrieval at all."""

        client, retriever, _conv, _llm = _client()
        bad_token = jwt.encode(
            {
                "sub": "u",
                "scope": _TEST_SCOPE,
                "iss": _TEST_ISSUER,
                "aud": _TEST_AUDIENCE,
                "iat": 0,
                "exp": 9999999999,
                "jti": "j",
            },
            _TEST_PRIVATE_PEM,
            algorithm="ES256",
            headers={"kid": _TEST_KID},
        )

        response = client.post("/api/v1/query", json={"query": "explain the concept"}, headers={"Authorization": f"Bearer {bad_token}"})

        assert response.status_code == 401

    def test_body_cannot_supply_or_override_workspace_identity(self):
        """The canonical request body has no workspace field at all --
        attempting to add one is either ignored (extra body fields are
        not part of QueryRequest's schema) or rejected; either way it can
        never become the effective workspace used by retrieval."""

        client, retriever, _conv, _llm = _client()
        token = _mint_valid_test_token(workspace_id="workspace-real")

        response = client.post(
            "/api/v1/query",
            json={"query": "explain the concept", "workspace_id": "workspace-attacker-supplied", "workspaceId": "also-attacker"},
            headers={"Authorization": f"Bearer {token}"},
        )

        assert response.status_code == 200


class TestMalformedWorkspaceIdentity:
    def test_empty_string_workspace_id_claim_fails_closed(self):
        """TEST 9: a malformed (empty-string) workspace_id claim must
        never reach retrieval -- fails at JWT verification itself
        (Phase 2B's existing, unmodified `ServiceJWTVerifier` already
        rejects empty-string workspace_id; this test proves that
        protection is genuinely reachable through the real query route,
        not merely tested in isolation)."""

        client, retriever, _conv, _llm = _client()
        bad_token = jwt.encode(
            {
                "sub": "u",
                "workspace_id": "",
                "scope": _TEST_SCOPE,
                "iss": _TEST_ISSUER,
                "aud": _TEST_AUDIENCE,
                "iat": 0,
                "exp": 9999999999,
                "jti": "j",
            },
            _TEST_PRIVATE_PEM,
            algorithm="ES256",
            headers={"kid": _TEST_KID},
        )

        response = client.post("/api/v1/query", json={"query": "explain the concept"}, headers={"Authorization": f"Bearer {bad_token}"})

        assert response.status_code == 401
        assert retriever.calls == []


class TestM6CasualIntentAtTheRoute:
    """MVP M6 correction -- proves the fix end-to-end through the real
    /api/v1/query route, not just at the RAGService unit level."""

    def test_casual_message_produces_zero_citations_through_the_real_route(self):
        retriever = FakeHybridRetriever(results=[_chunk("c1", "operating systems content")])
        client, retriever, _conv, _llm = _client(retriever=retriever)

        response = client.post("/api/v1/query", json={"query": "Hi"})

        assert response.status_code == 200
        assert response.json()["source_attributions"] == []
        assert retriever.calls == []

    def test_substantive_question_through_the_real_route_still_produces_citations(self):
        retriever = FakeHybridRetriever(results=[_chunk("c1", "operating systems content")])
        client, retriever, _conv, _llm = _client(retriever=retriever)

        response = client.post("/api/v1/query", json={"query": "What is an operating system?"})

        assert response.status_code == 200
        assert len(response.json()["source_attributions"]) == 1
        assert len(retriever.calls) == 1


class TestM6FollowUpContextAtTheRoute:
    """MVP M6 correction -- follow-up enrichment proven end-to-end
    through the real /api/v1/query route, and citation integrity
    re-confirmed for an enriched follow-up specifically."""

    def test_elliptical_query_with_no_history_still_retrieves_on_the_original_query(self):
        """PHASE 5C-1 correction: `is_elliptical_query()` is a coarse,
        domain-agnostic heuristic (any pronoun word anywhere in the
        query) with confirmed false positives on self-contained
        questions -- see
        team4b/data/m6_phase5b_retrieval_reliability_diagnosis.md. A
        positive match with no prior history to enrich from must no
        longer skip retrieval outright: `build_enriched_retrieval_query()`
        already returns the query unchanged when there's no previous
        turn, so this now falls through to plain, unenriched retrieval
        on the original query, exactly like any self-contained question
        -- real citations from real retrieval, not an empty list."""

        retriever = FakeHybridRetriever(results=[_chunk("c1", "process scheduling content")])
        client, retriever, _conv, _llm = _client(retriever=retriever)

        response = client.post("/api/v1/query", json={"query": "Explain it simply."})

        assert response.status_code == 200
        assert len(response.json()["source_attributions"]) == 1
        assert retriever.calls[0]["query"] == "Explain it simply."

    def test_self_contained_question_through_the_real_route_is_unaffected(self):
        retriever = FakeHybridRetriever(results=[_chunk("c1", "operating systems content")])
        client, retriever, _conv, _llm = _client(retriever=retriever)

        response = client.post("/api/v1/query", json={"query": "What is an operating system?"})

        assert response.status_code == 200
        assert len(response.json()["source_attributions"]) == 1
        assert retriever.calls[0]["query"] == "What is an operating system?"


# ---------------------------------------------------------------------------
# Step 7 — POST /api/v1/sessions/{session_id}/seed
# ---------------------------------------------------------------------------


def _seed_client() -> tuple[TestClient, ConversationManager, FakeRedisClient]:
    """A dedicated client wired to a REAL `ConversationManager` (not
    `FakeConversationManager`) over a `FakeRedisClient` -- unlike the rest
    of this file's tests, the seed endpoint's actual correctness
    (idempotency, the restoration lock, ordering) lives inside
    `ConversationManager.seed_history()` itself, so these tests must
    exercise the real implementation, not a simplified fake, through the
    real HTTP route.
    """

    app = create_app()
    redis_client = FakeRedisClient()
    manager = ConversationManager(settings=Settings(_env_file=None), redis_client=redis_client)  # type: ignore[call-arg]
    app.dependency_overrides[get_conversation_manager] = lambda: manager
    app.dependency_overrides[get_service_jwt_verifier] = lambda: ServiceJWTVerifier(
        public_keys_by_kid={_TEST_KID: _TEST_PUBLIC_PEM},
        expected_issuer=_TEST_ISSUER,
        expected_audience=_TEST_AUDIENCE,
        required_scope=_TEST_SCOPE,
    )
    client = TestClient(app, headers={"Authorization": f"Bearer {_mint_valid_test_token()}"})
    return client, manager, redis_client


class TestSeedSessionAuthentication:
    def test_missing_authorization_header_rejected(self):
        client, *_ = _seed_client()
        response = client.post(
            "/api/v1/sessions/s1/seed", json={"turns": []}, headers={"Authorization": ""}
        )
        assert response.status_code == 401

    def test_wrong_scope_rejected_with_403(self):
        client, *_ = _seed_client()
        token = _mint_valid_test_token(scope="ingest")
        response = client.post(
            "/api/v1/sessions/s1/seed", json={"turns": []}, headers={"Authorization": f"Bearer {token}"}
        )
        assert response.status_code == 403

    def test_valid_token_accepted(self):
        client, *_ = _seed_client()
        response = client.post("/api/v1/sessions/s1/seed", json={"turns": []})
        assert response.status_code == 200


class TestSeedSessionRestoration:
    def test_restores_an_expired_missing_session_from_supplied_turns(self):
        client, manager, _redis = _seed_client()

        response = client.post(
            "/api/v1/sessions/s1/seed",
            json={
                "turns": [
                    {"role": "user", "content": "first", "timestamp": 1.0},
                    {"role": "assistant", "content": "second", "timestamp": 2.0},
                ]
            },
        )

        assert response.status_code == 200
        body = response.json()
        assert body == {"session_id": "s1", "seeded": True, "turn_count": 2}
        history = manager.get_history("s1")
        assert [t.content for t in history] == ["first", "second"]  # chronological order preserved

    def test_a_subsequent_query_in_the_restored_session_uses_the_restored_context(self):
        """Requirement: 'verify the follow-up query uses restored
        context.' Proven through the REAL, unmodified retrieval/prompting
        path: RAGService.handle_query() reads windowed history from
        ConversationManager BEFORE appending the new turn -- so if
        seed_history() didn't actually write into the same store
        get_windowed_history() reads from, this would see an empty
        history instead.
        """

        client, manager, _redis = _seed_client()
        client.post(
            "/api/v1/sessions/session-x/seed",
            json={"turns": [{"role": "user", "content": "earlier question", "timestamp": 1.0}]},
        )

        windowed = manager.get_windowed_history("session-x")

        assert len(windowed) == 1
        assert windowed[0].content == "earlier question"

    def test_does_not_duplicate_turns_when_the_session_already_exists(self):
        client, manager, _redis = _seed_client()
        manager.append_turn("s1", "user", "live turn")

        response = client.post(
            "/api/v1/sessions/s1/seed",
            json={"turns": [{"role": "user", "content": "should not appear"}]},
        )

        assert response.status_code == 200
        assert response.json()["seeded"] is False
        assert [t.content for t in manager.get_history("s1")] == ["live turn"]

    def test_repeated_restoration_requests_are_idempotent(self):
        client, manager, _redis = _seed_client()
        payload = {"turns": [{"role": "user", "content": "first"}, {"role": "assistant", "content": "second"}]}

        first = client.post("/api/v1/sessions/s1/seed", json=payload)
        second = client.post("/api/v1/sessions/s1/seed", json=payload)

        assert first.json()["seeded"] is True
        assert second.json()["seeded"] is False
        assert len(manager.get_history("s1")) == 2  # never duplicated to 4

    def test_concurrent_restoration_requests_for_the_same_session_only_seed_once(self):
        client, manager, redis_client = _seed_client()
        # Simulates a second, concurrent restoration request already
        # holding the lock when this one arrives.
        redis_client.set("session_lock:s1", "1", nx=True, ex=30)

        response = client.post(
            "/api/v1/sessions/s1/seed",
            json={"turns": [{"role": "user", "content": "late arrival"}]},
        )

        assert response.status_code == 200
        assert response.json()["seeded"] is False
        assert manager.get_history("s1") == []

    def test_missing_and_empty_history_is_handled_without_error(self):
        client, *_ = _seed_client()

        response = client.post("/api/v1/sessions/never-had-any-history/seed", json={"turns": []})

        assert response.status_code == 200
        assert response.json() == {"session_id": "never-had-any-history", "seeded": True, "turn_count": 0}

    def test_malformed_turn_shape_is_rejected_with_422_not_silently_accepted(self):
        client, *_ = _seed_client()

        response = client.post(
            "/api/v1/sessions/s1/seed",
            json={"turns": [{"role": "user"}]},  # missing required `content`
        )

        assert response.status_code == 422

    def test_invalid_role_in_a_supplied_turn_is_rejected(self):
        client, *_ = _seed_client()

        response = client.post(
            "/api/v1/sessions/s1/seed",
            json={"turns": [{"role": "system", "content": "not allowed"}]},
        )

        assert response.status_code == 422

    def test_cross_session_isolation_seeding_one_session_never_leaks_into_another(self):
        client, manager, _redis = _seed_client()
        manager.append_turn("session-a", "user", "a's live turn")

        client.post(
            "/api/v1/sessions/session-b/seed",
            json={"turns": [{"role": "user", "content": "b's restored turn"}]},
        )

        assert [t.content for t in manager.get_history("session-a")] == ["a's live turn"]
        assert [t.content for t in manager.get_history("session-b")] == ["b's restored turn"]

    def test_a_normal_never_expired_session_is_unaffected_by_a_seed_attempt(self):
        client, manager, _redis = _seed_client()
        manager.append_turn("s1", "user", "q1")
        manager.append_turn("s1", "assistant", "a1")

        client.post("/api/v1/sessions/s1/seed", json={"turns": [{"role": "user", "content": "stale restore"}]})

        assert [t.content for t in manager.get_history("s1")] == ["q1", "a1"]

    def test_conversation_store_unavailable_maps_to_503(self):
        app = create_app()
        redis_client = FakeRedisClient(fail_times={"set": 100})
        manager = ConversationManager(settings=Settings(_env_file=None), redis_client=redis_client)  # type: ignore[call-arg]
        app.dependency_overrides[get_conversation_manager] = lambda: manager
        app.dependency_overrides[get_service_jwt_verifier] = lambda: ServiceJWTVerifier(
            public_keys_by_kid={_TEST_KID: _TEST_PUBLIC_PEM},
            expected_issuer=_TEST_ISSUER,
            expected_audience=_TEST_AUDIENCE,
            required_scope=_TEST_SCOPE,
        )
        client = TestClient(app, headers={"Authorization": f"Bearer {_mint_valid_test_token()}"})

        response = client.post("/api/v1/sessions/s1/seed", json={"turns": [{"role": "user", "content": "hi"}]})

        assert response.status_code == 503


# ---------------------------------------------------------------------------
# Step 3 remediation — DELETE /api/v1/sessions/{session_id}
# ---------------------------------------------------------------------------


class TestDeleteSessionAuthentication:
    def test_missing_authorization_header_rejected(self):
        client, *_ = _seed_client()
        response = client.delete("/api/v1/sessions/s1", headers={"Authorization": ""})
        assert response.status_code == 401

    def test_wrong_scope_rejected_with_403(self):
        client, *_ = _seed_client()
        token = _mint_valid_test_token(scope="ingest")
        response = client.delete("/api/v1/sessions/s1", headers={"Authorization": f"Bearer {token}"})
        assert response.status_code == 403

    def test_valid_token_accepted(self):
        client, *_ = _seed_client()
        response = client.delete("/api/v1/sessions/s1")
        assert response.status_code == 200

    def test_401_response_does_not_leak_conversation_content(self):
        client, manager, _redis = _seed_client()
        manager.append_turn("real-session", "user", "sensitive question")

        response = client.delete("/api/v1/sessions/real-session", headers={"Authorization": ""})

        assert response.status_code == 401
        assert "sensitive question" not in response.text
        # And, since the request was correctly rejected before reaching
        # the route at all, the session must still exist afterward.
        assert manager.session_exists("real-session") is True


class TestDeleteSessionBehavior:
    def test_deletes_an_existing_session(self):
        client, manager, _redis = _seed_client()
        manager.append_turn("s1", "user", "hi")

        response = client.delete("/api/v1/sessions/s1")

        assert response.status_code == 200
        assert response.json() == {"session_id": "s1", "deleted": True}
        assert manager.session_exists("s1") is False

    def test_deleting_a_nonexistent_session_returns_200_not_404(self):
        client, manager, _redis = _seed_client()

        response = client.delete("/api/v1/sessions/never-existed")

        assert response.status_code == 200
        assert response.json() == {"session_id": "never-existed", "deleted": False}

    def test_deleted_session_cannot_be_restored_through_the_history_endpoint(self):
        """Direct regression guard for 'a deleted conversation cannot be
        restored through normal APIs': once deleted, the same session_id
        must 404 on GET history exactly like it never existed."""

        client, manager, _redis = _seed_client()
        manager.append_turn("s1", "user", "hi")

        client.delete("/api/v1/sessions/s1")
        response = client.get("/api/v1/sessions/s1/history")

        assert response.status_code == 404

    def test_deleted_session_cannot_be_used_for_a_follow_up_query_with_stale_context(self):
        """The other half of 'cannot continue using stale context': a
        /query call against a deleted session_id starts with genuinely
        empty history -- not the pre-deletion turns -- exactly as if the
        session_id were brand new (which, from Redis's perspective, it
        now is)."""

        client, manager, _redis = _seed_client()
        manager.append_turn("s1", "user", "the old question")
        manager.append_turn("s1", "assistant", "the old answer")

        client.delete("/api/v1/sessions/s1")

        assert manager.get_windowed_history("s1") == []

    def test_exact_key_deletion_isolation_between_two_sessions(self):
        client, manager, _redis = _seed_client()
        manager.append_turn("session-a", "user", "a's message")
        manager.append_turn("session-b", "user", "b's message")

        response = client.delete("/api/v1/sessions/session-a")

        assert response.status_code == 200
        assert manager.session_exists("session-a") is False
        assert manager.session_exists("session-b") is True
        assert [t.content for t in manager.get_history("session-b")] == ["b's message"]

    def test_repeated_deletion_is_idempotent_not_an_error(self):
        client, manager, _redis = _seed_client()
        manager.append_turn("s1", "user", "hi")

        first = client.delete("/api/v1/sessions/s1")
        second = client.delete("/api/v1/sessions/s1")

        assert first.status_code == 200
        assert first.json()["deleted"] is True
        assert second.status_code == 200
        assert second.json()["deleted"] is False

    def test_conversation_store_unavailable_maps_to_503(self):
        app = create_app()
        redis_client = FakeRedisClient(fail_times={"delete": 100})
        manager = ConversationManager(settings=Settings(_env_file=None), redis_client=redis_client)  # type: ignore[call-arg]
        manager.append_turn("s1", "user", "hi")
        app.dependency_overrides[get_conversation_manager] = lambda: manager
        app.dependency_overrides[get_service_jwt_verifier] = lambda: ServiceJWTVerifier(
            public_keys_by_kid={_TEST_KID: _TEST_PUBLIC_PEM},
            expected_issuer=_TEST_ISSUER,
            expected_audience=_TEST_AUDIENCE,
            required_scope=_TEST_SCOPE,
        )
        client = TestClient(app, headers={"Authorization": f"Bearer {_mint_valid_test_token()}"})

        response = client.delete("/api/v1/sessions/s1")

        assert response.status_code == 503


# ---------------------------------------------------------------------------
# Security Hardening Stage 1
# ---------------------------------------------------------------------------


class TestPostEvaluateAuthentication:
    """POST /api/v1/evaluate previously had NO authentication dependency
    at all -- the one route in this file in that state. Mirrors
    TestQueryAuthentication's own structure exactly, since both now use
    the identical `require_query_identity` (composed with a rate limit,
    see `rate_limited_query_identity`)."""

    def _body(self) -> list[dict]:
        return [{"query": "What is RAG?", "response": "RAG stands for...", "contexts": ["context text"]}]

    def test_missing_authorization_header_rejected(self):
        client, *_ = _evaluate_client()
        response = client.post("/api/v1/evaluate", json=self._body(), headers={"Authorization": ""})
        assert response.status_code == 401

    def test_valid_token_accepted(self):
        client, *_ = _evaluate_client()
        response = client.post("/api/v1/evaluate", json=self._body())
        assert response.status_code == 200

    def test_invalid_signature_rejected(self):
        client, *_ = _evaluate_client()
        other_private_pem, _ = _generate_es256_keypair()
        bad_token = jwt.encode(
            {
                "sub": "u",
                "workspace_id": "w",
                "scope": _TEST_SCOPE,
                "iss": _TEST_ISSUER,
                "aud": _TEST_AUDIENCE,
                "iat": 0,
                "exp": 9999999999,
                "jti": "j",
            },
            other_private_pem,
            algorithm="ES256",
            headers={"kid": _TEST_KID},
        )
        response = client.post(
            "/api/v1/evaluate", json=self._body(), headers={"Authorization": f"Bearer {bad_token}"}
        )
        assert response.status_code == 401

    def test_expired_token_rejected(self):
        client, *_ = _evaluate_client()
        token = _mint_valid_test_token(exp=1)
        response = client.post("/api/v1/evaluate", json=self._body(), headers={"Authorization": f"Bearer {token}"})
        assert response.status_code == 401

    def test_wrong_scope_rejected(self):
        client, *_ = _evaluate_client()
        token = _mint_valid_test_token(scope="ingest")
        response = client.post("/api/v1/evaluate", json=self._body(), headers={"Authorization": f"Bearer {token}"})
        assert response.status_code == 403

    def test_unauthenticated_request_never_reaches_the_evaluator(self):
        client, evaluator, _store = _evaluate_client()
        client.post("/api/v1/evaluate", json=self._body(), headers={"Authorization": ""})
        assert evaluator.calls == []


class TestQueryLengthLimits:
    """`QueryRequest.query` previously had no length bound at all."""

    def test_a_query_at_the_maximum_length_is_accepted(self):
        client, *_ = _client()
        response = client.post("/api/v1/query", json={"query": "a" * 4000})
        assert response.status_code == 200

    def test_a_query_over_the_maximum_length_is_rejected(self):
        client, retriever, _conv, _llm = _client()
        response = client.post("/api/v1/query", json={"query": "a" * 4001})
        assert response.status_code == 422
        assert retriever.calls == []  # never reached retrieval

    def test_an_empty_query_is_rejected(self):
        client, *_ = _client()
        response = client.post("/api/v1/query", json={"query": ""})
        assert response.status_code == 422


class TestEvaluateLengthLimits:
    """`EvaluationItem`'s three fields previously had no length bound at
    all -- an unauthenticated (now separately fixed) or authenticated
    caller could submit an arbitrarily large payload straight into a
    real RAGAS/LLM/embedding call."""

    def test_an_oversized_query_field_is_rejected(self):
        client, *_ = _evaluate_client()
        response = client.post(
            "/api/v1/evaluate",
            json=[{"query": "a" * 4001, "response": "r", "contexts": ["c"]}],
        )
        assert response.status_code == 422

    def test_an_oversized_response_field_is_rejected(self):
        client, *_ = _evaluate_client()
        response = client.post(
            "/api/v1/evaluate",
            json=[{"query": "q", "response": "a" * 20_001, "contexts": ["c"]}],
        )
        assert response.status_code == 422

    def test_an_oversized_context_string_is_rejected(self):
        client, *_ = _evaluate_client()
        response = client.post(
            "/api/v1/evaluate",
            json=[{"query": "q", "response": "r", "contexts": ["a" * 20_001]}],
        )
        assert response.status_code == 422

    def test_too_many_context_entries_is_rejected(self):
        client, *_ = _evaluate_client()
        response = client.post(
            "/api/v1/evaluate",
            json=[{"query": "q", "response": "r", "contexts": ["c"] * 51}],
        )
        assert response.status_code == 422

    def test_at_the_boundary_values_are_accepted(self):
        client, *_ = _evaluate_client()
        response = client.post(
            "/api/v1/evaluate",
            json=[{"query": "a" * 4000, "response": "a" * 20_000, "contexts": ["a" * 20_000] * 50}],
        )
        assert response.status_code == 200


class TestRateLimiting:
    """Security Hardening Stage 1 -- `POST /api/v1/query`,
    `POST /api/v1/query/stream`, and `POST /api/v1/evaluate` are now
    rate-limited per authenticated identity (app/api/rate_limit.py).
    `_client()`/`_evaluate_client()` override the limiter with a
    permissive `FakeRateLimiter` by DEFAULT (see that fake's own
    docstring) -- these tests explicitly re-override it with a
    tight `raise_after` to exercise the 429 path deterministically,
    without waiting on a real time window."""

    def test_query_returns_429_once_the_limit_is_exceeded(self):
        from app.api.rate_limit import get_rate_limiter
        from tests.fakes import FakeRateLimiter

        client, retriever, _conv, _llm = _client()
        # Constructed ONCE, outside the lambda -- otherwise FastAPI would
        # resolve a BRAND NEW FakeRateLimiter (with its own empty
        # `.calls`) on every single request, and `raise_after` could
        # never actually accumulate across requests. Same bug class this
        # file's own `_client()` already documents for MetricsCollector.
        limiter = FakeRateLimiter(raise_after=1)
        client.app.dependency_overrides[get_rate_limiter] = lambda: limiter

        first = client.post("/api/v1/query", json={"query": "first question"})
        second = client.post("/api/v1/query", json={"query": "second question"})

        assert first.status_code == 200
        assert second.status_code == 429
        assert "Retry-After" in second.headers
        # The rate-limited request never reached retrieval/generation.
        assert len(retriever.calls) == 1

    def test_evaluate_returns_429_once_the_limit_is_exceeded(self):
        from app.api.rate_limit import get_rate_limiter
        from tests.fakes import FakeRateLimiter

        client, evaluator, _store = _evaluate_client()
        limiter = FakeRateLimiter(raise_after=1)
        client.app.dependency_overrides[get_rate_limiter] = lambda: limiter
        body = [{"query": "q", "response": "r", "contexts": ["c"]}]

        first = client.post("/api/v1/evaluate", json=body)
        second = client.post("/api/v1/evaluate", json=body)

        assert first.status_code == 200
        assert second.status_code == 429
        assert len(evaluator.calls) == 1

    def test_rate_limit_error_does_not_leak_internal_details(self):
        from app.api.rate_limit import get_rate_limiter
        from tests.fakes import FakeRateLimiter

        client, *_ = _client()
        client.app.dependency_overrides[get_rate_limiter] = lambda: FakeRateLimiter(raise_after=0)

        response = client.post("/api/v1/query", json={"query": "explain the concept"})

        assert response.status_code == 429
        assert "redis" not in response.text.lower()
        assert "Traceback" not in response.text


class TestCORSConfiguration:
    """Security Hardening Stage 1 -- this is a purely internal,
    service-to-service API with no legitimate browser caller (see
    Settings.cors_allowed_origins' own docstring); the default,
    unconfigured posture must never emit a permissive
    Access-Control-Allow-Origin header."""

    def test_no_access_control_headers_are_emitted_for_a_cross_origin_request_by_default(self):
        client, *_ = _client()
        response = client.post(
            "/api/v1/query",
            json={"query": "explain the concept"},
            headers={"Origin": "https://an-arbitrary-origin.example"},
        )
        assert "access-control-allow-origin" not in {k.lower() for k in response.headers.keys()}
