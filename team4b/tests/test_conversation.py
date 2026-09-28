"""Focused tests for Task 4.1's ConversationManager.

Scope: unit/integration-style tests (against a genuinely-stateful fake
Redis client) for session creation, append/read behavior, ordering,
serialization/validation, TTL, window bounds, isolation, and error
handling. Explicitly NOT Task 4.2's Property 13/14 tests -- those remain
reserved for that task and are not implemented, labeled, or claimed here.
"""

from __future__ import annotations

from typing import Any

import pytest

from app.core.config import Settings
from app.services.conversation import (
    ConversationHistoryCorruptionError,
    ConversationManager,
    ConversationStoreUnavailableError,
    ConversationTurn,
    InvalidConversationRoleError,
)
from tests.fakes import FakeRedisClient


def _settings(**overrides: Any) -> Settings:
    return Settings(_env_file=None, **overrides)  # type: ignore[call-arg]


def _manager(
    redis_client: FakeRedisClient | None = None, clock: Any = None, **settings_overrides: Any
) -> tuple[ConversationManager, FakeRedisClient]:
    client = redis_client or FakeRedisClient()
    manager = ConversationManager(settings=_settings(**settings_overrides), redis_client=client, clock=clock)
    return manager, client


class _FakeClock:
    """Deterministic, manually-advanced clock for timestamp tests."""

    def __init__(self, start: float = 1000.0) -> None:
        self.current = start

    def __call__(self) -> float:
        return self.current

    def advance(self, seconds: float) -> None:
        self.current += seconds


# ---------------------------------------------------------------------------
# Redis key format
# ---------------------------------------------------------------------------


class TestSessionKeyFormat:
    def test_session_key_matches_official_format(self):
        manager, client = _manager()

        manager.append_turn("abc123", "user", "hello")

        assert client.raw_entries("session:abc123") != []
        assert client.raw_entries("abc123") == []  # not stored under the bare session_id


# ---------------------------------------------------------------------------
# New session / implicit creation
# ---------------------------------------------------------------------------


class TestNewSessionBehavior:
    def test_session_does_not_exist_before_first_append(self):
        manager, _client = _manager()

        assert manager.session_exists("brand-new") is False
        assert manager.get_history("brand-new") == []

    def test_first_append_creates_the_session(self):
        manager, _client = _manager()

        manager.append_turn("s1", "user", "hi")

        assert manager.session_exists("s1") is True

    def test_get_history_on_nonexistent_session_returns_empty_not_error(self):
        manager, _client = _manager()

        assert manager.get_history("never-created") == []

    def test_get_windowed_history_on_nonexistent_session_returns_empty(self):
        manager, _client = _manager()

        assert manager.get_windowed_history("never-created") == []


# ---------------------------------------------------------------------------
# Append user / assistant turns, ordering
# ---------------------------------------------------------------------------


class TestAppendAndOrdering:
    def test_append_user_turn(self):
        manager, _client = _manager()

        turn = manager.append_turn("s1", "user", "What is RAG?")

        assert turn.role == "user"
        assert turn.content == "What is RAG?"
        history = manager.get_history("s1")
        assert len(history) == 1
        assert history[0] == turn

    def test_append_assistant_turn(self):
        manager, _client = _manager()

        turn = manager.append_turn("s1", "assistant", "RAG stands for...")

        assert turn.role == "assistant"
        assert manager.get_history("s1")[0].role == "assistant"

    def test_multiple_turns_preserve_append_order(self):
        manager, _client = _manager()

        manager.append_turn("s1", "user", "first")
        manager.append_turn("s1", "assistant", "second")
        manager.append_turn("s1", "user", "third")

        history = manager.get_history("s1")
        assert [t.content for t in history] == ["first", "second", "third"]

    def test_repeated_appends_remain_correct_over_many_turns(self):
        manager, _client = _manager()

        for i in range(20):
            role = "user" if i % 2 == 0 else "assistant"
            manager.append_turn("s1", role, f"turn {i}")

        history = manager.get_history("s1")
        assert len(history) == 20
        assert [t.content for t in history] == [f"turn {i}" for i in range(20)]
        assert history[0].role == "user"
        assert history[1].role == "assistant"


# ---------------------------------------------------------------------------
# Role validation
# ---------------------------------------------------------------------------


