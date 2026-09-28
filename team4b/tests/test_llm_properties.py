"""Task 6.2 -- official LLMGenerator correctness property P8.

    Property 8: Prompt completeness

TEST-ONLY task: no production code in `app/services/llm_generator.py`
is modified here (see the Task 6.2 report for confirmation). This test
exercises `LLMGenerator.generate()` -- the actual public generation
path, through the actual `LLMClientProtocol` boundary -- with an
injected `FakeLLMClient` (reused from `tests/fakes.py`, not
reimplemented), then inspects the ACTUAL prompt string the fake client
received (`client.calls[-1]["prompt"]`). This is deliberately NOT a test
of `build_prompt()` in isolation: it proves the prompt that would really
reach Ollama is complete, not just that the helper function is
internally consistent.

ANTI-CIRCULARITY, stated explicitly: this file never calls
`build_prompt()` (imported nowhere below) to construct an "expected"
prompt for comparison. Every assertion instead checks for the presence
(via Python's `in` operator) and relative ordering (via `str.index()`)
of values built directly from Hypothesis-generated raw data -- the same
independent-oracle pattern already used in Task 6.1's own unit tests and
every other property-test file in this project (Tasks 2.2, 3.3, 4.2).

COLLISION RESISTANCE: every generated chunk/history text is wrapped with
an index-prefixed, uniquely-delimited marker
(`CHUNK_MARKER_{index}__{raw text}` / `HISTORY_MARKER_{index}__{raw
text}`) before being used. This makes every chunk/turn's contribution to
the prompt independently identifiable even when Hypothesis happens to
draw identical raw content for two different chunks/turns, and rules out
the classic false-positive failure mode where a short/generic substring
assertion would pass only because it happened to occur inside a
*different* chunk's text.
"""

from __future__ import annotations

from typing import Any

import pytest
from hypothesis import HealthCheck, given, settings as hyp_settings
from hypothesis import strategies as st

from app.core.config import Settings
from app.models.retrieval import RetrievalResult
from app.services.conversation import ConversationTurn
from app.services.llm_generator import LLMGenerator
from tests.fakes import FakeLLMClient

_HYP = hyp_settings(max_examples=40, deadline=None, suppress_health_check=[HealthCheck.function_scoped_fixture])


def _settings() -> Settings:
    return Settings(_env_file=None)  # type: ignore[call-arg]


def _generator() -> tuple[LLMGenerator, FakeLLMClient]:
    client = FakeLLMClient(response="a generated answer")
    generator = LLMGenerator(settings=_settings(), llm_client=client)
    return generator, client


# ---------------------------------------------------------------------------
# Shared Hypothesis strategies
# ---------------------------------------------------------------------------

# Query text: bounded, but deliberately diverse -- Unicode, punctuation,
# whitespace, newlines, quotes, digits, mixed case are all valid per the
# actual LLMGenerator.generate() signature (`query: str`, no validation
# anywhere in app/services/llm_generator.py restricts its content).
_query_text = st.text(min_size=0, max_size=200)

_chunk_raw_content = st.text(min_size=1, max_size=100)
_role = st.sampled_from(["user", "assistant"])
_history_raw_content = st.text(min_size=1, max_size=100)
_timestamp = st.floats(allow_nan=False, allow_infinity=False, min_value=-1e9, max_value=1e9)

# Requirement 3.5 specifically calls out "<= 10 chunks" as the stated
# latency-target boundary -- 0..10 is chosen for that reason, not an
# arbitrary round number, per the task brief's own guidance.
_chunk_count = st.integers(min_value=0, max_value=10)
_history_count = st.integers(min_value=0, max_value=10)


def _marked_chunks(raw_contents: list[str]) -> list[RetrievalResult]:
    """Wrap raw Hypothesis-generated content with an index-unique marker
    before constructing RetrievalResult objects, so every chunk's
    contribution to the prompt is independently identifiable regardless
    of whether Hypothesis happened to draw duplicate raw content.
    """

    return [
        RetrievalResult(chunk_id=f"c{i}", text=f"CHUNK_MARKER_{i}__{content}", relevance_score=0.9, metadata={})
        for i, content in enumerate(raw_contents)
    ]


def _marked_history(raw_turns: list[tuple[str, str, float]]) -> list[ConversationTurn]:
    return [
        ConversationTurn(role=role, content=f"HISTORY_MARKER_{i}__{content}", timestamp=timestamp)  # type: ignore[arg-type]
        for i, (role, content, timestamp) in enumerate(raw_turns)
    ]


# ===========================================================================
# Property 8: Prompt completeness
#
# "For any query, any non-empty set of retrieved Context_Chunks, and any
#  supplied conversation history, the prompt constructed for the LLM
#  SHALL contain the query text, the text of every supplied
#  Context_Chunk, and the supplied conversation history." (Validates
#  Requirement 3.1)
# ===========================================================================


