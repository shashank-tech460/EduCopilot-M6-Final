"""Security Hardening Stage 1 -- unit tests for `RedisRateLimiter`
(app/api/rate_limit.py). Exercises the real class against a small,
purpose-built fake Redis client (incr/expire/ttl only -- the narrow
protocol this module actually needs), never a mock of the limiter's own
logic.

ANTI-CIRCULARITY: the fake Redis client is a genuine, independent
in-memory counter implementation (not a wrapper that just returns
whatever the test expects) -- assertions read its actual recorded state.
"""

from __future__ import annotations

import pytest

from app.api.rate_limit import RateLimitExceededError, RedisRateLimiter


class FakeRedisRateLimitClient:
    """A real, independent fixed-window counter (INCR + EXPIRE + TTL),
    not a stand-in that fabricates the answer the test wants."""

    def __init__(self, *, raise_error: Exception | None = None) -> None:
        self._counts: dict[str, int] = {}
        self._ttls: dict[str, int] = {}
        self._raise_error = raise_error
        self.incr_calls: list[str] = []
        self.expire_calls: list[tuple[str, int]] = []

    def incr(self, name: str) -> int:
        if self._raise_error is not None:
            raise self._raise_error
        self.incr_calls.append(name)
        self._counts[name] = self._counts.get(name, 0) + 1
        return self._counts[name]

    def expire(self, name: str, seconds: int) -> None:
        self.expire_calls.append((name, seconds))
        self._ttls[name] = seconds

    def ttl(self, name: str) -> int:
        return self._ttls.get(name, -1)


class TestRedisRateLimiter:
    def test_permits_calls_under_the_limit(self):
        client = FakeRedisRateLimitClient()
        limiter = RedisRateLimiter(client, limit=3, window_seconds=60, key_prefix="test")

        limiter.check("identity-a")
        limiter.check("identity-a")
        limiter.check("identity-a")  # exactly at the limit, still permitted

    def test_raises_once_the_limit_is_exceeded(self):
        client = FakeRedisRateLimitClient()
        limiter = RedisRateLimiter(client, limit=3, window_seconds=60, key_prefix="test")

        for _ in range(3):
            limiter.check("identity-a")

        with pytest.raises(RateLimitExceededError):
            limiter.check("identity-a")

    def test_sets_expiry_only_on_the_first_call_in_a_window(self):
        client = FakeRedisRateLimitClient()
        limiter = RedisRateLimiter(client, limit=5, window_seconds=60, key_prefix="test")

        limiter.check("identity-a")
        limiter.check("identity-a")
        limiter.check("identity-a")

        assert client.expire_calls == [("test:identity-a", 60)]  # exactly once

    def test_different_identities_have_independent_counters(self):
        client = FakeRedisRateLimitClient()
        limiter = RedisRateLimiter(client, limit=2, window_seconds=60, key_prefix="test")

        limiter.check("identity-a")
        limiter.check("identity-a")
        limiter.check("identity-b")  # identity-b's own first call, not shared with a's count

    def test_different_key_prefixes_are_independent_even_for_the_same_identity(self):
        client = FakeRedisRateLimitClient()
        query_limiter = RedisRateLimiter(client, limit=1, window_seconds=60, key_prefix="query")
        evaluate_limiter = RedisRateLimiter(client, limit=1, window_seconds=60, key_prefix="evaluate")

        query_limiter.check("identity-a")
        evaluate_limiter.check("identity-a")  # a separate budget, not shared with query_limiter's

    def test_retry_after_reflects_the_real_ttl(self):
        client = FakeRedisRateLimitClient()
        limiter = RedisRateLimiter(client, limit=1, window_seconds=45, key_prefix="test")

        limiter.check("identity-a")
        with pytest.raises(RateLimitExceededError) as exc_info:
            limiter.check("identity-a")

        assert exc_info.value.retry_after_seconds == 45

    def test_fails_open_never_blocks_a_request_when_redis_is_unavailable(self):
        client = FakeRedisRateLimitClient(raise_error=ConnectionError("redis unreachable"))
        limiter = RedisRateLimiter(client, limit=1, window_seconds=60, key_prefix="test")

        # Must not raise -- a rate limiter outage is a defense-in-depth
        # control, never the primary authorization boundary (that is
        # require_query_identity's JWT check, which fails closed).
        limiter.check("identity-a")
        limiter.check("identity-a")
        limiter.check("identity-a")
