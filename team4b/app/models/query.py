"""Team 4B query/response Pydantic models and enums (Corrective Task 1.2).

Implements the API-contract-level data models the official Team 4B
specification defines for the retrieval/query surface: `SearchMode`,
`RetrievalConfig`, `QueryRequest`, `SourceAttribution`, and
`QueryResponse`.

SCOPE NOTE: this module is data/validation only. Nothing here queries
Qdrant, Redis, or Ollama; performs BM25/embedding/RRF; generates
answers; or mutates a session. No `/api/v1/query` (or any other) API
route is implemented -- that remains Task 8.1. No RAGService
orchestration is implemented -- that remains Task 7.1.

RELATIONSHIP TO `app/models/retrieval.py`'s `RetrievalResult`:
`RetrievalResult` is a distinct, already-approved (Task 2.1) internal
component-contract type used by `VectorStoreManager`/`HybridRetriever`'s
own return values. It is NOT replaced, redesigned, or merged with
anything here, per this corrective task's explicit instruction to
preserve existing approved behavior. `SourceAttribution` (this module)
is a separate, API-facing model that a later task (7.1/8.1) will build
FROM `RetrievalResult` data -- that assembly logic does not exist yet
and is explicitly out of this task's scope.

RELATIONSHIP TO `app/services/hybrid_retriever.py`'s `SearchMode`:
`HybridRetriever.retrieve()` already has its own
`SearchMode = Literal["hybrid", "semantic", "keyword"]` type alias and
its own `InvalidSearchModeError` runtime validation, predating this
module. Per this corrective task's explicit instruction not to modify
service implementations unless the official Task 1.2 contract requires
it, `hybrid_retriever.py` is NOT changed to import or depend on this
module's `SearchMode` enum -- the two independently express the same
three values (`hybrid`, `semantic`, `keyword`) in different but
compatible forms (a `Literal` vs. an `Enum`). This is a deliberate,
flagged duplication, not an oversight: unifying them would be a
service-implementation change this task's brief does not authorize.

DEFAULTS DESIGN DECISION -- `RetrievalConfig`'s field defaults
(`top_k=5`, `score_threshold=0.3`, `search_mode=hybrid`) are literal
values, not a `default_factory` reading `Settings` at instantiation
time. Two designs were considered:
  (a) hardcoded literals matching the official defaults exactly
      (chosen), with a test asserting they never drift from
      `Settings.default_top_k` / `default_score_threshold` /
      `default_search_mode`;
  (b) `Field(default_factory=lambda: get_settings().default_top_k)`,
      so a `RetrievalConfig` instantiated after an environment-variable
      override would automatically reflect it.
Neither official document requires live, env-var-reactive Pydantic
model defaults, and (a) is simpler and avoids a Pydantic model reaching
into global cached settings state at instantiation time purely for its
own field defaults. This is a documented internal implementation
choice, not a public-contract-affecting one: the JSON schema and
observable default VALUES are identical to what (b) would produce under
the actual approved `Settings` defaults.
"""

from __future__ import annotations

from enum import Enum
from typing import Any

from pydantic import BaseModel, Field, field_validator

# ---------------------------------------------------------------------------
# SearchMode
# ---------------------------------------------------------------------------


class SearchMode(str, Enum):
    """The three official search modes. Exact values, exact casing --
    no additional modes (no "bm25", "vector", "hybrid_search", etc.).
    """

    HYBRID = "hybrid"
    SEMANTIC = "semantic"
    KEYWORD = "keyword"


# ---------------------------------------------------------------------------
# RetrievalConfig
# ---------------------------------------------------------------------------