class TestRoleValidation:
    def test_invalid_role_rejected(self):
        manager, _client = _manager()

        with pytest.raises(InvalidConversationRoleError):
            manager.append_turn("s1", "system", "not allowed")  # type: ignore[arg-type]

    def test_empty_string_role_rejected(self):
        manager, _client = _manager()

        with pytest.raises(InvalidConversationRoleError):
            manager.append_turn("s1", "", "content")  # type: ignore[arg-type]

    def test_invalid_role_does_not_write_to_redis(self):
        manager, client = _manager()

        with pytest.raises(InvalidConversationRoleError):
            manager.append_turn("s1", "system", "not allowed")  # type: ignore[arg-type]

        assert client.raw_entries("session:s1") == []


# ---------------------------------------------------------------------------
# Timestamp handling
# ---------------------------------------------------------------------------


class TestTimestampHandling:
    def test_timestamp_defaults_to_injected_clock(self):
        clock = _FakeClock(start=12345.0)
        manager, _client = _manager(clock=clock)

        turn = manager.append_turn("s1", "user", "hi")

        assert turn.timestamp == 12345.0

    def test_explicit_timestamp_overrides_clock(self):
        clock = _FakeClock(start=12345.0)
        manager, _client = _manager(clock=clock)

        turn = manager.append_turn("s1", "user", "hi", timestamp=999.0)

        assert turn.timestamp == 999.0

    def test_timestamp_is_a_float_after_round_trip(self):
        manager, _client = _manager(clock=_FakeClock(start=42.0))

        manager.append_turn("s1", "user", "hi")
        history = manager.get_history("s1")

        assert isinstance(history[0].timestamp, float)

    def test_advancing_clock_produces_increasing_timestamps(self):
        clock = _FakeClock(start=100.0)
        manager, _client = _manager(clock=clock)

        manager.append_turn("s1", "user", "first")
        clock.advance(5.0)
        manager.append_turn("s1", "assistant", "second")

        history = manager.get_history("s1")
        assert history[0].timestamp == 100.0
        assert history[1].timestamp == 105.0


# ---------------------------------------------------------------------------
# Serialization / deserialization, data integrity
# ---------------------------------------------------------------------------


class TestSerializationRoundTrip:
    def test_stored_entry_is_valid_json_with_exact_required_fields(self):
        import json

        manager, client = _manager(clock=_FakeClock(start=1.0))

        manager.append_turn("s1", "user", "hello")

        raw = client.raw_entries("session:s1")[0]
        data = json.loads(raw)
        assert data == {"role": "user", "content": "hello", "timestamp": 1.0}

    def test_round_trip_preserves_unicode_content(self):
        manager, _client = _manager()

        manager.append_turn("s1", "user", "日本語のテスト 🎉")

        assert manager.get_history("s1")[0].content == "日本語のテスト 🎉"

    def test_round_trip_preserves_content_with_embedded_quotes_and_newlines(self):
        manager, _client = _manager()
        tricky_content = 'He said "hello"\nwith a newline and a \\ backslash'

        manager.append_turn("s1", "user", tricky_content)

        assert manager.get_history("s1")[0].content == tricky_content


class TestCorruptedDataHandling:
    def test_malformed_json_raises_corruption_error(self):
        manager, client = _manager()
        client.inject_raw_entry("session:s1", "not valid json{{{")

        with pytest.raises(ConversationHistoryCorruptionError):
            manager.get_history("s1")

    def test_missing_required_field_raises_corruption_error(self):
        manager, client = _manager()
        client.inject_raw_entry("session:s1", '{"role": "user", "content": "hi"}')  # missing timestamp

        with pytest.raises(ConversationHistoryCorruptionError):
            manager.get_history("s1")

    def test_invalid_role_in_stored_data_raises_corruption_error(self):
        manager, client = _manager()
        client.inject_raw_entry("session:s1", '{"role": "system", "content": "hi", "timestamp": 1.0}')

        with pytest.raises(ConversationHistoryCorruptionError):
            manager.get_history("s1")

    def test_non_string_content_raises_corruption_error(self):
        manager, client = _manager()
        client.inject_raw_entry("session:s1", '{"role": "user", "content": 42, "timestamp": 1.0}')

        with pytest.raises(ConversationHistoryCorruptionError):
            manager.get_history("s1")

    def test_non_numeric_timestamp_raises_corruption_error(self):
        manager, client = _manager()
        client.inject_raw_entry("session:s1", '{"role": "user", "content": "hi", "timestamp": "not-a-number"}')

        with pytest.raises(ConversationHistoryCorruptionError):
            manager.get_history("s1")

    def test_json_array_instead_of_object_raises_corruption_error(self):
        manager, client = _manager()
        client.inject_raw_entry("session:s1", "[1, 2, 3]")

        with pytest.raises(ConversationHistoryCorruptionError):
            manager.get_history("s1")

    def test_corruption_is_also_raised_for_windowed_history(self):
        manager, client = _manager()
        client.inject_raw_entry("session:s1", "garbage")

        with pytest.raises(ConversationHistoryCorruptionError):
            manager.get_windowed_history("s1")


