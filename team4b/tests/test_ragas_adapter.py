"""Focused tests for Task 9.1's RAGAS adapter wrapper classes.

Scope: `_OllamaRagasLLM` and `_ProjectRagasEmbeddings` in isolation,
verified against injected fake clients (`FakeLLMClient` from
`tests/fakes.py`, and a minimal fake embedder). These tests do NOT
exercise `ragas.evaluate()` or `RagasEvaluationAdapter.evaluate_batch()`
end-to-end -- that requires the full RAGAS/LLM/embeddings machinery this
sandbox cannot run (no reachable Ollama instance; see the module
docstring in `app/services/ragas_adapter.py` and this task's report for
the honest limitation this implies).
"""

from __future__ import annotations

from typing import Any

import pytest

from app.core.config import Settings
from app.services.ragas_adapter import _OllamaRagasLLM, _ProjectRagasEmbeddings
from tests.fakes import FakeLLMClient


def _settings(**overrides: Any) -> Settings:
    return Settings(_env_file=None, **overrides)  # type: ignore[call-arg]


class _FakePromptValue:
    """Minimal stand-in for langchain_core.prompt_values.PromptValue --
    only `.to_string()` is actually called by `_OllamaRagasLLM`."""

    def __init__(self, text: str) -> None:
        self._text = text

    def to_string(self) -> str:
        return self._text


class _FakeEmbedderForAdapter:
    """Minimal stand-in for app.services.embedder.Embedder."""

    def __init__(self) -> None:
        self.query_calls: list[str] = []
        self.batch_calls: list[list[str]] = []

    def embed_query(self, text: str) -> list[float]:
        self.query_calls.append(text)
        return [1.0, 0.0, 0.0]

    def embed_queries(self, texts: list[str]) -> list[list[float]]:
        self.batch_calls.append(list(texts))
        return [[1.0, 0.0, 0.0] for _ in texts]


class TestOllamaRagasLLMWrapper:
    def test_generate_text_delegates_to_the_injected_client(self):
        client = FakeLLMClient(response="the llm's answer")
        llm = _OllamaRagasLLM(_settings(), client=client)

        result = llm.generate_text(_FakePromptValue("what is RAG?"))

        assert client.calls == [
            {
                "model": "llama3",
                "prompt": "what is RAG?",
                "timeout": 60.0,
                "num_gpu": None,
                "num_predict": None,
                "format": None,
            }
        ]
        assert result.generations[0][0].text == "the llm's answer"

    def test_generate_text_uses_configured_model_name(self):
        client = FakeLLMClient(response="answer")
        llm = _OllamaRagasLLM(_settings(ollama_model_name="custom-model"), client=client)

        llm.generate_text(_FakePromptValue("q"))

        assert client.calls[0]["model"] == "custom-model"

    def test_generate_text_uses_configured_evaluation_timeout(self):
        client = FakeLLMClient(response="answer")
        llm = _OllamaRagasLLM(_settings(evaluation_batch_timeout_seconds=42.0), client=client)

        llm.generate_text(_FakePromptValue("q"))

        assert client.calls[0]["timeout"] == 42.0

    def test_is_finished_always_true(self):
        llm = _OllamaRagasLLM(_settings(), client=FakeLLMClient())

        assert llm.is_finished(object()) is True

    @pytest.mark.asyncio
    async def test_agenerate_text_delegates_to_generate_text(self):
        client = FakeLLMClient(response="async answer")
        llm = _OllamaRagasLLM(_settings(), client=client)

        result = await llm.agenerate_text(_FakePromptValue("q"))

        assert result.generations[0][0].text == "async answer"

    def test_client_failure_propagates(self):
        client = FakeLLMClient(raise_error=ConnectionError("ollama down"))
        llm = _OllamaRagasLLM(_settings(), client=client)

        with pytest.raises(ConnectionError):
            llm.generate_text(_FakePromptValue("q"))

    def test_run_config_timeout_matches_configured_evaluation_timeout(self):
        llm = _OllamaRagasLLM(_settings(evaluation_batch_timeout_seconds=99.0), client=FakeLLMClient())

        assert llm.run_config.timeout == 99


class TestProjectRagasEmbeddingsWrapper:
    def test_embed_query_delegates_to_the_injected_embedder(self):
        embedder = _FakeEmbedderForAdapter()
        wrapper = _ProjectRagasEmbeddings(_settings(), embedder=embedder)  # type: ignore[arg-type]

        vector = wrapper.embed_query("some text")

        assert embedder.query_calls == ["some text"]
        assert vector == [1.0, 0.0, 0.0]

    def test_embed_documents_delegates_to_embed_queries(self):
        embedder = _FakeEmbedderForAdapter()
        wrapper = _ProjectRagasEmbeddings(_settings(), embedder=embedder)  # type: ignore[arg-type]

        vectors = wrapper.embed_documents(["a", "b"])

        assert embedder.batch_calls == [["a", "b"]]
        assert len(vectors) == 2

    @pytest.mark.asyncio
    async def test_aembed_query_delegates_to_embed_query(self):
        embedder = _FakeEmbedderForAdapter()
        wrapper = _ProjectRagasEmbeddings(_settings(), embedder=embedder)  # type: ignore[arg-type]

        vector = await wrapper.aembed_query("text")

        assert embedder.query_calls == ["text"]
        assert vector == [1.0, 0.0, 0.0]

    @pytest.mark.asyncio
    async def test_aembed_documents_delegates_to_embed_documents(self):
        embedder = _FakeEmbedderForAdapter()
        wrapper = _ProjectRagasEmbeddings(_settings(), embedder=embedder)  # type: ignore[arg-type]

        vectors = await wrapper.aembed_documents(["a", "b", "c"])

        assert len(vectors) == 3


