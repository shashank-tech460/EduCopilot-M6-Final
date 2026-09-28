"""Team 4B evaluation models (Task 9.1).

The official Requirement 8 input consists of query/response/context
triples: `{query, response, contexts}`. Nothing beyond that is required
by the official contract, so `EvaluationItem` carries exactly those
three fields -- no `session_id`, no `document_id`, no source
attributions, no model name.

FAILURE REPRESENTATION (documented, not spec-mandated, since neither
official document specifies exact error shape): each of the four
metrics is `float | None` on `EvaluationMetrics` -- `None` means "this
metric could not be computed for this item", never a fabricated `0.0`.
`EvaluationItemResult.errors` is a `dict[str, str]` mapping metric name
to a human-readable failure reason, populated only for metrics that
actually failed -- so a failed metric is both visibly `None` in
`metrics` AND explained in `errors`, satisfying "partial metric
failures must not destroy successful results" without silently hiding
why a value is missing.

AGGREGATE SEMANTICS (documented decision): each aggregate field is the
arithmetic mean of that metric's non-`None` values across all items in
the batch. An item whose metric failed is excluded from that metric's
aggregate denominator (not treated as `0.0`). If EVERY item failed a
given metric, that aggregate field is `None` (not `0.0`, not omitted --
explicitly absent, so a caller can distinguish "everything failed" from
"average happened to be exactly zero").

P18 -- LOW-FAITHFULNESS FLAGGING (Task 9.2): `EvaluationItemResult.low_faithfulness_flag`
is `True` when that item's `metrics.faithfulness` was successfully
computed AND is strictly below `Settings.faithfulness_flag_threshold`
(default 0.5, reused from Task 1.1 -- not a second, duplicate
threshold). The comparison is strict (`<`, never `<=`): a faithfulness
score of exactly the threshold is NOT flagged. When faithfulness is
`None` (an execution failure, or -- structurally impossible in
practice, since faithfulness is always attempted -- any other reason a
value is absent), the flag is `False`, never `True`: an execution
failure must never be silently reinterpreted as "faithfulness was low."
This field is computed once, deterministically, by `EvaluationPipeline`
(see `app/services/evaluation.py`) -- not by RAGAS, not by the adapter,
and it never triggers a second LLM call or any re-evaluation. No
corresponding aggregate-level flag is added: Task 9.2's scope is
per-item flagging only, and inventing an aggregate-level warning
semantics neither official document defines was deliberately avoided
(see that module's docstring for the full reasoning).
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field, field_validator

#: Security Hardening Stage 1 -- none of these three fields had any
#: length bound at all before this change, so an unauthenticated (now
#: fixed separately) or authenticated-but-abusive caller could submit an
#: arbitrarily large payload straight into a real RAGAS/LLM/embedding
#: call. Generous, not tight: `_MAX_QUERY_LENGTH` matches
#: `app.models.query.QueryRequest.query`'s own new limit (the same kind
#: of "one real question" field); `_MAX_CONTEXT_LENGTH` is sized for a
#: genuinely long retrieved chunk or generated answer, not a short
#: message.
_MAX_QUERY_LENGTH = 4000
_MAX_RESPONSE_LENGTH = 20_000
_MAX_CONTEXT_LENGTH = 20_000
_MAX_CONTEXTS_PER_ITEM = 50


class EvaluationItem(BaseModel):
    """One query/response/context triple to evaluate. Exactly the
    official Requirement 8 input shape -- nothing more."""

    query: str = Field(min_length=1, max_length=_MAX_QUERY_LENGTH)
    response: str = Field(min_length=1, max_length=_MAX_RESPONSE_LENGTH)
    contexts: list[str] = Field(max_length=_MAX_CONTEXTS_PER_ITEM)

    @field_validator("contexts")
    @classmethod
    def _each_context_within_length_limit(cls, value: list[str]) -> list[str]:
        for context in value:
            if len(context) > _MAX_CONTEXT_LENGTH:
                raise ValueError(f"each context string must be {_MAX_CONTEXT_LENGTH} characters or fewer")
        return value


class EvaluationMetrics(BaseModel):
    """The four official RAGAS metrics (Requirement 8). `None` means
    "not computed" (a failure), never a fabricated `0.0`."""

    faithfulness: float | None = None
    answer_relevancy: float | None = None
    context_precision: float | None = None
    context_recall: float | None = None


class EvaluationItemResult(BaseModel):
    """One evaluated item: the original triple (echoed back so the
    result is self-contained and order-independent to consume), its
    computed metrics, any per-metric failure reasons, and the P18
    low-faithfulness flag (Task 9.2) derived from `metrics.faithfulness`.
    """

    query: str
    response: str
    contexts: list[str]
    metrics: EvaluationMetrics
    errors: dict[str, str] = Field(default_factory=dict)
    low_faithfulness_flag: bool = False


class EvaluationAggregate(BaseModel):
    """Arithmetic mean of each metric's successful values across the
    batch (see module docstring). `None` when zero items produced a
    successful value for that metric."""

    faithfulness: float | None = None
    answer_relevancy: float | None = None
    context_precision: float | None = None
    context_recall: float | None = None


class EvaluationResponse(BaseModel):
    """The full evaluation result: per-item results (in original input
    order -- never sorted), the batch aggregate, and a timezone-aware
    timestamp (also the value persisted by the evaluation store)."""

    results: list[EvaluationItemResult]
    aggregate: EvaluationAggregate
    evaluated_at: datetime