# ---------------------------------------------------------------------------
# TTL: configured default, renewal, no permanent TTL
# ---------------------------------------------------------------------------


class TestTTLBehavior:
    def test_ttl_uses_configured_default_of_30_minutes(self):
        manager, client = _manager()  # default session_ttl_minutes = 30

        manager.append_turn("s1", "user", "hi")

        assert client.ttl_for("session:s1") == 30 * 60

    def test_ttl_is_configurable(self):
        manager, client = _manager(session_ttl_minutes=5)

        manager.append_turn("s1", "user", "hi")

        assert client.ttl_for("session:s1") == 5 * 60

    def test_ttl_is_set_on_first_append_not_left_permanent(self):
        manager, client = _manager()

        manager.append_turn("s1", "user", "hi")

        assert client.ttl_for("session:s1") is not None

    def test_ttl_is_renewed_on_every_append(self):
        manager, client = _manager()

        manager.append_turn("s1", "user", "first")
        manager.append_turn("s1", "assistant", "second")

        assert len(client.expire_calls) == 2
        assert all(seconds == 30 * 60 for _key, seconds in client.expire_calls)

    def test_reading_history_does_not_renew_ttl(self):
        manager, client = _manager()
        manager.append_turn("s1", "user", "hi")
        calls_after_append = len(client.expire_calls)

        manager.get_history("s1")
        manager.get_windowed_history("s1")

        assert len(client.expire_calls) == calls_after_append  # unchanged -- reads don't touch TTL


# ---------------------------------------------------------------------------
# Conversation window
# ---------------------------------------------------------------------------


class TestConversationWindow:
    def test_default_window_is_5_turns(self):
        manager, _client = _manager()  # default conversation_window_size = 5
        for i in range(8):
            manager.append_turn("s1", "user", f"turn {i}")

        windowed = manager.get_windowed_history("s1")

        assert len(windowed) == 5
        assert [t.content for t in windowed] == ["turn 3", "turn 4", "turn 5", "turn 6", "turn 7"]

    def test_window_is_configurable(self):
        manager, _client = _manager(conversation_window_size=3)
        for i in range(8):
            manager.append_turn("s1", "user", f"turn {i}")

        windowed = manager.get_windowed_history("s1")

        assert len(windowed) == 3
        assert [t.content for t in windowed] == ["turn 5", "turn 6", "turn 7"]

    def test_explicit_window_size_overrides_configured_default(self):
        manager, _client = _manager(conversation_window_size=5)
        for i in range(8):
            manager.append_turn("s1", "user", f"turn {i}")

        windowed = manager.get_windowed_history("s1", window_size=2)

        assert [t.content for t in windowed] == ["turn 6", "turn 7"]

    def test_window_larger_than_history_returns_everything(self):
        manager, _client = _manager(conversation_window_size=10)
        manager.append_turn("s1", "user", "only turn")

        windowed = manager.get_windowed_history("s1")

        assert len(windowed) == 1

    def test_window_size_zero_returns_empty_list(self):
        manager, _client = _manager()
        manager.append_turn("s1", "user", "hi")

        assert manager.get_windowed_history("s1", window_size=0) == []

    def test_full_history_is_never_trimmed_by_windowed_reads(self):
        manager, _client = _manager(conversation_window_size=2)
        for i in range(10):
            manager.append_turn("s1", "user", f"turn {i}")

        manager.get_windowed_history("s1")  # bounded read
        manager.get_windowed_history("s1")  # again

        full_history = manager.get_history("s1")
        assert len(full_history) == 10  # nothing was ever LTRIM'd away


# ---------------------------------------------------------------------------
# Session isolation
# ---------------------------------------------------------------------------