# ---------------------------------------------------------------------------
# Task 9.1 remediation: _build_samples / _build_metrics
#
# These exercise REAL ragas.SingleTurnSample / ragas.metrics objects
# (construction only -- no network calls, no live LLM/embeddings
# execution needed), proving directly against the actual installed
# ragas==0.4.3 API that:
#   1. No `ContextRecall` metric is ever constructed or included.
#   2. Every sample's `reference` is documented as non-ground-truth and
#      is never anything other than that same item's own `response`
#      (never fabricated as something else, never left unset in a way
#      that would silently pass a different value to RAGAS).
#   3. Faithfulness / AnswerRelevancy / ContextPrecision are still
#      genuinely constructed with the real RAGAS classes.
# ---------------------------------------------------------------------------


from app.models.evaluation import EvaluationItem
from app.services.ragas_adapter import CONTEXT_RECALL_UNAVAILABLE_REASON, _build_metrics, _build_samples


class TestBuildSamplesRemediation:
    def test_samples_carry_the_official_contract_fields(self):
        items = [EvaluationItem(query="what is RAG?", response="RAG stands for...", contexts=["ctx1", "ctx2"])]

        samples = _build_samples(items)

        assert len(samples) == 1
        sample = samples[0]
        assert sample.user_input == "what is RAG?"
        assert sample.response == "RAG stands for..."
        assert sample.retrieved_contexts == ["ctx1", "ctx2"]

    def test_reference_is_always_exactly_the_items_own_response(self):
        # Proves the ONLY value ever placed in `reference` is the same
        # item's `response` -- never a different fabricated string,
        # never the contexts, never a constant placeholder.
        items = [
            EvaluationItem(query="q1", response="answer one", contexts=["c1"]),
            EvaluationItem(query="q2", response="answer two", contexts=["c2"]),
        ]

        samples = _build_samples(items)

        assert samples[0].reference == "answer one"
        assert samples[1].reference == "answer two"

    def test_reference_is_never_the_contexts_or_a_fabricated_value(self):
        item = EvaluationItem(query="q", response="the actual response", contexts=["context A", "context B"])

        (sample,) = _build_samples([item])

        assert sample.reference == "the actual response"
        assert sample.reference not in item.contexts
        assert sample.reference != "\n".join(item.contexts)
        assert sample.reference != item.contexts[0]

    def test_empty_items_produce_empty_samples(self):
        assert _build_samples([]) == []

    def test_multiple_items_preserve_order(self):
        items = [EvaluationItem(query=f"q{i}", response=f"r{i}", contexts=["c"]) for i in range(5)]

        samples = _build_samples(items)

        assert [s.user_input for s in samples] == [f"q{i}" for i in range(5)]


class TestBuildMetricsRemediation:
    def test_exactly_three_metrics_are_built(self):
        from app.services.ragas_adapter import _OllamaRagasLLM, _ProjectRagasEmbeddings

        llm = _OllamaRagasLLM(_settings(), client=FakeLLMClient())
        embeddings = _ProjectRagasEmbeddings(_settings(), embedder=_FakeEmbedderForAdapter())  # type: ignore[arg-type]

        metrics = _build_metrics(llm, embeddings)

        assert len(metrics) == 3

    def test_no_context_recall_metric_is_ever_constructed(self):
        from ragas.metrics import ContextRecall

        from app.services.ragas_adapter import _OllamaRagasLLM, _ProjectRagasEmbeddings

        llm = _OllamaRagasLLM(_settings(), client=FakeLLMClient())
        embeddings = _ProjectRagasEmbeddings(_settings(), embedder=_FakeEmbedderForAdapter())  # type: ignore[arg-type]

        metrics = _build_metrics(llm, embeddings)

        assert not any(isinstance(metric, ContextRecall) for metric in metrics)

    def test_faithfulness_answer_relevancy_context_precision_are_all_present(self):
        from ragas.metrics import AnswerRelevancy, ContextPrecision, Faithfulness

        from app.services.ragas_adapter import _OllamaRagasLLM, _ProjectRagasEmbeddings

        llm = _OllamaRagasLLM(_settings(), client=FakeLLMClient())
        embeddings = _ProjectRagasEmbeddings(_settings(), embedder=_FakeEmbedderForAdapter())  # type: ignore[arg-type]

        metrics = _build_metrics(llm, embeddings)
        metric_types = {type(metric) for metric in metrics}

        assert Faithfulness in metric_types
        assert AnswerRelevancy in metric_types
        assert ContextPrecision in metric_types


class TestContextRecallUnavailableReasonConstant:
    def test_reason_is_a_fixed_non_empty_string(self):
        assert isinstance(CONTEXT_RECALL_UNAVAILABLE_REASON, str)
        assert len(CONTEXT_RECALL_UNAVAILABLE_REASON) > 0

    def test_reason_explains_the_missing_reference_not_a_generic_failure(self):
        reason_lower = CONTEXT_RECALL_UNAVAILABLE_REASON.lower()
        assert "reference" in reason_lower
        assert "unavailable" in reason_lower
        # Explicitly NOT phrased as a transient/retryable execution
        # error -- distinguishing it from EvaluationExecutionError-style
        # messages.
        assert "timeout" not in reason_lower
        assert "connection" not in reason_lower
