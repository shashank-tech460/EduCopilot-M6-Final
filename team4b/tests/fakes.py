"""An in-memory Qdrant fake that genuinely stores and queries data.

Distinct from `FakeQdrantClient` in `test_vector_store.py` (which records
calls to verify VectorStoreManager's own control flow -- retries,
batching, argument-passing). This fake exists specifically for Task 2.2's
property tests, which must exercise a real store-then-retrieve round trip
through VectorStoreManager's own public methods (upsert_chunk/
upsert_batch, search_similar, delete_by_document) -- not just inspect
what VectorStoreManager *would have sent* to a real Qdrant server.

Implements exactly the same `QdrantClientProtocol` VectorStoreManager
depends on. No network calls, no live Qdrant server required.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any, Iterator, Sequence

from qdrant_client.models import ScoredPoint


def _condition_matches(payload: dict[str, Any], condition: Any) -> bool:
    """Evaluate one FieldCondition (MatchValue or MatchAny) against a payload."""

    value = payload.get(condition.key)
    match = condition.match
    if hasattr(match, "value"):  # MatchValue
        return bool(value == match.value)
    if hasattr(match, "any"):  # MatchAny
        return value in match.any
    raise NotImplementedError(f"Unsupported match type in test fake: {match!r}")


def _filter_matches(payload: dict[str, Any], query_filter: Any | None) -> bool:
    if query_filter is None:
        return True
    return all(_condition_matches(payload, condition) for condition in query_filter.must)


def _cosine_similarity(a: Sequence[float], b: Sequence[float]) -> float:
    if len(a) != len(b) or not a:
        return 0.0
    dot: float = sum(x * y for x, y in zip(a, b))
    norm_a: float = sum(x * x for x in a) ** 0.5
    norm_b: float = sum(y * y for y in b) ** 0.5
    if norm_a == 0.0 or norm_b == 0.0:
        return 0.0
    return float(dot / (norm_a * norm_b))


class InMemoryQdrantClient:
    """A single-collection-aware, genuinely-stateful Qdrant fake."""

    def __init__(self) -> None:
        # collection_name -> {"vector_size": int, "distance": Any, "points": {point_id: {"vector":..., "payload":...}}}
        self._collections: dict[str, dict[str, Any]] = {}
        self._indexed_fields: dict[str, set[str]] = {}

    # -- collection management ------------------------------------------

    def get_collections(self) -> Any:
        return SimpleNamespace(collections=[SimpleNamespace(name=name) for name in self._collections])

    def get_collection(self, collection_name: str) -> Any:
        collection = self._collections[collection_name]
        vectors = SimpleNamespace(size=collection["vector_size"], distance=collection["distance"])
        return SimpleNamespace(config=SimpleNamespace(params=SimpleNamespace(vectors=vectors)))

    def create_collection(self, collection_name: str, vectors_config: Any) -> Any:
        self._collections[collection_name] = {
            "vector_size": vectors_config.size,
            "distance": vectors_config.distance,
            "points": {},
        }
        self._indexed_fields.setdefault(collection_name, set())
        return True

    def create_payload_index(self, collection_name: str, field_name: str, field_schema: Any) -> Any:
        self._indexed_fields.setdefault(collection_name, set()).add(field_name)
        return True

    # -- data operations ---------------------------------------------------

    def upsert(self, collection_name: str, points: Sequence[Any]) -> Any:
        store = self._collections[collection_name]["points"]
        for point in points:
            # Real Qdrant upsert semantics: same point ID overwrites the
            # previous record entirely (used by P1's round-trip test to
            # confirm re-upserting the same chunk_id doesn't duplicate).
            store[str(point.id)] = {"vector": list(point.vector), "payload": dict(point.payload)}
        return True

    def delete(self, collection_name: str, points_selector: Any) -> Any:
        store = self._collections[collection_name]["points"]
        query_filter = points_selector.filter
        to_delete = [
            point_id for point_id, data in store.items() if _filter_matches(data["payload"], query_filter)
        ]
        for point_id in to_delete:
            del store[point_id]
        return True

    def search(
        self,
        collection_name: str,
        query_vector: Sequence[float],
        limit: int,
        score_threshold: float | None = None,
        query_filter: Any | None = None,
    ) -> Any:
        store = self._collections[collection_name]["points"]
        results: list[ScoredPoint] = []
        for point_id, data in store.items():
            if not _filter_matches(data["payload"], query_filter):
                continue
            score = _cosine_similarity(query_vector, data["vector"])
            if score_threshold is not None and score < score_threshold:
                continue
            results.append(ScoredPoint(id=point_id, version=0, score=score, payload=data["payload"], vector=None))
        results.sort(key=lambda point: point.score, reverse=True)
        return results[:limit]

    def scroll(
        self,
        collection_name: str,
        limit: int,
        offset: Any | None = None,
    ) -> Any:
        """Simplified pagination for test purposes: `offset` is an
        integer index into insertion order (dict order), not Qdrant's
        real opaque offset type -- adequate for a fake never used
        outside this test suite.
        """

        store = self._collections[collection_name]["points"]
        items = list(store.items())
        start = int(offset) if offset is not None else 0
        batch = items[start : start + limit]
        next_offset = start + limit if start + limit < len(items) else None
        records = [SimpleNamespace(id=point_id, payload=data["payload"]) for point_id, data in batch]
        return records, next_offset

    # -- test-only introspection helpers ------------------------------------

    def all_points(self, collection_name: str) -> dict[str, Any]:
        """Direct access to stored points, for assertions a real Qdrant
        client wouldn't expose this conveniently -- used only to assert
        deletion completeness (nothing left / correct things left), not
        to bypass VectorStoreManager's own public API for the actions
        under test (upsert/search/delete all still go through it).
        """

        return dict(self._collections[collection_name]["points"])


# ---------------------------------------------------------------------------
# Fake Redis client (Task 4.1) -- genuinely stores list data and tracks
# TTL/expire calls, so ConversationManager tests exercise real
# store-then-retrieve behavior, not merely call recording.
# ---------------------------------------------------------------------------


class FakeRedisPipeline:
    """Mimics redis-py's chainable Pipeline: queued commands only take
    effect on `execute()`, matching the real client's batching semantics
    closely enough for ConversationManager's own atomic
    RPUSH+EXPIRE usage.
    """

    def __init__(self, client: "FakeRedisClient") -> None:
        self._client = client
        self._queued: list[tuple[str, tuple[Any, ...]]] = []

    def rpush(self, name: str, *values: str) -> "FakeRedisPipeline":
        self._queued.append(("rpush", (name, *values)))
        return self

    def expire(self, name: str, time: int) -> "FakeRedisPipeline":
        self._queued.append(("expire", (name, time)))
        return self

    def execute(self) -> list[Any]:
        self._client._maybe_fail("pipeline_execute")
        results = []
        for command, args in self._queued:
            if command == "rpush":
                results.append(self._client.rpush(*args))
            elif command == "expire":
                results.append(self._client.expire(*args))
        self._queued = []
        return results


class FakeRedisClient:
    """In-memory stand-in for redis-py's `Redis`, implementing exactly
    the subset `ConversationManager` depends on (`RedisClientProtocol`).

    `fail_times` lets tests simulate N transient failures before a given
    method starts succeeding, mirroring `FakeQdrantClient`'s own
    convention (Task 2.1) for deterministic retry/error-path tests.
    """

    def __init__(self, fail_times: dict[str, int] | None = None, ping_result: bool = True) -> None:
        self._lists: dict[str, list[str]] = {}
        self._ttls: dict[str, int] = {}
        self._strings: dict[str, str] = {}
        self._fail_times = dict(fail_times or {})
        self._ping_result = ping_result
        self.expire_calls: list[tuple[str, int]] = []
        self.set_calls: list[tuple[str, str, bool, int | None]] = []

    def _maybe_fail(self, method: str) -> None:
        remaining = self._fail_times.get(method, 0)
        if remaining > 0:
            self._fail_times[method] = remaining - 1
            raise ConnectionError(f"simulated transient Redis failure in {method}")

    def rpush(self, name: str, *values: str) -> int:
        self._maybe_fail("rpush")
        self._lists.setdefault(name, []).extend(values)
        return len(self._lists[name])

    def lrange(self, name: str, start: int, end: int) -> list[Any]:
        self._maybe_fail("lrange")
        items = self._lists.get(name, [])
        if not items:
            return []
        # Python slicing already matches Redis LRANGE's inclusive-end,
        # negative-index semantics closely enough for this fake's needs,
        # except LRANGE's end is inclusive where Python's slice end is
        # exclusive -- adjust by +1 (with the usual "-1 means to the
        # very end" special case).
        stop = None if end == -1 else end + 1
        return items[start:stop]

    def exists(self, *names: str) -> int:
        self._maybe_fail("exists")
        return sum(1 for name in names if name in self._lists)

    def ping(self) -> bool:
        # ADDED IN TASK 10.1: `_maybe_fail` supports simulating an
        # exception (e.g. connection refused); `ping_result=False`
        # separately supports simulating "reachable but responded
        # unhealthy" without raising -- both are genuinely distinct
        # failure modes `ConversationManager.check_health()` must handle.
        self._maybe_fail("ping")
        return self._ping_result

    def expire(self, name: str, time: int) -> bool:
        self._maybe_fail("expire")
        if name not in self._lists:
            return False
        self._ttls[name] = time
        self.expire_calls.append((name, time))
        return True

    def pipeline(self, transaction: bool = True) -> FakeRedisPipeline:
        return FakeRedisPipeline(self)

    def set(self, name: str, value: str, *, nx: bool = False, ex: int | None = None) -> bool:
        # Genuine `SET NX` semantics (not just call-recording) -- the
        # restoration lock's correctness (ConversationManager.seed_history)
        # depends on this actually refusing to overwrite an existing key
        # when nx=True, exactly like real Redis.
        self._maybe_fail("set")
        self.set_calls.append((name, value, nx, ex))
        if nx and name in self._strings:
            return False
        self._strings[name] = value
        return True

    def delete(self, *names: str) -> int:
        self._maybe_fail("delete")
        deleted = 0
        for name in names:
            if name in self._strings:
                del self._strings[name]
                deleted += 1
            if name in self._lists:
                del self._lists[name]
                self._ttls.pop(name, None)
                deleted += 1
        return deleted

    # -- test-only introspection helpers ------------------------------------

    def ttl_for(self, name: str) -> int | None:
        """Last TTL (in seconds) set via `expire()` for `name`, or None
        if `expire` was never called for it. This fake does not actually
        count down or expire keys over time -- see the Task 4.1 report's
        limitations for why real TTL countdown behavior isn't simulated.
        """

        return self._ttls.get(name)

    def raw_entries(self, name: str) -> list[str]:
        return list(self._lists.get(name, []))

    def inject_raw_entry(self, name: str, raw_value: str) -> None:
        """Directly inject a raw (possibly malformed) string into a
        list, bypassing ConversationManager entirely -- used only to
        test deserialization/corruption handling against data
        ConversationManager itself would never have written.
        """

        self._lists.setdefault(name, []).append(raw_value)


# ---------------------------------------------------------------------------
# Fake LLM client (Task 6.1) -- deterministic, injectable stand-in for
# app.services.llm_generator.RealOllamaClient, so LLMGenerator tests
# never require a live Ollama server.
# ---------------------------------------------------------------------------


class FakeLLMClient:
    """Implements LLMClientProtocol without a live Ollama server.

    `fail_times` lets tests simulate N transient failures before
    `generate()` starts succeeding, mirroring `FakeQdrantClient`'s own
    convention (Task 2.1). `response` is returned verbatim on success;
    set `raise_error` to have every call raise that exception instead
    (simulating a client-level failure that isn't itself
    LLMUnavailableError, to test LLMGenerator's own wrapping behavior).
    """

    def __init__(
        self,
        response: str = "This is a generated answer.",
        fail_times: int = 0,
        raise_error: Exception | None = None,
        health_result: bool = True,
        stream_fragments: list[str] | None = None,
        stream_raise_after: int | None = None,
    ) -> None:
        self.response = response
        self._fail_times = fail_times
        self._raise_error = raise_error
        self._health_result = health_result
        # Stage 9B: `generate_stream()`'s own configuration. Defaults to
        # yielding `response` as a SINGLE fragment (the simplest possible
        # streaming behavior) -- pass `stream_fragments` explicitly to
        # simulate real chunked delivery (e.g. splitting a JSON response
        # into small pieces, to exercise `_IncrementalAnswerExtractor`'s
        # own fragment-boundary handling). `stream_raise_after` simulates
        # a connection failure partway through an in-progress stream,
        # after that many fragments have already been yielded.
        self._stream_fragments = stream_fragments
        self._stream_raise_after = stream_raise_after
        self.calls: list[dict[str, Any]] = []
        self.stream_calls: list[dict[str, Any]] = []
        self.check_health_calls: int = 0

    def generate(
        self,
        model: str,
        prompt: str,
        timeout: float,
        *,
        num_gpu: int | None = None,
        num_predict: int | None = None,
        format: dict[str, Any] | None = None,
    ) -> str:
        self.calls.append(
            {
                "model": model,
                "prompt": prompt,
                "timeout": timeout,
                "num_gpu": num_gpu,
                "num_predict": num_predict,
                "format": format,
            }
        )
        if self._raise_error is not None:
            raise self._raise_error
        if self._fail_times > 0:
            self._fail_times -= 1
            raise ConnectionError("simulated transient Ollama failure")
        return self.response

    def generate_stream(
        self,
        model: str,
        prompt: str,
        timeout: float,
        *,
        num_gpu: int | None = None,
        num_predict: int | None = None,
        format: dict[str, Any] | None = None,
    ) -> Iterator[str]:
        self.stream_calls.append(
            {
                "model": model,
                "prompt": prompt,
                "timeout": timeout,
                "num_gpu": num_gpu,
                "num_predict": num_predict,
                "format": format,
            }
        )
        if self._raise_error is not None:
            raise self._raise_error
        if self._fail_times > 0:
            self._fail_times -= 1
            raise ConnectionError("simulated transient Ollama failure")
        fragments = self._stream_fragments if self._stream_fragments is not None else [self.response]
        for index, fragment in enumerate(fragments):
            if self._stream_raise_after is not None and index >= self._stream_raise_after:
                raise ConnectionError("simulated mid-stream Ollama failure")
            yield fragment

    def check_health(self) -> bool:
        # ADDED IN TASK 10.1. Independent of `generate()`'s own
        # failure simulation -- health checks must never trigger a real
        # generation call, so this is deliberately a separate method
        # with its own controllable result.
        self.check_health_calls += 1
        return self._health_result


# ---------------------------------------------------------------------------
# Fake RAGAS evaluator (Task 9.1) -- deterministic, injectable stand-in for
# app.services.ragas_adapter.RagasEvaluationAdapter, so EvaluationPipeline
# tests never require live RAGAS/Ollama/embedding execution.
# ---------------------------------------------------------------------------


class FakeRagasEvaluator:
    """Implements RagasEvaluatorProtocol without live RAGAS/LLM/embeddings.

    By default returns a fixed set of metric values for every item,
    with `context_recall` structurally unavailable (`None` + a fixed
    reason string) BY DEFAULT -- mirroring the corrected real
    `RagasEvaluationAdapter`'s behavior (Task 9.1 remediation:
    `context_recall` cannot be validly computed from the official
    `query`/`response`/`contexts` contract alone, so the real adapter
    never fabricates a value for it). `default_metrics`/`default_errors`
    let a test override this baseline (e.g. to exercise generic
    aggregation math against a hypothetical evaluator that DOES supply a
    numeric `context_recall`); `per_item_overrides` lets a test specify,
    by index, a `(metrics_dict, errors_dict)` pair instead -- used to
    simulate partial metric failures or whole-item failures
    deterministically. `raise_error`, if set, makes the whole batch call
    raise instead of returning (simulating a total evaluator/dependency
    failure).
    """

    def __init__(
        self,
        default_metrics: dict[str, float | None] | None = None,
        default_errors: dict[str, str] | None = None,
        per_item_overrides: dict[int, tuple[dict[str, float | None], dict[str, str]]] | None = None,
        raise_error: Exception | None = None,
    ) -> None:
        self.default_metrics = default_metrics or {
            "faithfulness": 0.9,
            "answer_relevancy": 0.85,
            "context_precision": 0.8,
            "context_recall": None,
        }
        self.default_errors = (
            default_errors
            if default_errors is not None
            else {
                "context_recall": (
                    "independent reference answer required (simulated default, mirrors "
                    "RagasEvaluationAdapter's Task 9.1 remediation)"
                )
            }
        )
        self._per_item_overrides = per_item_overrides or {}
        self._raise_error = raise_error
        self.calls: list[list[Any]] = []

    def evaluate_batch(self, items: Any) -> list[tuple[Any, dict[str, str]]]:
        from app.models.evaluation import EvaluationMetrics

        items_list = list(items)
        self.calls.append(items_list)

        if self._raise_error is not None:
            raise self._raise_error

        results = []
        for index in range(len(items_list)):
            if index in self._per_item_overrides:
                metrics_dict, errors = self._per_item_overrides[index]
            else:
                metrics_dict, errors = dict(self.default_metrics), dict(self.default_errors)
            results.append((EvaluationMetrics(**metrics_dict), errors))
        return results


class FakeRateLimiter:
    """Security Hardening Stage 1 -- stands in for `RedisRateLimiter`
    (app/api/rate_limit.py) in tests that exercise `/api/v1/query`,
    `/api/v1/query/stream`, or `/api/v1/evaluate` for reasons OTHER than
    rate limiting itself. Permits every call by default (never touches a
    real Redis instance): without this, this suite's ~1400 tests --
    nearly all reusing the same fixed test JWT identity via
    `tests/test_api.py`'s own `_client()` helper -- would collectively
    exceed any real rate limit within one test run, failing unrelated
    tests with 429s that have nothing to do with what they're actually
    testing. Set `raise_after` to simulate the limit being hit on a
    specific call number, for tests that DO exercise rate-limiting
    behavior itself.
    """

    def __init__(self, raise_after: int | None = None, retry_after_seconds: int = 30) -> None:
        self._raise_after = raise_after
        self._retry_after_seconds = retry_after_seconds
        self.calls: list[str] = []

    def check(self, identity_key: str) -> None:
        from app.api.rate_limit import RateLimitExceededError

        self.calls.append(identity_key)
        if self._raise_after is not None and len(self.calls) > self._raise_after:
            raise RateLimitExceededError(retry_after_seconds=self._retry_after_seconds)