class TestSessionIsolation:
    def test_independent_sessions_do_not_interfere(self):
        manager, _client = _manager()

        manager.append_turn("session-a", "user", "a's message")
        manager.append_turn("session-b", "user", "b's message")

        assert [t.content for t in manager.get_history("session-a")] == ["a's message"]
        assert [t.content for t in manager.get_history("session-b")] == ["b's message"]

    def test_sessions_with_shared_id_prefixes_do_not_interfere(self):
        manager, _client = _manager()

        manager.append_turn("abc", "user", "short id")
        manager.append_turn("abcdef", "user", "longer id sharing a prefix")

        assert len(manager.get_history("abc")) == 1
        assert len(manager.get_history("abcdef")) == 1


# ---------------------------------------------------------------------------
# Error handling: Redis failures
# ---------------------------------------------------------------------------


class TestRedisErrorHandling:
    def test_append_turn_raises_on_redis_failure(self):
        client = FakeRedisClient(fail_times={"pipeline_execute": 1})
        manager, _client = _manager(redis_client=client)

        with pytest.raises(ConversationStoreUnavailableError):
            manager.append_turn("s1", "user", "hi")

    def test_get_history_raises_on_redis_failure(self):
        client = FakeRedisClient(fail_times={"lrange": 1})
        manager, _client = _manager(redis_client=client)

        with pytest.raises(ConversationStoreUnavailableError):
            manager.get_history("s1")

    def test_session_exists_raises_on_redis_failure(self):
        client = FakeRedisClient(fail_times={"exists": 1})
        manager, _client = _manager(redis_client=client)

        with pytest.raises(ConversationStoreUnavailableError):
            manager.session_exists("s1")

    def test_redis_failure_is_not_silently_swallowed(self):
        # Explicit regression guard for the "do not silently swallow
        # Redis failures" instruction: no fallback value is ever
        # returned on failure -- the exception always propagates.
        client = FakeRedisClient(fail_times={"pipeline_execute": 100})
        manager, _client = _manager(redis_client=client)

        for _ in range(3):
            with pytest.raises(ConversationStoreUnavailableError):
                manager.append_turn("s1", "user", "hi")


# ---------------------------------------------------------------------------
# Step 7: seed_history() -- restoring an expired/missing session from an
# external durable store (Team 4C's MongoDB)
# ---------------------------------------------------------------------------