class RetrievalConfig(BaseModel):
    """Per-query retrieval configuration (Requirement 7).

    Official defaults: top_k=5, score_threshold=0.3, search_mode=hybrid.
    Official validation: top_k in [1, 50], score_threshold in [0.0, 1.0].
    `collection_filter` is optional -- a list of collection/source
    filters, `None` when not restricting the query.

    This model performs validation only. Per-query instances are
    independent of each other and of any global `Settings` instance --
    constructing one, or many, never mutates `Settings.default_top_k` /
    `default_score_threshold` / `default_search_mode` (there is no code
    path here that could).
    """

    top_k: int = Field(default=5, ge=1, le=50)
    score_threshold: float = Field(default=0.3, ge=0.0, le=1.0)
    search_mode: SearchMode = Field(default=SearchMode.HYBRID)
    collection_filter: list[str] | None = Field(default=None)
    # MVP M6 document-level retrieval scope (additive, optional).
    #
    # `None` (the default, and what every existing caller already sends
    # by omitting this field): EXACTLY the previous, unchanged
    # workspace-wide behavior -- no code path introduced by this field
    # can alter behavior for a caller that never sets it.
    #
    # `[]` (present but empty) is DELIBERATELY NOT treated as "no
    # restriction" / "search everything" -- that would be a dangerous,
    # silent scope-widening the moment a client's source-selection UI
    # produced an empty list by a bug or a race (e.g. "selection cleared
    # but request already in flight"). An empty list is normalized here
    # into `None` -- WAIT, see note below; the actual safe behavior
    # (retrieval short-circuits to zero candidates) is implemented in
    # `HybridRetriever.retrieve()`, not by rewriting `[]` into `None`
    # here (that would be the OPPOSITE of safe -- it would silently
    # WIDEN an empty selection into "everything"). This field's own
    # validator therefore leaves `[]` as `[]`, distinct from `None`,
    # so the retrieval layer can tell the two apart and choose the
    # correct (narrow, not wide) interpretation.
    #
    # Bounded at 100 IDs -- generous for any real multi-select UI, while
    # still preventing an unbounded list from being used to force an
    # arbitrarily large `MatchAny` Qdrant filter. No other format
    # constraint is imposed on each ID: a malformed/nonexistent ID
    # simply matches zero chunks, which is already safe by construction
    # (never a bypass), so rejecting a specific "malformed" shape would
    # add complexity without closing an actual security gap. Duplicate
    # IDs are harmless (a Qdrant/BM25 "IN" style match is unaffected by
    # repeats) and are not rejected.
    document_ids: list[str] | None = Field(default=None, max_length=100)

    @field_validator("document_ids")
    @classmethod
    def _document_ids_entries_must_be_non_blank(cls, value: list[str] | None) -> list[str] | None:
        if value is None:
            return value
        for document_id in value:
            if not isinstance(document_id, str) or not document_id.strip():
                raise ValueError("document_ids entries must be non-empty strings")
        return value


# ---------------------------------------------------------------------------
# QueryRequest
# ---------------------------------------------------------------------------


class QueryRequest(BaseModel):
    """The official Team 4B query request contract: `query`, optional
    `session_id`, optional `retrieval_config`.

    Deliberately does NOT include `user_id`, `conversation_id`, `model`,
    `temperature`, `max_tokens`, `sources`, `stream`, or `metadata` --
    none of those are part of the official Team 4B contract, and adding
    any of them would be exactly the kind of speculative field this
    corrective task explicitly prohibits.
    """

    #: Security Hardening Stage 1 -- previously unbounded, so an
    #: arbitrarily large string flowed straight into retrieval and the
    #: LLM prompt. 4000 characters is generous for a genuine question
    #: (well beyond any real message this product's own UI has ever
    #: sent) while bounding worst-case payload/prompt size.
    query: str = Field(min_length=1, max_length=4000)
    session_id: str | None = Field(default=None)
    retrieval_config: RetrievalConfig | None = Field(default=None)


# ---------------------------------------------------------------------------
# SourceAttribution
# ---------------------------------------------------------------------------


class SourceAttribution(BaseModel):
    """The official Team 4B source-attribution contract -- distinct
    from, and never to be confused with, Team 4C's different
    SourceAttribution shape (`type`, `sourceFile`, `fileId`, `location`,
    `label`), which belongs to Team 4C and is not reproduced here.

    Required: document_id, document_title, chunk_id, relevance_score.
    Optional: page_number, section_heading, start_timestamp,
    end_timestamp -- matching the document/video split already
    established by the approved Team 4A/4B contract
    (docs/CONTRACT_DECISIONS.md): a "document" source populates
    page_number/section_heading, a "video" source populates
    start_timestamp/end_timestamp.

    `relevance_score` is typed as `float` here without an additional
    [0.0, 1.0] range constraint at this model's validation layer. The
    system-wide invariant that relevance scores fall within [0.0, 1.0]
    is already enforced upstream by `HybridRetriever` (Property 7,
    Task 3.3) before any such value would ever reach this model; the
    official Team 4B design-document listing for this exact model does
    not itself state a numeric validation range the way it explicitly
    does for `RetrievalConfig`'s `top_k`/`score_threshold`. Adding one
    here anyway would be inventing validation beyond the stated
    contract -- flagged rather than silently added.
    """

    document_id: str
    document_title: str
    chunk_id: str
    relevance_score: float
    page_number: int | None = Field(default=None)
    section_heading: str | None = Field(default=None)
    start_timestamp: float | None = Field(default=None)
    end_timestamp: float | None = Field(default=None)


# ---------------------------------------------------------------------------
# QueryResponse
# ---------------------------------------------------------------------------


class QueryResponse(BaseModel):
    """The official Team 4B query response contract: `answer`,
    `session_id`, `source_attributions`, `retrieval_metadata`.

    `retrieval_metadata` is typed as an open `dict[str, Any]` rather
    than a nested Pydantic model with a fixed field list. The official
    design document leaves this dictionary's exact schema
    unspecified/open (Property 15 names example fields like
    `chunks_retrieved` and `search_mode`, but does not define a
    complete, closed schema for it) -- inventing a fixed, closed model
    for it here would contradict the specification's own apparent intent
    to leave it open, per this corrective task's explicit instruction
    not to expand an intentionally-open contract.
    """

    answer: str
    session_id: str
    source_attributions: list[SourceAttribution]
    retrieval_metadata: dict[str, Any]
