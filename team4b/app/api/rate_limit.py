"""Security Hardening Stage 1 -- lightweight, Redis-backed rate limiting
for Team 4B's expensive operations (`POST /api/v1/query`,
`POST /api/v1/query/stream`, `POST /api/v1/evaluate`): each drives a real
LLM generation or a real RAGAS/embedding batch, so an authenticated but
compromised or misbehaving caller could otherwise drive unbounded
downstream cost with no limit at all.

Deliberately the simplest correct implementation for this scope -- a
fixed-window counter (one Redis INCR + EXPIRE pair per call, no Lua
script, no sliding window, no new third-party dependency) -- reusing the
SAME Redis instance already wired for conversation sessions
(`Settings.redis_url`) rather than introducing a new library or a second
Redis connection pool. This is a defense-in-depth control, not the
primary authorization boundary -- `require_query_identity`'s JWT check
remains that, and fails closed; this fails OPEN on a Redis outage (see
`RedisRateLimiter.check`'s own docstring), matching
`ConversationManager`'s own established fail-open/closed conventions for
non-authoritative infrastructure.

Keyed by the verified JWT identity (`sub`+`workspace_id`), never by
client IP -- this API has no direct browser/end-user caller (see
`app/core/config.py`'s own `cors_allowed_origins` docstring), so the only
meaningful dimension to bound is "how much can THIS authenticated
internal caller do," not a per-IP heuristic that would not discriminate
between Team 4C's own many end users multiplexed behind one internal
service identity.
"""

from __future__ import annotations

import logging
from typing import Any, Protocol

from fastapi import Depends, HTTPException, status

from app.api.auth_dependency import require_query_identity
from app.core.config import Settings, get_settings
from app.security.service_jwt import ServiceIdentity

logger = logging.getLogger(__name__)


class RedisRateLimitClientProtocol(Protocol):
    """The minimal Redis interface this module needs -- mirrors
    `app.services.conversation.RedisClientProtocol`'s own narrow-protocol
    convention, kept separate since this module's needs (incr/expire/ttl)
    don't overlap with that one's (rpush/lrange/set/...)."""

    def incr(self, name: str) -> int: ...

    def expire(self, name: str, seconds: int) -> Any: ...

    def ttl(self, name: str) -> int: ...


class RealRedisRateLimitClient:
    """Real redis-py integration, constructed lazily -- matching
    `RealRedisClient`'s own established convention (importing this
    module, or constructing this class, never opens a connection; only
    an actual method call does)."""

    def __init__(self, url: str) -> None:
        self._url = url
        self._client: Any = None

    def _ensure_client(self) -> Any:
        if self._client is None:
            import redis

            self._client = redis.Redis.from_url(self._url, decode_responses=True)
        return self._client

    def incr(self, name: str) -> int:
        return self._ensure_client().incr(name)  # type: ignore[no-any-return]

    def expire(self, name: str, seconds: int) -> Any:
        return self._ensure_client().expire(name, seconds)

    def ttl(self, name: str) -> int:
        return self._ensure_client().ttl(name)  # type: ignore[no-any-return]


class RateLimitExceededError(Exception):
    def __init__(self, retry_after_seconds: int) -> None:
        self.retry_after_seconds = retry_after_seconds
        super().__init__(f"Rate limit exceeded, retry after {retry_after_seconds}s")


class RedisRateLimiter:
    """Fixed-window counter: at most `limit` calls per `window_seconds`
    for a given key."""

    def __init__(self, redis_client: RedisRateLimitClientProtocol, *, limit: int, window_seconds: int, key_prefix: str) -> None:
        self._redis = redis_client
        self._limit = limit
        self._window_seconds = window_seconds
        self._key_prefix = key_prefix

    def check(self, identity_key: str) -> None:
        """Raises `RateLimitExceededError` once `identity_key` has made
        more than `limit` calls within the current window. A Redis
        failure of any kind is logged and treated as "not rate limited"
        (fails OPEN) -- an infrastructure outage on a non-authoritative,
        defense-in-depth control must never block this product's real
        query/evaluation traffic, which the JWT check above has already
        authenticated."""

        redis_key = f"{self._key_prefix}:{identity_key}"
        try:
            count = self._redis.incr(redis_key)
            if count == 1:
                self._redis.expire(redis_key, self._window_seconds)
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "Rate limiter Redis call failed; failing open for this request",
                extra={"key_prefix": self._key_prefix, "error_type": type(exc).__name__},
            )
            return

        if count > self._limit:
            try:
                ttl = self._redis.ttl(redis_key)
            except Exception:  # noqa: BLE001
                ttl = self._window_seconds
            raise RateLimitExceededError(retry_after_seconds=ttl if ttl and ttl > 0 else self._window_seconds)


def get_rate_limiter(settings: Settings = Depends(get_settings)) -> RedisRateLimiter:
    return RedisRateLimiter(
        RealRedisRateLimitClient(settings.redis_url),
        limit=settings.rate_limit_requests_per_window,
        window_seconds=settings.rate_limit_window_seconds,
        key_prefix="ratelimit:expensive-op",
    )


def rate_limited_query_identity(
    identity: ServiceIdentity = Depends(require_query_identity),
    limiter: RedisRateLimiter = Depends(get_rate_limiter),
) -> ServiceIdentity:
    """Composes authentication (`require_query_identity`, unchanged,
    still fails closed) with the rate-limit check above, keyed by the
    now-verified identity's own `sub`+`workspace_id`. Drop-in replacement
    for `require_query_identity` on the three expensive routes -- returns
    the exact same `ServiceIdentity`, so callers/route signatures are
    otherwise unaffected. A 429 (not 401/403 -- this is neither an
    authentication nor an authorization failure) carries `Retry-After` so
    a well-behaved caller knows when it may safely retry.
    """

    try:
        limiter.check(f"{identity.sub}:{identity.workspace_id}")
    except RateLimitExceededError as exc:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Rate limit exceeded. Please slow down and retry later.",
            headers={"Retry-After": str(exc.retry_after_seconds)},
        ) from exc
    return identity