class TestSeedHistory:
    def test_seeds_a_missing_session_in_order(self):
        manager, _client = _manager()

        seeded = manager.seed_history(
            "s1",
            [("user", "first", 1.0), ("assistant", "second", 2.0), ("user", "third", 3.0)],
        )

        assert seeded is True
        history = manager.get_history("s1")
        assert [t.content for t in history] == ["first", "second", "third"]
        assert [t.role for t in history] == ["user", "assistant", "user"]

    def test_preserves_supplied_timestamps(self):
        manager, _client = _manager()

        manager.seed_history("s1", [("user", "hi", 555.0)])

        assert manager.get_history("s1")[0].timestamp == 555.0

    def test_missing_timestamp_falls_back_to_clock(self):
        clock = _FakeClock(start=777.0)
        manager, _client = _manager(clock=clock)

        manager.seed_history("s1", [("user", "hi", None)])

        assert manager.get_history("s1")[0].timestamp == 777.0

    def test_does_not_seed_when_session_already_exists(self):
        manager, _client = _manager()
        manager.append_turn("s1", "user", "live turn")

        seeded = manager.seed_history("s1", [("user", "should not appear", 1.0)])

        assert seeded is False
        history = manager.get_history("s1")
        assert [t.content for t in history] == ["live turn"]  # not duplicated/overwritten

    def test_repeated_restoration_attempts_do_not_duplicate_turns(self):
        manager, _client = _manager()
        turns = [("user", "first", 1.0), ("assistant", "second", 2.0)]

        first = manager.seed_history("s1", turns)
        second = manager.seed_history("s1", turns)  # e.g. a retried restoration call

        assert first is True
        assert second is False
        assert len(manager.get_history("s1")) == 2  # never 4

    def test_truncates_to_the_configured_conversation_window(self):
        manager, _client = _manager(conversation_window_size=2)
        turns = [("user", f"turn {i}", float(i)) for i in range(5)]

        manager.seed_history("s1", turns)

        history = manager.get_history("s1")
        assert [t.content for t in history] == ["turn 3", "turn 4"]  # only the most recent 2

    def test_empty_history_is_a_safe_no_op(self):
        manager, _client = _manager()

        seeded = manager.seed_history("s1", [])

        assert seeded is True  # nothing to duplicate later, but also nothing failed
        assert manager.get_history("s1") == []

    def test_cross_session_isolation_seeding_one_session_never_touches_another(self):
        manager, _client = _manager()
        manager.append_turn("session-a", "user", "a's live turn")

        manager.seed_history("session-b", [("user", "b's restored turn", 1.0)])

        assert [t.content for t in manager.get_history("session-a")] == ["a's live turn"]
        assert [t.content for t in manager.get_history("session-b")] == ["b's restored turn"]

    def test_malformed_role_in_supplied_turns_raises_and_writes_nothing(self):
        # STEP 8: roles are validated BEFORE any write is attempted, so an
        # invalid entry anywhere in the batch produces NO partial write --
        # not even the earlier, individually-valid turns.
        manager, client = _manager()

        with pytest.raises(InvalidConversationRoleError):
            manager.seed_history("s1", [("user", "ok", 1.0), ("system", "not allowed", 2.0)])  # type: ignore[list-item]

        assert manager.get_history("s1") == []
        assert manager.session_exists("s1") is False
        assert "session_lock:s1" not in client._strings  # lock released even on this early raise

    def test_concurrent_seed_attempts_only_one_writes(self):
        # Simulates two concurrent restoration requests for the SAME
        # session racing each other: the lock's `SET NX` means only the
        # first to acquire it actually seeds; the second sees the lock
        # already held and no-ops, rather than double-appending.
        manager, client = _manager()
        client.set(f"session_lock:s1", "1", nx=True, ex=30)  # simulates a request already in flight

        seeded = manager.seed_history("s1", [("user", "late arrival", 1.0)])

        assert seeded is False
        assert manager.get_history("s1") == []  # never written -- the in-flight request owns this

    def test_lock_is_released_after_a_successful_seed(self):
        manager, client = _manager()

        manager.seed_history("s1", [("user", "hi", 1.0)])

        assert client.raw_entries("session_lock:s1") == []
        assert "session_lock:s1" not in client._strings

    def test_lock_acquisition_failure_raises_conversation_store_unavailable(self):
        client = FakeRedisClient(fail_times={"set": 1})
        manager, _client = _manager(redis_client=client)

        with pytest.raises(ConversationStoreUnavailableError):
            manager.seed_history("s1", [("user", "hi", 1.0)])

    def test_a_normal_never_expired_session_is_unaffected_by_a_seed_attempt(self):
        # A seed call arriving for a session that is very much alive
        # (e.g. a stale/duplicate restoration request racing a live
        # conversation) must never disturb its real history.
        manager, _client = _manager()
        manager.append_turn("s1", "user", "q1")
        manager.append_turn("s1", "assistant", "a1")

        seeded = manager.seed_history("s1", [("user", "an old restored turn", 1.0)])

        assert seeded is False
        assert [t.content for t in manager.get_history("s1")] == ["q1", "a1"]

    # -- Step 8: atomic, all-or-nothing writes (fixes the partial-seeding bug) --

    def test_a_mid_write_redis_failure_leaves_zero_turns_written(self):
        # STEP 8 regression guard: the pipeline_execute failure hits
        # AFTER both rpush and expire have been queued into the SAME
        # pipeline -- proving the whole batch is one atomic unit rather
        # than N separate round-trips that could each partially land.
        client = FakeRedisClient(fail_times={"pipeline_execute": 1})
        manager, _client = _manager(redis_client=client)

        with pytest.raises(ConversationStoreUnavailableError):
            manager.seed_history("s1", [("user", "first", 1.0), ("assistant", "second", 2.0), ("user", "third", 3.0)])

        assert manager.session_exists("s1") is False
        assert manager.get_history("s1") == []

    def test_a_failed_seed_can_be_retried_successfully_once_redis_recovers(self):
        # STEP 8: this is the actual bug fix under test -- with the old
        # loop-of-append_turn implementation, a mid-write failure left the
        # session key PARTIALLY created, so this retry would have seen
        # session_exists()==True and silently no-op'd FOREVER, never
        # completing the restoration. With the single-pipeline write, the
        # failed attempt writes nothing, so the retry proceeds normally.
        client = FakeRedisClient(fail_times={"pipeline_execute": 1})
        manager, _client = _manager(redis_client=client)
        turns = [("user", "first", 1.0), ("assistant", "second", 2.0)]

        with pytest.raises(ConversationStoreUnavailableError):
            manager.seed_history("s1", turns)

        retried = manager.seed_history("s1", turns)  # Redis has "recovered" -- fail_times is exhausted

        assert retried is True
        assert [t.content for t in manager.get_history("s1")] == ["first", "second"]

    def test_lock_is_released_even_when_the_pipeline_write_fails(self):
        client = FakeRedisClient(fail_times={"pipeline_execute": 1})
        manager, _client = _manager(redis_client=client)

        with pytest.raises(ConversationStoreUnavailableError):
            manager.seed_history("s1", [("user", "hi", 1.0)])

        assert "session_lock:s1" not in client._strings