class TestPropertyEightPromptCompleteness:
    @_HYP
    @given(
        query=_query_text,
        chunk_contents=st.lists(_chunk_raw_content, min_size=1, max_size=10),
        history_turns=st.lists(st.tuples(_role, _history_raw_content, _timestamp), min_size=0, max_size=10),
    )
    def test_query_all_chunks_and_history_all_reach_the_actual_llm_prompt(
        self, query: str, chunk_contents: list[str], history_turns: list[tuple[str, str, float]]
    ) -> None:
        """The core P8 property (P8.1, P8.2, P8.3, P8.5): exercises the
        real `LLMGenerator.generate()` -> `LLMClientProtocol` boundary
        and inspects the prompt the fake client actually received.
        """

        generator, client = _generator()
        chunks = _marked_chunks(chunk_contents)
        history = _marked_history(history_turns)

        generator.generate(query, chunks, conversation_history=history)

        assert len(client.calls) == 1  # the LLM path was genuinely invoked (non-empty context)
        prompt = client.calls[0]["prompt"]

        # P8.2: query reaches the prompt.
        assert query in prompt

        # P8.1: EVERY supplied chunk's text reaches the prompt -- not
        # just the first one, not just a couple, all of them.
        for chunk in chunks:
            assert chunk.text in prompt

        # P8.3: every supplied history turn's content reaches the prompt.
        for turn in history:
            assert turn.content in prompt

    @_HYP
    @given(
        query=_query_text,
        chunk_contents=st.lists(_chunk_raw_content, min_size=1, max_size=10),
    )
    def test_query_and_all_chunks_reach_prompt_with_no_history_supplied(
        self, query: str, chunk_contents: list[str]
    ) -> None:
        """query + chunks, deliberately WITHOUT history (the `None`
        default) -- a test that only checked query+chunks+history
        together would miss a regression that's specific to the
        no-history code path.
        """

        generator, client = _generator()
        chunks = _marked_chunks(chunk_contents)

        generator.generate(query, chunks)  # conversation_history omitted entirely

        prompt = client.calls[0]["prompt"]
        assert query in prompt
        for chunk in chunks:
            assert chunk.text in prompt

    @_HYP
    @given(
        query=_query_text,
        history_turns=st.lists(st.tuples(_role, _history_raw_content, _timestamp), min_size=1, max_size=10),
    )
    def test_query_and_history_reach_prompt_with_single_chunk(
        self, query: str, history_turns: list[tuple[str, str, float]]
    ) -> None:
        """query + history, with the minimum non-empty chunk set (a
        test that only checked query+history and never varied chunk
        count meaningfully would be incomplete on its own -- this
        complements the main property rather than replacing it)."""

        generator, client = _generator()
        chunks = _marked_chunks(["the only chunk's content"])
        history = _marked_history(history_turns)

        generator.generate(query, chunks, conversation_history=history)

        prompt = client.calls[0]["prompt"]
        assert query in prompt
        assert chunks[0].text in prompt
        for turn in history:
            assert turn.content in prompt

    @_HYP
    @given(chunk_contents=st.lists(_chunk_raw_content, min_size=2, max_size=10, unique=True))
    def test_duplicate_and_near_duplicate_raw_content_does_not_hide_omissions(
        self, chunk_contents: list[str]
    ) -> None:
        """Explicit collision-resistance check: even if two chunks
        shared literally identical raw content (forced here by giving
        every chunk the SAME raw content, the most adversarial case),
        the index-prefixed marker keeps each one independently
        detectable, and the property still verifies each one by its own
        distinct marker string.
        """

        generator, client = _generator()
        identical_raw_content = "this exact same sentence appears in every chunk"
        chunks = _marked_chunks([identical_raw_content for _ in chunk_contents])

        generator.generate("query", chunks)

        prompt = client.calls[0]["prompt"]
        for chunk in chunks:
            assert chunk.text in prompt  # each CHUNK_MARKER_{i}__... is independently present

    @_HYP
    @given(
        chunk_contents=st.lists(_chunk_raw_content, min_size=3, max_size=10),
    )
    def test_removing_any_single_chunk_would_be_detected(self, chunk_contents: list[str]) -> None:
        """Directly demonstrates the task brief's "most important
        requirement": the property is sensitive enough that omitting
        even ONE supplied chunk breaks it. This test doesn't touch
        production code -- it simulates an omission by checking a
        chunk's marker against a prompt that was genuinely built
        WITHOUT that chunk, proving the assertion methodology itself
        would catch a real regression rather than passing vacuously.
        """

        generator, client = _generator()
        all_chunks = _marked_chunks(chunk_contents)
        omitted_chunk = all_chunks[len(all_chunks) // 2]
        chunks_missing_one = [c for c in all_chunks if c is not omitted_chunk]

        generator.generate("query", chunks_missing_one)

        prompt = client.calls[0]["prompt"]
        assert omitted_chunk.text not in prompt  # proves the assertion CAN fail -- it isn't vacuous
        for chunk in chunks_missing_one:
            assert chunk.text in prompt


# ===========================================================================
# P8.4: conversation history ordering preserved
# ===========================================================================


class TestPropertyEightHistoryOrdering:
    @_HYP
    @given(
        history_turns=st.lists(st.tuples(_role, _history_raw_content, _timestamp), min_size=2, max_size=10, unique_by=lambda t: t[1]),
    )
    def test_history_turns_appear_in_the_prompt_in_supplied_order(
        self, history_turns: list[tuple[str, str, float]]
    ) -> None:
        generator, client = _generator()
        chunks = _marked_chunks(["some retrieved context"])
        history = _marked_history(history_turns)

        generator.generate("query", chunks, conversation_history=history)

        prompt = client.calls[0]["prompt"]
        # Independent oracle: derive expected relative order directly
        # from the generated/supplied `history` list itself (its own
        # index-assigned position), never from a second call into
        # LLMGenerator or build_prompt.
        positions = [prompt.index(turn.content) for turn in history]
        assert positions == sorted(positions)

    @_HYP
    @given(chunk_contents=st.lists(_chunk_raw_content, min_size=2, max_size=10, unique=True))
    def test_chunk_texts_appear_in_the_prompt_in_supplied_order(self, chunk_contents: list[str]) -> None:
        generator, client = _generator()
        chunks = _marked_chunks(chunk_contents)

        generator.generate("query", chunks)

        prompt = client.calls[0]["prompt"]
        positions = [prompt.index(chunk.text) for chunk in chunks]
        assert positions == sorted(positions)


# ===========================================================================
# Zero-chunk case: explicitly NOT a P8 violation
# ===========================================================================


class TestZeroChunkCaseIsNotAP8Violation:
    @_HYP
    @given(
        query=_query_text,
        history_turns=st.lists(st.tuples(_role, _history_raw_content, _timestamp), min_size=0, max_size=10),
    )
    def test_zero_chunks_bypasses_the_llm_entirely_and_is_excluded_from_p8(
        self, query: str, history_turns: list[tuple[str, str, float]]
    ) -> None:
        """Per Task 6.1's own, already-approved behavior: an empty
        `retrieved_results` list returns the deterministic
        insufficient-context message WITHOUT ever calling the LLM
        client. There is therefore no prompt to check for completeness
        in this case -- P8 is a property of the prompt that reaches the
        LLM, and no such prompt is constructed here. This is correctly
        excluded from P8's scope, not a weakening of it.
        """

        from app.services.llm_generator import INSUFFICIENT_CONTEXT_MESSAGE

        generator, client = _generator()
        history = _marked_history(history_turns)

        answer = generator.generate(query, [], conversation_history=history)

        assert answer.answer == INSUFFICIENT_CONTEXT_MESSAGE
        assert client.calls == []  # confirmed: no prompt was ever built or sent


# ===========================================================================
# Boundary cases (explicit, non-Hypothesis, for clarity/documentation)
# ===========================================================================


class TestP8BoundaryCases:
    def test_single_chunk_no_history(self) -> None:
        generator, client = _generator()
        chunks = _marked_chunks(["only chunk"])

        generator.generate("only query", chunks)

        prompt = client.calls[0]["prompt"]
        assert "only query" in prompt
        assert chunks[0].text in prompt

    def test_exactly_ten_chunks_requirement_3_5_boundary(self) -> None:
        generator, client = _generator()
        chunks = _marked_chunks([f"chunk content {i}" for i in range(10)])

        generator.generate("query", chunks)

        prompt = client.calls[0]["prompt"]
        assert len(chunks) == 10
        for chunk in chunks:
            assert chunk.text in prompt

    def test_empty_query_string_with_chunks_still_completes(self) -> None:
        generator, client = _generator()
        chunks = _marked_chunks(["some context"])

        generator.generate("", chunks)

        prompt = client.calls[0]["prompt"]
        assert chunks[0].text in prompt  # the chunk requirement still holds even for an edge-case empty query

    def test_query_with_unicode_punctuation_and_newlines(self) -> None:
        generator, client = _generator()
        tricky_query = 'What does "RAG" mean?\nExplain 日本語 too. 100% clear?'
        chunks = _marked_chunks(["context"])

        generator.generate(tricky_query, chunks)

        prompt = client.calls[0]["prompt"]
        assert tricky_query in prompt
