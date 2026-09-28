"""Team 4B ConversationManager (Task 4.1).

Implements the Redis-backed conversation-history primitives needed by
Requirement 4 (Conversational Query API) and Requirement 5 (Multi-Turn
Conversation): appending user/assistant turns, reading full history, and
reading a bounded conversation window -- feeding, but not implementing,
Properties 13-14 (Task 4.2) and the eventual `/api/v1/query` /
`/api/v1/sessions/{id}/history` routes (Task 8.1).

APPROVED CONTRACT (from the official specification, verbatim structure):

    Redis key:   session:{session_id}
    Stored value: a Redis list of JSON turns, each shaped:
        {"role": "user" | "assistant", "content": str, "timestamp": float}

SCOPE NOTE (Task 4.1 only): this module does NOT implement:
  - Task 4.2's property tests (P13: history append round-trip, P14:
    conversation window bound).
  - Reference resolution, summarization, or any other Requirement 5
    orchestration logic (that belongs to a later RAGService/prompt-
    construction task).
  - Session auto-creation as a distinct HTTP-facing concept, or any API
    route (`/api/v1/query`, `/api/v1/sessions/{id}/history` are Task
    8.1). What this module DOES provide is the primitive Task 8.1 will
    need: `append_turn` creates a session implicitly (a Redis list key
    springs into existence on its first RPUSH -- there is no separate
    Redis "create an empty list" operation), so "auto-create when
    absent" is naturally satisfied by simply calling `append_turn`;
    nothing here invents a distinct session-creation API surface beyond
    that.

MINIMAL MODEL NOTE (consistent with the precedent already set in Task
2.1's `ContextChunk` and Task 1.2's still-outstanding status -- see this
task's report for the flagged discrepancy about Task 1.2's actual
completion state): `ConversationTurn` is a small dataclass here, not a
Task-1.2 Pydantic model, because Task 1.2 has not actually been
implemented in this workspace despite being listed as already-approved
in this task's brief. Its shape is exactly what the official
specification states verbatim (role/content/timestamp), so this is not
an invented contract.

DOCUMENTED INTERPRETATION -- "TTL resets on interaction": the official
wording doesn't specify whether a mere *read* (`get_history`) counts as
an "interaction" that renews the TTL, or only a *write* (a new turn
being appended). This implementation renews the TTL only on
`append_turn` -- reading history never touches the TTL. Rationale: a
"turn" is the natural unit of "an interaction" in a conversational
system, and letting reads alone keep a session alive indefinitely (e.g.
an admin or debugging tool repeatedly calling `get_history`) would give
TTL a different, wider meaning than "conversation session inactivity"
implies. This is a judgment call on ambiguous wording, not something the
specification states outright -- flagged in the Task 4.1 report rather
than presented as unambiguous.

DOCUMENTED INTERPRETATION -- Redis failure handling: neither the
Conversational-Query nor Multi-Turn-Conversation requirement defines a
concrete "graceful Redis degradation" mechanism at the ConversationManager
level (a Phase-1 analysis ambiguity, carried forward unresolved). Rather
than inventing a fallback (e.g. silently proceeding with no history),
every Redis operation failure here raises a typed
`ConversationStoreUnavailableError` -- consistent with this project's
existing `VectorStoreUnavailableError` pattern (Task 2.1). No retry/
backoff is implemented (unlike `VectorStoreManager`'s Requirement-1.5-
mandated retries): neither Requirement 4 nor 5 specifies retry behavior
for Redis, so none is added. Whether/how a caller degrades gracefully
(e.g. a future RAGService orchestrator proceeding without history) is
explicitly left to that later task, not decided here.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from typing import Any, Callable, Literal, Protocol

from app.core.config import Settings, get_settings

_VALID_ROLES: frozenset[str] = frozenset({"user", "assistant"})


@dataclass(frozen=True)
class ConversationTurn:
    """One stored conversation turn, matching the official specification's
    stored-value shape exactly: `{"role", "content", "timestamp"}`.
    """

    role: Literal["user", "assistant"]
    content: str
    timestamp: float


class InvalidConversationRoleError(ValueError):
    """Raised when `append_turn` is called with a role outside
    {"user", "assistant"} (official specification's role restriction).
    """


class ConversationHistoryCorruptionError(Exception):
    """Raised when a stored Redis list entry cannot be parsed into a
    valid `ConversationTurn` -- malformed JSON, a missing required field,
    an invalid role, or a wrong-typed field. Per the explicit instruction
    that malformed stored data must never be silently converted into
    valid-looking conversation data, this is raised rather than skipped,
    defaulted, or coerced.
    """


class ConversationStoreUnavailableError(Exception):
    """Raised when a Redis operation fails. See the module docstring's
    "Documented interpretation -- Redis failure handling" for why no
    fallback/retry is attempted here.
    """

    def __init__(self, message: str, *, last_error: Exception | None = None) -> None:
        super().__init__(message)
        self.last_error = last_error


# ---------------------------------------------------------------------------
# Redis client abstraction (mirrors, independently, the same lazy-
# construction / injectable-protocol pattern already used for Qdrant in
# Task 2.1's VectorStoreManager, so unit tests never require a live Redis
# server)
# ---------------------------------------------------------------------------


class RedisPipelineProtocol(Protocol):
    """The minimal interface ConversationManager needs from a Redis
    pipeline, matching redis-py's own chainable `Pipeline` methods."""

    def rpush(self, name: str, *values: str) -> Any: ...

    def expire(self, name: str, time: int) -> Any: ...

    def execute(self) -> list[Any]: ...


class RedisClientProtocol(Protocol):
    """The minimal interface ConversationManager needs from a Redis
    client."""

    def rpush(self, name: str, *values: str) -> Any: ...

    def lrange(self, name: str, start: int, end: int) -> list[Any]: ...

    def exists(self, *names: str) -> int: ...

    def ping(self) -> bool: ...

    def pipeline(self, transaction: bool = True) -> RedisPipelineProtocol: ...

    def set(self, name: str, value: str, *, nx: bool = False, ex: int | None = None) -> Any: ...

    def delete(self, *names: str) -> Any: ...


class RealRedisClient:
    """Real redis-py integration. Constructed lazily inside
    `_ensure_client()`, matching this project's established convention
    (`RealQdrantClient`, `RealEmbeddingModel`): importing this module, or
    even constructing a `ConversationManager`, never opens a connection;
    only an actual method call does.
    """

    def __init__(self, url: str) -> None:
        self._url = url
        self._client: Any = None

    def _ensure_client(self) -> Any:
        if self._client is None:
            import redis

            self._client = redis.Redis.from_url(self._url, decode_responses=True)
        return self._client

    def rpush(self, name: str, *values: str) -> Any:
        return self._ensure_client().rpush(name, *values)

    def lrange(self, name: str, start: int, end: int) -> list[Any]:
        return self._ensure_client().lrange(name, start, end)  # type: ignore[no-any-return]

    def exists(self, *names: str) -> int:
        return self._ensure_client().exists(*names)  # type: ignore[no-any-return]

    def ping(self) -> bool:
        return self._ensure_client().ping()  # type: ignore[no-any-return]

    def pipeline(self, transaction: bool = True) -> RedisPipelineProtocol:
        return self._ensure_client().pipeline(transaction=transaction)  # type: ignore[no-any-return]

    def set(self, name: str, value: str, *, nx: bool = False, ex: int | None = None) -> Any:
        return self._ensure_client().set(name, value, nx=nx, ex=ex)

    def delete(self, *names: str) -> Any:
        return self._ensure_client().delete(*names)


# ---------------------------------------------------------------------------
# ConversationManager
# ---------------------------------------------------------------------------


class ConversationManager:
    """Redis-backed conversation history for Requirement 4/5.

    Redis URL, session TTL, and conversation window size are all read
    from `Settings` (never hardcoded), reusing the exact fields Task 1.1
    already defined (`redis_url`, `session_ttl_minutes`,
    `conversation_window_size`) -- no second configuration system.
    """

    def __init__(
        self,
        settings: Settings | None = None,
        redis_client: RedisClientProtocol | None = None,
        clock: Callable[[], float] | None = None,
    ) -> None:
        self._settings = settings or get_settings()
        self._redis = redis_client or RealRedisClient(self._settings.redis_url)
        self._clock = clock or time.time

    @staticmethod
    def _session_key(session_id: str) -> str:
        return f"session:{session_id}"

    def check_health(self) -> bool:
        """ADDED IN TASK 10.1. Lightweight Redis reachability check for
        `GET /health`: a single `PING`, no retry (see
        `VectorStoreManager.check_health()`'s docstring for the same
        "fast current state, not resiliently retried" reasoning). Never
        raises -- returns `False` on any failure.
        """

        try:
            return bool(self._redis.ping())
        except Exception:  # noqa: BLE001
            return False

    # -- Write path --------------------------------------------------------

    def append_turn(
        self,
        session_id: str,
        role: Literal["user", "assistant"],
        content: str,
        timestamp: float | None = None,
    ) -> ConversationTurn:
        """Append one turn to `session_id`'s history and renew the
        session's TTL to `Settings.session_ttl_minutes` (converted to
        seconds), in a single Redis pipeline (RPUSH + EXPIRE) so the two
        operations are sent and applied together rather than leaving an
        obvious window where the list exists with a stale or absent TTL.

        This is also how a session is implicitly created: RPUSH creates
        the underlying Redis list key on its first call for a given
        `session_id` -- see the module docstring's scope note.

        Raises `InvalidConversationRoleError` for any role outside
        {"user", "assistant"}, and `ConversationStoreUnavailableError` if
        the Redis operation fails.
        """

        if role not in _VALID_ROLES:
            raise InvalidConversationRoleError(
                f"role must be one of {sorted(_VALID_ROLES)}, got {role!r}"
            )

        turn = ConversationTurn(role=role, content=content, timestamp=timestamp if timestamp is not None else self._clock())
        serialized = json.dumps({"role": turn.role, "content": turn.content, "timestamp": turn.timestamp})
        key = self._session_key(session_id)
        ttl_seconds = int(self._settings.session_ttl_minutes * 60)

        try:
            pipeline = self._redis.pipeline(transaction=True)
            pipeline.rpush(key, serialized)
            pipeline.expire(key, ttl_seconds)
            pipeline.execute()
        except Exception as exc:  # noqa: BLE001 -- any Redis client failure is reported uniformly
            raise ConversationStoreUnavailableError(
                f"Failed to append turn for session {session_id!r}", last_error=exc
            ) from exc

        return turn

    # -- Read path -----------------------------------------------------------

    def get_history(self, session_id: str) -> list[ConversationTurn]:
        """Return the COMPLETE conversation history for `session_id`, in
        chronological (append) order. Returns an empty list for a
        session that doesn't exist or has expired -- not an error --
        since "no history yet" is an entirely ordinary state, not a
        failure.

        This is the primitive behind the official GET
        `/api/v1/sessions/{session_id}/history` requirement's "complete
        history" wording (Task 8.1 will expose it over HTTP) -- it is
        deliberately NOT bounded by the conversation window; see
        `get_windowed_history` for the bounded variant used for LLM
        prompting.
        """

        return self._read_range(session_id, start=0, end=-1)

    def get_windowed_history(self, session_id: str, window_size: int | None = None) -> list[ConversationTurn]:
        """Return only the most recent `window_size` turns (default
        `Settings.conversation_window_size`), in chronological order --
        the bounded view Requirement 5.3 says feeds the LLM prompt.

        Never mutates or trims what's stored in Redis (no LTRIM) -- full
        history remains available via `get_history` regardless of how
        many times this is called. `window_size <= 0` returns an empty
        list without a Redis round-trip.
        """

        size = window_size if window_size is not None else self._settings.conversation_window_size
        if size <= 0:
            return []
        return self._read_range(session_id, start=-size, end=-1)

    def seed_history(
        self,
        session_id: str,
        turns: list[tuple[Literal["user", "assistant"], str, float | None]],
    ) -> bool:
        """Restore `session_id`'s history from an external source (Team 4C's
        durable MongoDB store) after its Redis session has expired.

        Returns `True` if this call actually wrote the seed turns, `False`
        if it was a safe no-op (the session already existed, or a
        concurrent seed was already in progress) -- callers should not
        treat `False` as an error; it means restoration was unnecessary or
        already handled elsewhere.

        RELIABILITY (STEP 8 CORRECTION): an earlier version of this method
        wrote each turn via a SEPARATE call to `append_turn()` in a plain
        Python loop -- each call was its own independent Redis
        round-trip/pipeline, so a failure partway through (e.g. turn 3 of
        5) left the session PARTIALLY seeded: the Redis key now existed
        (from turns 1-2), so `session_exists()` was permanently `True`
        from then on, and every future retry would see the session as
        "already existing" and silently no-op FOREVER -- a corrected-cause
        retry could never actually complete the restoration. Fixed here by
        writing ALL turns in a SINGLE Redis pipeline (one `RPUSH key v1 v2
        ... vN` + one `EXPIRE`, executed once): either the entire batch is
        applied, or (if the pipeline/execute call fails) NONE of it is --
        the session key is never left in a half-written state. A failed
        attempt therefore leaves `session_exists()` still `False`, so a
        later retry (once the transient Redis issue clears) proceeds and
        completes normally, rather than being permanently blocked by its
        own prior partial failure. All `turns` are role-validated BEFORE
        any write is attempted, for the same reason -- an invalid entry
        discovered mid-write would otherwise itself produce a partial
        write.

        IDEMPOTENCY / CONCURRENCY: guarded by a short-lived Redis lock
        (`SET session_lock:{id} NX EX 30`), so at most one concurrent
        caller for the same `session_id` ever actually writes turns --
        every other concurrent or repeated call sees either the lock
        already held or (after acquiring it) `session_exists()` already
        `True`, and no-ops instead of duplicating history. The lock
        self-expires after 30s as a backstop if this process crashes
        mid-seed, so a stuck lock can never permanently block future
        restoration attempts. ACTIVE SESSIONS ARE NEVER OVERWRITTEN: the
        `session_exists()` check (after acquiring the lock, so it observes
        the latest state) means a session created by genuine live
        conversation traffic -- or by a concurrent restoration that
        finished first -- is left completely untouched.

        `turns` is truncated to the most recent `Settings.conversation_window_size`
        entries before writing -- restoring more than the window
        `RAGService` ever actually reads would be pure waste, and this
        keeps a restored session's effective context identical to what a
        live, never-expired session would have used for prompting anyway.
        """

        window = self._settings.conversation_window_size
        bounded_turns = turns[-window:] if window > 0 else []

        for role, _content, _timestamp in bounded_turns:
            if role not in _VALID_ROLES:
                raise InvalidConversationRoleError(
                    f"role must be one of {sorted(_VALID_ROLES)}, got {role!r}"
                )

        lock_key = f"session_lock:{session_id}"
        try:
            lock_acquired = bool(self._redis.set(lock_key, "1", nx=True, ex=30))
        except Exception as exc:  # noqa: BLE001
            raise ConversationStoreUnavailableError(
                f"Failed to acquire restoration lock for session {session_id!r}", last_error=exc
            ) from exc

        if not lock_acquired:
            return False

        try:
            if self.session_exists(session_id):
                return False

            if not bounded_turns:
                # Nothing to write -- a genuinely empty history is a safe,
                # successful no-op (there is nothing that could ever be
                # duplicated by a later retry either).
                return True

            key = self._session_key(session_id)
            ttl_seconds = int(self._settings.session_ttl_minutes * 60)
            serialized_entries = [
                json.dumps(
                    {
                        "role": role,
                        "content": content,
                        "timestamp": timestamp if timestamp is not None else self._clock(),
                    }
                )
                for role, content, timestamp in bounded_turns
            ]

            try:
                pipeline = self._redis.pipeline(transaction=True)
                pipeline.rpush(key, *serialized_entries)
                pipeline.expire(key, ttl_seconds)
                pipeline.execute()
            except Exception as exc:  # noqa: BLE001 -- any Redis client failure is reported uniformly
                raise ConversationStoreUnavailableError(
                    f"Failed to seed history for session {session_id!r}", last_error=exc
                ) from exc

            return True
        finally:
            try:
                self._redis.delete(lock_key)
            except Exception:  # noqa: BLE001 -- the lock's own EX is the backstop; never break restoration on cleanup failure
                pass

    def session_exists(self, session_id: str) -> bool:
        """Whether `session_id` currently has a non-expired Redis key.
        A minimal, explicit primitive for "session presence" -- not a
        session-creation operation (see module docstring)."""

        key = self._session_key(session_id)
        try:
            return bool(self._redis.exists(key))
        except Exception as exc:  # noqa: BLE001
            raise ConversationStoreUnavailableError(
                f"Failed to check session existence for {session_id!r}", last_error=exc
            ) from exc

    def delete_session(self, session_id: str) -> bool:
        """STEP 3 REMEDIATION: delete exactly `session_id`'s own history,
        and nothing else.

        Always safe by construction, the same reasoning already
        established for `seed_history`'s restoration lock and Team 4A's
        `delete_exact_points` (canonical_mutations.py): this derives a
        single, exact Redis key from the given `session_id` via the same
        `_session_key()` every other method on this class uses --
        never a pattern, filter, or range -- so it can only ever remove
        that one session's own data, regardless of how many other
        sessions exist alongside it.

        Returns `True` if a session was actually deleted, `False` if
        `session_id` had no session to begin with (Redis's own `DEL`
        return value -- 0 keys removed) -- a safe, ordinary no-op, not
        an error; callers (e.g. Team 4C deleting a Conversation) should
        treat a "nothing to delete" outcome as success, not failure.
        """

        key = self._session_key(session_id)
        try:
            deleted_count = self._redis.delete(key)
        except Exception as exc:  # noqa: BLE001
            raise ConversationStoreUnavailableError(
                f"Failed to delete session {session_id!r}", last_error=exc
            ) from exc

        return bool(deleted_count)

    def _read_range(self, session_id: str, *, start: int, end: int) -> list[ConversationTurn]:
        key = self._session_key(session_id)
        try:
            raw_entries = self._redis.lrange(key, start, end)
        except Exception as exc:  # noqa: BLE001
            raise ConversationStoreUnavailableError(
                f"Failed to read history for session {session_id!r}", last_error=exc
            ) from exc

        return [self._deserialize_turn(entry, session_id) for entry in raw_entries]

    @staticmethod
    def _deserialize_turn(raw_entry: Any, session_id: str) -> ConversationTurn:
        try:
            data = json.loads(raw_entry)
        except (TypeError, ValueError) as exc:
            raise ConversationHistoryCorruptionError(
                f"Malformed JSON in session {session_id!r}: {raw_entry!r}"
            ) from exc

        if not isinstance(data, dict):
            raise ConversationHistoryCorruptionError(
                f"Stored turn for session {session_id!r} is not a JSON object: {data!r}"
            )

        try:
            role = data["role"]
            content = data["content"]
            timestamp = data["timestamp"]
        except KeyError as exc:
            raise ConversationHistoryCorruptionError(
                f"Stored turn for session {session_id!r} is missing required field {exc.args[0]!r}: {data!r}"
            ) from exc

        if role not in _VALID_ROLES:
            raise ConversationHistoryCorruptionError(
                f"Stored turn for session {session_id!r} has an invalid role {role!r}"
            )
        if not isinstance(content, str):
            raise ConversationHistoryCorruptionError(
                f"Stored turn for session {session_id!r} has a non-string content field: {content!r}"
            )
        if not isinstance(timestamp, (int, float)) or isinstance(timestamp, bool):
            raise ConversationHistoryCorruptionError(
                f"Stored turn for session {session_id!r} has a non-numeric timestamp: {timestamp!r}"
            )

        return ConversationTurn(role=role, content=content, timestamp=float(timestamp))