# ---------------------------------------------------------------------------
# Step 3 remediation: delete_session() -- best-effort Redis cleanup support
# for a deleted Team 4C Conversation.
# ---------------------------------------------------------------------------


class TestDeleteSession:
    def test_deletes_an_existing_session(self):
        manager, client = _manager()
        manager.append_turn("s1", "user", "hi")

        deleted = manager.delete_session("s1")

        assert deleted is True
        assert manager.session_exists("s1") is False
        assert client.raw_entries("session:s1") == []

    def test_deleting_a_nonexistent_session_is_a_safe_no_op(self):
        manager, _client = _manager()

        deleted = manager.delete_session("never-existed")

        assert deleted is False  # a successful outcome, not an error

    def test_exact_key_deletion_only_removes_the_named_session(self):
        """Direct regression guard: delete_session must derive its Redis
        key exactly the same way every other method on this class does
        (`_session_key`) -- never a pattern, prefix, or scan -- so it can
        only ever remove the one session it was asked to."""

        manager, client = _manager()
        manager.append_turn("abc", "user", "short id")
        manager.append_turn("abcdef", "user", "longer id sharing a prefix")

        manager.delete_session("abc")

        assert manager.session_exists("abc") is False
        assert manager.session_exists("abcdef") is True
        assert [t.content for t in manager.get_history("abcdef")] == ["longer id sharing a prefix"]

    def test_deleting_one_session_never_touches_another(self):
        manager, _client = _manager()
        manager.append_turn("session-a", "user", "a's message")
        manager.append_turn("session-b", "user", "b's message")

        manager.delete_session("session-a")

        assert manager.session_exists("session-a") is False
        assert manager.session_exists("session-b") is True
        assert [t.content for t in manager.get_history("session-b")] == ["b's message"]

    def test_deleted_session_cannot_be_restored_by_a_plain_read(self):
        manager, _client = _manager()
        manager.append_turn("s1", "user", "hi")

        manager.delete_session("s1")

        assert manager.get_history("s1") == []
        assert manager.get_windowed_history("s1") == []

    def test_redis_failure_raises_conversation_store_unavailable(self):
        client = FakeRedisClient(fail_times={"delete": 1})
        manager, _client = _manager(redis_client=client)
        manager.append_turn("s1", "user", "hi")

        with pytest.raises(ConversationStoreUnavailableError):
            manager.delete_session("s1")

    def test_repeated_deletion_of_the_same_session_is_idempotent(self):
        manager, _client = _manager()
        manager.append_turn("s1", "user", "hi")

        first = manager.delete_session("s1")
        second = manager.delete_session("s1")

        assert first is True
        assert second is False  # already gone -- a safe no-op, not an error


# ---------------------------------------------------------------------------
# Task 10.1: check_health()
# ---------------------------------------------------------------------------


class TestCheckHealth:
    def test_returns_true_when_ping_succeeds(self):
        client = FakeRedisClient()
        manager, _client = _manager(redis_client=client)

        assert manager.check_health() is True

    def test_returns_false_when_ping_raises(self):
        client = FakeRedisClient(fail_times={"ping": 100})
        manager, _client = _manager(redis_client=client)

        assert manager.check_health() is False

    def test_returns_false_when_ping_responds_false_without_raising(self):
        # A distinct failure mode from an exception: Redis is reachable
        # enough to respond, but PING itself reports unhealthy.
        client = FakeRedisClient(ping_result=False)
        manager, _client = _manager(redis_client=client)

        assert manager.check_health() is False

    def test_never_raises_even_on_repeated_failure(self):
        client = FakeRedisClient(fail_times={"ping": 100})
        manager, _client = _manager(redis_client=client)

        for _ in range(3):
            assert manager.check_health() is False

    def test_does_not_mutate_any_session_state(self):
        client = FakeRedisClient()
        manager, _client = _manager(redis_client=client)
        manager.append_turn("s1", "user", "hi")

        manager.check_health()

        history = manager.get_history("s1")
        assert len(history) == 1  # unaffected -- check_health touched nothing
