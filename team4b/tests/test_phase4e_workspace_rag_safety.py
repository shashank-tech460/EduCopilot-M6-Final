"""Phase 4E -- generalized, domain-agnostic RAG safety/isolation harness.

SCOPE: this file proves ARCHITECTURE properties (workspace isolation,
document filtering, generation-authority enforcement, source selection,
session isolation, reranker safety, citation integrity, and domain/
language independence) using entirely GENERIC, synthetic fixtures. It
never references Operating Systems, DBMS, or any other specific subject
in a way that the retrieval CODE could depend on -- subject names appear
only as arbitrary string labels a test author chose, exactly as
interchangeable as "ws-1"/"ws-2".

This file does NOT claim retrieval-quality results against the real
corpus -- that is Phase 4A-4D's job, using real data. This file proves
the CODE has no hidden dependency on which subject, language, or
workspace it's given, per Phase 4E's own "architecture generalization is
not the same as model retrieval quality" instruction.

No network access, no real Qdrant/MongoDB/Redis/Ollama, no model
download -- everything here runs against `InMemoryQdrantClient` (see
tests/fakes.py) and small local fakes, matching this project's
established testing convention.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

import pytest

from app.core.config import Settings
from app.models.retrieval import RetrievalResult
from app.services.bm25_index import BM25Document, BM25Index
from app.services.generation_authority import GenerationAuthorityUnavailableError
from app.services.hybrid_retriever import HybridRetriever, InvalidSearchModeError
from app.services.llm_generator import GenerationResult
from app.services.reranker import RerankerUnavailableError
from app.services.response_assembly import assemble_query_response, to_source_attribution
from app.services.vector_store import ContextChunk, VectorStoreManager
from tests.fakes import InMemoryQdrantClient

# ===========================================================================
# SECTION 16 -- generic, reusable fixtures. No OS/DBMS/subject vocabulary
# is ever read by the code under test; the strings below are arbitrary
# labels, chosen to visibly NOT resemble the real corpus.
# ===========================================================================


@dataclass
class GenericWorkspaceFixture:
    workspace_id: str
    label: str = ""


@dataclass
class GenericDocumentFixture:
    document_id: str
    workspace_id: str
    source_type: str = "pdf"
    ingestion_generation: int = 1


@dataclass
class GenericChunkFixture:
    chunk_id: str
    document: GenericDocumentFixture
    text: str
    language: str = "english"
    embedding: list[float] = field(default_factory=lambda: [1.0, 0.0])
    extra_metadata: dict[str, Any] = field(default_factory=dict)

    def to_context_chunk(self) -> ContextChunk:
        metadata = {
            "job_id": self.chunk_id,
            "workspace_id": self.document.workspace_id,
            "document_id": self.document.document_id,
            "ingestion_generation": self.document.ingestion_generation,
            "source_type": self.document.source_type,
            "language": self.language,
            **self.extra_metadata,
        }
        return ContextChunk(chunk_id=self.chunk_id, text=self.text, embedding=self.embedding, metadata=metadata)

    def to_bm25_document(self) -> BM25Document:
        return BM25Document(
            chunk_id=self.chunk_id, text=self.text, workspace_id=self.document.workspace_id, document_id=self.document.document_id
        )


def _settings(**overrides: Any) -> Settings:
    collection_name = overrides.pop("qdrant_collection_name", "generic_test_collection")
    canonical = overrides.pop("canonical_qdrant_collection_name", collection_name)
    return Settings(_env_file=None, qdrant_collection_name=collection_name, canonical_qdrant_collection_name=canonical, **overrides)  # type: ignore[call-arg]


def _make_vector_store(**settings_overrides: Any) -> tuple[VectorStoreManager, InMemoryQdrantClient]:
    client = InMemoryQdrantClient()
    settings = _settings(vector_store_initial_backoff_seconds=0.001, **settings_overrides)
    manager = VectorStoreManager(settings=settings, qdrant_client=client, sleep_fn=lambda _s: None)
    manager.ensure_collection()
    return manager, client


class GenericEmbedder:
    """Deterministic fake: maps query text to a caller-supplied vector.
    Never a real model -- no language/subject awareness of any kind."""

    def __init__(self, vectors_by_query: dict[str, list[float]], default: list[float] | None = None) -> None:
        self._vectors = vectors_by_query
        self._default = default or [0.0, 0.0]

    def embed_query(self, text: str) -> list[float]:
        return self._vectors.get(text, self._default)


class GenericGenerationAuthorityClient:
    """Test double mirroring `GenerationAuthorityClient`'s real,
    fail-closed contract: an unlisted document_id is simply absent from
    the returned map (never defaulted to "current")."""

    def __init__(self, current_generations: dict[str, int] | None = None, *, raise_error: bool = False) -> None:
        self._generations = current_generations or {}
        self._raise_error = raise_error
        self.calls: list[tuple[set[str], str]] = []

    def get_current_generations(self, document_ids: set[str], *, workspace_id: str) -> dict[str, int]:
        self.calls.append((set(document_ids), workspace_id))
        if self._raise_error:
            raise GenerationAuthorityUnavailableError()
        return {doc_id: gen for doc_id, gen in self._generations.items() if doc_id in document_ids}


class GenericReranker:
    """Deterministic fake reranker: reorders by a caller-supplied score
    lookup, or raises on demand. Records every candidate it was actually
    given, for INVARIANT 4/5 assertions."""

    def __init__(self, scores_by_chunk_id: dict[str, float] | None = None, *, raise_error: bool = False) -> None:
        self._scores = scores_by_chunk_id or {}
        self._raise_error = raise_error
        self.received_candidates: list[list[RetrievalResult]] = []

    def rerank(self, query: str, candidates, top_k: int) -> list[RetrievalResult]:
        self.received_candidates.append(list(candidates))
        if self._raise_error:
            raise RerankerUnavailableError("simulated reranker failure")
        ranked = sorted(candidates, key=lambda c: (-self._scores.get(c.chunk_id, 0.0), c.chunk_id))
        return ranked[:top_k]


def _retriever(vector_store, bm25_index, embedder, generation_authority=None, reranker=None, **settings_overrides) -> HybridRetriever:
    settings = _settings(**settings_overrides)
    return HybridRetriever(
        vector_store=vector_store,
        bm25_index=bm25_index,
        embedder=embedder,
        generation_authority=generation_authority or GenericGenerationAuthorityClient({}),
        settings=settings,
        reranker=reranker,
    )


def _index_chunks(vector_store: VectorStoreManager, bm25_index: BM25Index, chunks: list[GenericChunkFixture]) -> dict[str, RetrievalResult]:
    """Populates both legs and returns a chunk_cache-shaped dict, exactly
    like `HybridRetriever.refresh_bm25_corpus()` would produce -- lets
    keyword-only tests work without needing a real scroll-based refresh."""

    vector_store.upsert_batch([c.to_context_chunk() for c in chunks])
    bm25_index.add_documents([c.to_bm25_document() for c in chunks])
    return {
        c.chunk_id: RetrievalResult(chunk_id=c.chunk_id, text=c.text, relevance_score=0.0, metadata=c.to_context_chunk().metadata)
        for c in chunks
    }


# A small, generic two-workspace universe reused across many tests below.
WS_ALPHA = GenericWorkspaceFixture("ws-alpha")
WS_BETA = GenericWorkspaceFixture("ws-beta")
DOC_ALPHA_1 = GenericDocumentFixture("doc-alpha-1", WS_ALPHA.workspace_id)
DOC_BETA_1 = GenericDocumentFixture("doc-beta-1", WS_BETA.workspace_id)


def _two_workspace_universe() -> tuple[VectorStoreManager, BM25Index, dict[str, RetrievalResult], GenericEmbedder]:
    vector_store, _client = _make_vector_store()
    bm25_index = BM25Index()
    alpha_chunk = GenericChunkFixture("chunk-alpha-1", DOC_ALPHA_1, "alpha content about topic Q", embedding=[1.0, 0.0])
    beta_chunk = GenericChunkFixture("chunk-beta-1", DOC_BETA_1, "beta content about topic Q, highly relevant", embedding=[1.0, 0.0])
    chunk_cache = _index_chunks(vector_store, bm25_index, [alpha_chunk, beta_chunk])
    embedder = GenericEmbedder({"topic Q": [1.0, 0.0]})
    return vector_store, bm25_index, chunk_cache, embedder


# ===========================================================================
# SECTION 5 -- workspace isolation (INVARIANT 1)
# ===========================================================================


class TestWorkspaceIsolation:
    @pytest.mark.parametrize("search_mode", ["semantic", "keyword", "hybrid"])
    def test_query_in_workspace_alpha_never_returns_workspace_beta_evidence(self, search_mode):
        """TEST A/E: across all three search modes."""

        vector_store, bm25_index, chunk_cache, embedder = _two_workspace_universe()
        retriever = _retriever(vector_store, bm25_index, embedder, generation_authority=GenericGenerationAuthorityClient({"doc-alpha-1": 1, "doc-beta-1": 1}))
        retriever._chunk_cache = chunk_cache

        results = retriever.retrieve("topic Q", workspace_id=WS_ALPHA.workspace_id, top_k=10, score_threshold=0.0, search_mode=search_mode)

        assert all(r.chunk_id != "chunk-beta-1" for r in results)

    def test_highly_relevant_other_workspace_document_never_appears(self):
        """TEST B: beta's chunk is textually/semantically MORE relevant
        than alpha's own content, yet must never leak into alpha's results."""

        vector_store, _client = _make_vector_store()
        bm25_index = BM25Index()
        alpha_chunk = GenericChunkFixture("chunk-alpha-1", DOC_ALPHA_1, "loosely related filler", embedding=[0.1, 0.99])
        beta_chunk = GenericChunkFixture("chunk-beta-1", DOC_BETA_1, "topic Q topic Q topic Q exact match", embedding=[1.0, 0.0])
        chunk_cache = _index_chunks(vector_store, bm25_index, [alpha_chunk, beta_chunk])
        embedder = GenericEmbedder({"topic Q": [1.0, 0.0]})
        retriever = _retriever(vector_store, bm25_index, embedder, generation_authority=GenericGenerationAuthorityClient({"doc-alpha-1": 1, "doc-beta-1": 1}))
        retriever._chunk_cache = chunk_cache

        results = retriever.retrieve("topic Q", workspace_id=WS_ALPHA.workspace_id, top_k=10, score_threshold=0.0, search_mode="hybrid")

        assert "chunk-beta-1" not in [r.chunk_id for r in results]

    def test_other_workspace_content_does_not_influence_ranking(self):
        """TEST C: adding many highly-relevant beta chunks must not
        change alpha's own internal ranking order (proves filtering
        happens BEFORE fusion/ranking, not as a post-hoc list trim)."""

        vector_store, _client = _make_vector_store()
        bm25_index = BM25Index()
        alpha_chunks = [
            GenericChunkFixture("a-strong", DOC_ALPHA_1, "topic Q topic Q topic Q", embedding=[1.0, 0.0]),
            GenericChunkFixture("a-weak", DOC_ALPHA_1, "topic Q mentioned once", embedding=[0.9, 0.1]),
        ]
        beta_noise = [
            GenericChunkFixture(f"b-noise-{i}", DOC_BETA_1, "topic Q topic Q topic Q topic Q", embedding=[1.0, 0.0]) for i in range(20)
        ]
        chunk_cache = _index_chunks(vector_store, bm25_index, alpha_chunks + beta_noise)
        embedder = GenericEmbedder({"topic Q": [1.0, 0.0]})
        auth = GenericGenerationAuthorityClient({"doc-alpha-1": 1, "doc-beta-1": 1})
        retriever = _retriever(vector_store, bm25_index, embedder, generation_authority=auth)
        retriever._chunk_cache = chunk_cache

        results = retriever.retrieve("topic Q", workspace_id=WS_ALPHA.workspace_id, top_k=10, score_threshold=0.0, search_mode="hybrid")

        assert [r.chunk_id for r in results] == ["a-strong", "a-weak"]

    def test_same_query_text_two_workspaces_disjoint_results(self):
        """TEST D."""

        vector_store, bm25_index, chunk_cache, embedder = _two_workspace_universe()
        auth = GenericGenerationAuthorityClient({"doc-alpha-1": 1, "doc-beta-1": 1})
        retriever = _retriever(vector_store, bm25_index, embedder, generation_authority=auth)
        retriever._chunk_cache = chunk_cache

        alpha_results = retriever.retrieve("topic Q", workspace_id=WS_ALPHA.workspace_id, top_k=10, score_threshold=0.0, search_mode="hybrid")
        beta_results = retriever.retrieve("topic Q", workspace_id=WS_BETA.workspace_id, top_k=10, score_threshold=0.0, search_mode="hybrid")

        alpha_ids = {r.chunk_id for r in alpha_results}
        beta_ids = {r.chunk_id for r in beta_results}
        assert alpha_ids.isdisjoint(beta_ids)
        assert alpha_ids == {"chunk-alpha-1"}
        assert beta_ids == {"chunk-beta-1"}

    def test_workspace_isolation_holds_with_reranker_enabled(self):
        """TEST F."""

        vector_store, bm25_index, chunk_cache, embedder = _two_workspace_universe()
        reranker = GenericReranker({"chunk-beta-1": 100.0})  # reranker would love beta's chunk if it ever saw it
        auth = GenericGenerationAuthorityClient({"doc-alpha-1": 1, "doc-beta-1": 1})
        retriever = _retriever(vector_store, bm25_index, embedder, generation_authority=auth, reranker=reranker, reranker_candidate_pool_size=10)
        retriever._chunk_cache = chunk_cache

        results = retriever.retrieve("topic Q", workspace_id=WS_ALPHA.workspace_id, top_k=10, score_threshold=0.0, search_mode="hybrid")

        assert [r.chunk_id for r in results] == ["chunk-alpha-1"]
        for candidates in reranker.received_candidates:
            assert all(c.chunk_id != "chunk-beta-1" for c in candidates)

    def test_workspace_isolation_holds_when_reranker_fails(self):
        """TEST G."""

        vector_store, bm25_index, chunk_cache, embedder = _two_workspace_universe()
        failing_reranker = GenericReranker(raise_error=True)
        auth = GenericGenerationAuthorityClient({"doc-alpha-1": 1, "doc-beta-1": 1})
        retriever = _retriever(vector_store, bm25_index, embedder, generation_authority=auth, reranker=failing_reranker, reranker_candidate_pool_size=10)
        retriever._chunk_cache = chunk_cache

        results = retriever.retrieve("topic Q", workspace_id=WS_ALPHA.workspace_id, top_k=10, score_threshold=0.0, search_mode="hybrid")

        assert [r.chunk_id for r in results] == ["chunk-alpha-1"]

    def test_workspace_isolation_holds_with_minimal_partial_metadata(self):
        """TEST H: a chunk carrying only the structurally-required
        identity fields (no optional page_number/section_heading/etc.)
        is still correctly workspace-scoped."""

        vector_store, _client = _make_vector_store()
        bm25_index = BM25Index()
        minimal_chunk = GenericChunkFixture("minimal-1", DOC_ALPHA_1, "topic Q", embedding=[1.0, 0.0], extra_metadata={})
        chunk_cache = _index_chunks(vector_store, bm25_index, [minimal_chunk])
        embedder = GenericEmbedder({"topic Q": [1.0, 0.0]})
        auth = GenericGenerationAuthorityClient({"doc-alpha-1": 1})
        retriever = _retriever(vector_store, bm25_index, embedder, generation_authority=auth)
        retriever._chunk_cache = chunk_cache

        results = retriever.retrieve("topic Q", workspace_id=WS_ALPHA.workspace_id, top_k=10, score_threshold=0.0, search_mode="hybrid")

        assert [r.chunk_id for r in results] == ["minimal-1"]
        wrong_ws_results = retriever.retrieve("topic Q", workspace_id="ws-nonexistent", top_k=10, score_threshold=0.0, search_mode="hybrid")
        assert wrong_ws_results == []


# ===========================================================================
# SECTION 6 -- document filtering (INVARIANT 2, INVARIANT 7)
# ===========================================================================


class TestDocumentFiltering:
    def _setup(self):
        vector_store, _client = _make_vector_store()
        bm25_index = BM25Index()
        doc_a = GenericDocumentFixture("doc-a", WS_ALPHA.workspace_id)
        doc_b = GenericDocumentFixture("doc-b", WS_ALPHA.workspace_id)
        chunks = [
            GenericChunkFixture("c-a", doc_a, "topic Q", embedding=[1.0, 0.0]),
            GenericChunkFixture("c-b", doc_b, "topic Q", embedding=[1.0, 0.0]),
        ]
        chunk_cache = _index_chunks(vector_store, bm25_index, chunks)
        embedder = GenericEmbedder({"topic Q": [1.0, 0.0]})
        auth = GenericGenerationAuthorityClient({"doc-a": 1, "doc-b": 1})
        retriever = _retriever(vector_store, bm25_index, embedder, generation_authority=auth)
        retriever._chunk_cache = chunk_cache
        return retriever

    @pytest.mark.parametrize("search_mode", ["semantic", "keyword", "hybrid"])
    def test_document_ids_none_permits_all_workspace_documents(self, search_mode):
        retriever = self._setup()
        results = retriever.retrieve("topic Q", workspace_id=WS_ALPHA.workspace_id, top_k=10, score_threshold=0.0, search_mode=search_mode, document_ids=None)
        assert {r.chunk_id for r in results} == {"c-a", "c-b"}

    @pytest.mark.parametrize("search_mode", ["semantic", "keyword", "hybrid"])
    def test_document_ids_single_restricts_to_that_document(self, search_mode):
        retriever = self._setup()
        results = retriever.retrieve("topic Q", workspace_id=WS_ALPHA.workspace_id, top_k=10, score_threshold=0.0, search_mode=search_mode, document_ids=["doc-a"])
        assert {r.chunk_id for r in results} == {"c-a"}

    @pytest.mark.parametrize("search_mode", ["semantic", "keyword", "hybrid"])
    def test_document_ids_multiple_restricts_to_those_documents(self, search_mode):
        retriever = self._setup()
        results = retriever.retrieve("topic Q", workspace_id=WS_ALPHA.workspace_id, top_k=10, score_threshold=0.0, search_mode=search_mode, document_ids=["doc-a", "doc-b"])
        assert {r.chunk_id for r in results} == {"c-a", "c-b"}

    @pytest.mark.parametrize("search_mode", ["semantic", "keyword", "hybrid"])
    def test_document_ids_empty_list_returns_zero_results(self, search_mode):
        """INVARIANT 7."""

        retriever = self._setup()
        results = retriever.retrieve("topic Q", workspace_id=WS_ALPHA.workspace_id, top_k=10, score_threshold=0.0, search_mode=search_mode, document_ids=[])
        assert results == []

    def test_document_filtering_holds_with_reranker_enabled(self):
        retriever = self._setup()
        reranker = GenericReranker({"c-b": 100.0})
        retriever._reranker = reranker
        retriever._settings = _settings(reranker_candidate_pool_size=10)

        results = retriever.retrieve("topic Q", workspace_id=WS_ALPHA.workspace_id, top_k=10, score_threshold=0.0, search_mode="hybrid", document_ids=["doc-a"])

        assert [r.chunk_id for r in results] == ["c-a"]
        for candidates in reranker.received_candidates:
            assert all(c.chunk_id != "c-b" for c in candidates)


# ===========================================================================
# SECTION 7 -- generation authority (INVARIANT 3, INVARIANT 6)
# ===========================================================================


class TestGenerationAuthority:
    def _setup(self, authority):
        vector_store, _client = _make_vector_store()
        bm25_index = BM25Index()
        authorized = GenericChunkFixture("c-authorized", GenericDocumentFixture("doc-ok", WS_ALPHA.workspace_id), "topic Q", embedding=[1.0, 0.0])
        unauthorized = GenericChunkFixture("c-unauthorized", GenericDocumentFixture("doc-stale", WS_ALPHA.workspace_id), "topic Q", embedding=[1.0, 0.0])
        chunk_cache = _index_chunks(vector_store, bm25_index, [authorized, unauthorized])
        embedder = GenericEmbedder({"topic Q": [1.0, 0.0]})
        retriever = _retriever(vector_store, bm25_index, embedder, generation_authority=authority)
        retriever._chunk_cache = chunk_cache
        return retriever

    @pytest.mark.parametrize("search_mode", ["semantic", "keyword", "hybrid"])
    def test_authorized_candidate_permitted_unauthorized_excluded(self, search_mode):
        """Mixed pool: doc-ok is current (generation 1), doc-stale is
        NOT reported at all (as if its Mongo record vanished/never
        existed) -- fail-closed, per GenerationAuthorityClient's real
        contract."""

        authority = GenericGenerationAuthorityClient({"doc-ok": 1})
        retriever = self._setup(authority)

        results = retriever.retrieve("topic Q", workspace_id=WS_ALPHA.workspace_id, top_k=10, score_threshold=0.0, search_mode=search_mode)

        assert {r.chunk_id for r in results} == {"c-authorized"}

    def test_stale_generation_mismatch_excludes_candidate(self):
        authority = GenericGenerationAuthorityClient({"doc-ok": 1, "doc-stale": 99})  # mismatches the chunk's own generation=1
        retriever = self._setup(authority)

        results = retriever.retrieve("topic Q", workspace_id=WS_ALPHA.workspace_id, top_k=10, score_threshold=0.0, search_mode="hybrid")

        assert {r.chunk_id for r in results} == {"c-authorized"}

    def test_reranker_never_receives_an_unauthorized_candidate(self):
        authority = GenericGenerationAuthorityClient({"doc-ok": 1})
        retriever = self._setup(authority)
        reranker = GenericReranker({"c-unauthorized": 100.0})  # would love it, if only it ever saw it
        retriever._reranker = reranker
        retriever._settings = _settings(reranker_candidate_pool_size=10)

        results = retriever.retrieve("topic Q", workspace_id=WS_ALPHA.workspace_id, top_k=10, score_threshold=0.0, search_mode="hybrid")

        assert [r.chunk_id for r in results] == ["c-authorized"]
        for candidates in reranker.received_candidates:
            assert all(c.chunk_id != "c-unauthorized" for c in candidates)

    def test_fallback_on_reranker_failure_remains_authorized(self):
        """INVARIANT 6: fallback cannot weaken authorization."""

        authority = GenericGenerationAuthorityClient({"doc-ok": 1})
        retriever = self._setup(authority)
        retriever._reranker = GenericReranker(raise_error=True)
        retriever._settings = _settings(reranker_candidate_pool_size=10)

        results = retriever.retrieve("topic Q", workspace_id=WS_ALPHA.workspace_id, top_k=10, score_threshold=0.0, search_mode="hybrid")

        assert [r.chunk_id for r in results] == ["c-authorized"]

    def test_generation_authority_unavailable_excludes_everything_fail_closed(self):
        authority = GenericGenerationAuthorityClient(raise_error=True)
        retriever = self._setup(authority)

        results = retriever.retrieve("topic Q", workspace_id=WS_ALPHA.workspace_id, top_k=10, score_threshold=0.0, search_mode="hybrid")

        assert results == []


# ===========================================================================
# SECTION 8 -- source selection
# ===========================================================================


class TestSourceSelection:
    def _setup(self):
        vector_store, _client = _make_vector_store()
        bm25_index = BM25Index()
        pdf_chunk = GenericChunkFixture("c-pdf", GenericDocumentFixture("doc-pdf", WS_ALPHA.workspace_id, source_type="pdf"), "topic Q", embedding=[1.0, 0.0])
        video_chunk = GenericChunkFixture("c-video", GenericDocumentFixture("doc-video", WS_ALPHA.workspace_id, source_type="youtube"), "topic Q", embedding=[1.0, 0.0])
        chunk_cache = _index_chunks(vector_store, bm25_index, [pdf_chunk, video_chunk])
        embedder = GenericEmbedder({"topic Q": [1.0, 0.0]})
        auth = GenericGenerationAuthorityClient({"doc-pdf": 1, "doc-video": 1})
        retriever = _retriever(vector_store, bm25_index, embedder, generation_authority=auth)
        retriever._chunk_cache = chunk_cache
        return retriever

    def test_no_source_filter_allows_all_eligible_source_types_in_semantic_mode(self):
        retriever = self._setup()
        results = retriever.retrieve("topic Q", workspace_id=WS_ALPHA.workspace_id, top_k=10, score_threshold=0.0, search_mode="semantic")
        assert {r.chunk_id for r in results} == {"c-pdf", "c-video"}

    def test_collection_filter_document_only_excludes_video_in_semantic_mode(self):
        """`collection_filter` reaches the vector leg and is correctly
        enforced there (Team4A payload's raw "pdf"/"mp4"/"youtube" ->
        Team4B's normalized "document"/"video" vocabulary, per
        vector_store.py's own normalization)."""

        retriever = self._setup()
        results = retriever.retrieve("topic Q", workspace_id=WS_ALPHA.workspace_id, top_k=10, score_threshold=0.0, search_mode="semantic", collection_filter=["document"])
        assert {r.chunk_id for r in results} == {"c-pdf"}

    def test_PHASE4E_F1_FIXED_collection_filter_is_enforced_against_the_bm25_leg_in_hybrid_mode(self):
        """PHASE4E-F1, FIXED: `HybridRetriever._retrieve_hybrid()` now
        threads `collection_filter` into the BM25 leg
        (`self._bm25_index.search(...)`) exactly like it already does
        for `workspace_id`/`document_ids`, so a non-selected source type
        can no longer enter the fused RRF result via a lexical-only
        match. This test previously documented the opposite (a confirmed
        gap, `test_KNOWN_GAP_...`) -- see
        team4b/data/phase4e_workspace_rag_safety_review.md and
        team4b/tests/test_phase4e_f1_bm25_source_filter.py (the dedicated
        regression suite for this fix) for the full history and
        additional coverage.
        """

        retriever = self._setup()

        results = retriever.retrieve(
            "topic Q", workspace_id=WS_ALPHA.workspace_id, top_k=10, score_threshold=0.0, search_mode="hybrid", collection_filter=["document"]
        )

        returned_ids = {r.chunk_id for r in results}
        assert returned_ids == {"c-pdf"}
        assert "c-video" not in returned_ids


# ===========================================================================
# SECTION 9 -- session isolation (via RAGService, using its own established
# fake conventions from tests/test_rag_service.py)
# ===========================================================================


class _FakeHybridRetrieverForSession:
    """Records the workspace_id/query actually passed to retrieve(), so
    session-isolation tests can assert on it directly rather than via
    RAGService's own internals."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def retrieve(self, query, *, workspace_id, top_k, score_threshold, search_mode="hybrid", collection_filter=None, document_ids=None):
        self.calls.append({"query": query, "workspace_id": workspace_id})
        return []


class _FakeConversationManagerForSession:
    def __init__(self) -> None:
        self._history: dict[str, list] = {}
        self._clock = 0.0

    def get_windowed_history(self, session_id, window_size=None):
        return list(self._history.get(session_id, []))

    def append_turn(self, session_id, role, content):
        from app.services.conversation import ConversationTurn

        self._clock += 1.0
        self._history.setdefault(session_id, []).append(ConversationTurn(role=role, content=content, timestamp=self._clock))


class _FakeLLMGeneratorForSession:
    def __init__(self) -> None:
        self.generate_calls: list[dict[str, Any]] = []

    def generate(self, query, retrieval_results, *, conversation_history):
        self.generate_calls.append({"query": query, "history": list(conversation_history)})
        # Stage 8: matches the real LLMGenerator.generate()'s updated
        # return type (GenerationResult, not a bare string) -- grounded
        # is not exercised by this file's own architecture-generalization
        # tests, so `None` ("no signal") is the correct, inert default.
        return GenerationResult(answer=f"answer to: {query}", grounded=None)

    def generate_conversational(self, query, *, conversation_history):
        return f"conversational answer to: {query}"


class TestSessionIsolation:
    def test_two_sessions_in_different_workspaces_never_cross_contaminate_retrieval(self):
        from app.services.rag_service import RAGService

        retriever = _FakeHybridRetrieverForSession()
        conversation_manager = _FakeConversationManagerForSession()
        llm = _FakeLLMGeneratorForSession()
        service = RAGService(hybrid_retriever=retriever, conversation_manager=conversation_manager, llm_generator=llm)

        service.handle_query("Explain concept Z.", workspace_id="ws-alpha", session_id="session-A")
        service.handle_query("Explain concept Z.", workspace_id="ws-beta", session_id="session-B")

        assert retriever.calls[0]["workspace_id"] == "ws-alpha"
        assert retriever.calls[1]["workspace_id"] == "ws-beta"

    def test_followup_query_enriches_using_only_its_own_sessions_history(self):
        """The exact scenario from Section 9's example: two sessions ask
        the identical initial question, then the identical follow-up --
        each must enrich using ONLY its own prior turn, never the other
        session's."""

        from app.services.rag_service import RAGService

        retriever = _FakeHybridRetrieverForSession()
        conversation_manager = _FakeConversationManagerForSession()
        llm = _FakeLLMGeneratorForSession()
        service = RAGService(hybrid_retriever=retriever, conversation_manager=conversation_manager, llm_generator=llm)

        service.handle_query("Explain concept Alpha.", workspace_id="ws-alpha", session_id="session-A")
        service.handle_query("Explain concept Beta.", workspace_id="ws-beta", session_id="session-B")

        service.handle_query("What are its advantages?", workspace_id="ws-alpha", session_id="session-A")
        service.handle_query("What are its advantages?", workspace_id="ws-beta", session_id="session-B")

        session_a_followup_query = retriever.calls[2]["query"]
        session_b_followup_query = retriever.calls[3]["query"]
        assert "Alpha" in session_a_followup_query
        assert "Beta" not in session_a_followup_query
        assert "Beta" in session_b_followup_query
        assert "Alpha" not in session_b_followup_query

    def test_llm_generation_history_does_not_cross_sessions(self):
        from app.services.rag_service import RAGService

        retriever = _FakeHybridRetrieverForSession()
        conversation_manager = _FakeConversationManagerForSession()
        llm = _FakeLLMGeneratorForSession()
        service = RAGService(hybrid_retriever=retriever, conversation_manager=conversation_manager, llm_generator=llm)

        service.handle_query("First question in A.", workspace_id="ws-alpha", session_id="session-A")
        service.handle_query("First question in B.", workspace_id="ws-beta", session_id="session-B")

        history_seen_by_b = llm.generate_calls[1]["history"]
        assert all("First question in A" != turn.content for turn in history_seen_by_b)


# ===========================================================================
# SECTION 10 -- multilingual architecture (structural, not quality)
# ===========================================================================


class TestMultilingualArchitecture:
    """These tests prove the retrieval CODE has no language-specific
    branch: an embedder/BM25 combination that (hypothetically) matches
    perfectly across scripts flows through identically regardless of
    which language the query or chunk happen to be written in. This is
    NOT a claim about the real embedding model's actual cross-lingual
    quality (see Phase 4A/4C/4D for that, using real data)."""

    @pytest.mark.parametrize(
        "query_text,chunk_text",
        [
            ("English query", "English source content"),
            ("हिन्दी प्रश्न", "हिन्दी सामग्री"),
            ("Hinglish query yahan hai", "हिन्दी सामग्री"),
            ("हिन्दी प्रश्न", "English source content"),
            ("English query", "हिन्दी सामग्री"),
            ("Hinglish query yahan hai", "English source content"),
        ],
    )
    def test_retrieval_code_path_is_identical_regardless_of_language(self, query_text, chunk_text):
        """Same code path, same assertions, for every query/source
        language combination the product must support -- no `if
        language == "hindi"` branch exists anywhere in HybridRetriever,
        proven here by never needing one to make this test pass."""

        vector_store, _client = _make_vector_store()
        bm25_index = BM25Index()
        chunk = GenericChunkFixture("c-1", GenericDocumentFixture("doc-1", WS_ALPHA.workspace_id), chunk_text, language="mixed", embedding=[1.0, 0.0])
        chunk_cache = _index_chunks(vector_store, bm25_index, [chunk])
        embedder = GenericEmbedder({query_text: [1.0, 0.0]})
        auth = GenericGenerationAuthorityClient({"doc-1": 1})
        retriever = _retriever(vector_store, bm25_index, embedder, generation_authority=auth)
        retriever._chunk_cache = chunk_cache

        results = retriever.retrieve(query_text, workspace_id=WS_ALPHA.workspace_id, top_k=10, score_threshold=0.0, search_mode="semantic")

        assert [r.chunk_id for r in results] == ["c-1"]

    def test_bm25_tokenizer_handles_devanagari_and_latin_in_the_same_call_no_branch(self):
        from app.services.bm25_index import default_tokenizer

        mixed = "English words और हिन्दी शब्द mixed together"
        tokens = default_tokenizer(mixed)
        assert any(t.isascii() for t in tokens)
        assert any(not t.isascii() for t in tokens)


# ===========================================================================
# SECTION 11 -- domain generalization (INVARIANT 9, INVARIANT 10)
# ===========================================================================


_SYNTHETIC_SUBJECTS = ["physics", "biology", "mathematics", "history", "computer-science"]


class TestDomainGeneralization:
    """Synthetic fixtures only -- never touches the real corpus. Proves
    the SAME retriever class, unmodified, handles five unrelated
    synthetic 'subjects' without any subject-specific code existing
    anywhere in HybridRetriever/BM25Index/VectorStoreManager."""

    @pytest.mark.parametrize("subject", _SYNTHETIC_SUBJECTS)
    def test_a_new_synthetic_subject_workspace_requires_no_code_change(self, subject):
        vector_store, _client = _make_vector_store()
        bm25_index = BM25Index()
        workspace_id = f"ws-{subject}"
        doc = GenericDocumentFixture(f"doc-{subject}", workspace_id)
        chunk = GenericChunkFixture(f"c-{subject}", doc, f"synthetic {subject} concept explanation", embedding=[1.0, 0.0])
        chunk_cache = _index_chunks(vector_store, bm25_index, [chunk])
        embedder = GenericEmbedder({f"what is {subject} concept": [1.0, 0.0]})
        auth = GenericGenerationAuthorityClient({f"doc-{subject}": 1})
        retriever = _retriever(vector_store, bm25_index, embedder, generation_authority=auth)
        retriever._chunk_cache = chunk_cache

        results = retriever.retrieve(f"what is {subject} concept", workspace_id=workspace_id, top_k=10, score_threshold=0.0, search_mode="hybrid")

        assert [r.chunk_id for r in results] == [f"c-{subject}"]

    def test_five_synthetic_subject_workspaces_never_cross_contaminate(self):
        vector_store, _client = _make_vector_store()
        bm25_index = BM25Index()
        chunks = []
        vectors_by_query = {}
        for i, subject in enumerate(_SYNTHETIC_SUBJECTS):
            doc = GenericDocumentFixture(f"doc-{subject}", f"ws-{subject}")
            # Distinct, non-overlapping vectors per subject so semantic
            # search can't accidentally cross-match.
            vector = [1.0 if j == i else 0.0 for j in range(len(_SYNTHETIC_SUBJECTS))]
            chunks.append(GenericChunkFixture(f"c-{subject}", doc, f"synthetic {subject} concept", embedding=vector))
            vectors_by_query[f"about {subject}"] = vector
        chunk_cache = _index_chunks(vector_store, bm25_index, chunks)
        embedder = GenericEmbedder(vectors_by_query)
        auth = GenericGenerationAuthorityClient({f"doc-{s}": 1 for s in _SYNTHETIC_SUBJECTS})
        retriever = _retriever(vector_store, bm25_index, embedder, generation_authority=auth)
        retriever._chunk_cache = chunk_cache

        for subject in _SYNTHETIC_SUBJECTS:
            results = retriever.retrieve(f"about {subject}", workspace_id=f"ws-{subject}", top_k=10, score_threshold=0.0, search_mode="semantic")
            assert [r.chunk_id for r in results] == [f"c-{subject}"]


# ===========================================================================
# SECTION 12 -- reranker safety (INVARIANT 4, INVARIANT 5)
# ===========================================================================


class TestRerankerSafetyInvariants:
    def test_reranker_cannot_introduce_a_candidate_not_present_in_input(self):
        """INVARIANT 4 -- exercised directly against the reranker
        module's own real class, not just the fake."""

        from app.services.reranker import CrossEncoderReranker

        class FakeModel:
            def predict(self, pairs):
                return [1.0 for _ in pairs]

        reranker = CrossEncoderReranker(settings=_settings(), model=FakeModel())
        candidates = [RetrievalResult(chunk_id="only-this-one", text="x", relevance_score=0.5, metadata={})]

        results = reranker.rerank("q", candidates, top_k=10)

        assert {r.chunk_id for r in results} <= {"only-this-one"}

    def test_reranker_cannot_modify_metadata_identity(self):
        """INVARIANT 5."""

        from app.services.reranker import CrossEncoderReranker

        class FakeModel:
            def predict(self, pairs):
                return [1.0 for _ in pairs]

        metadata = {"document_id": "doc-x", "workspace_id": "ws-x", "chunk_id_echo": "should-not-change"}
        reranker = CrossEncoderReranker(settings=_settings(), model=FakeModel())
        candidates = [RetrievalResult(chunk_id="c1", text="original text", relevance_score=0.5, metadata=metadata)]

        results = reranker.rerank("q", candidates, top_k=10)

        assert results[0].metadata == metadata
        assert results[0].text == "original text"
        assert results[0].chunk_id == "c1"

    def test_authorization_is_not_performed_only_after_reranking(self):
        """Structural proof: the reranker is called with an ALREADY
        authority-filtered candidate list, not the raw pool -- verified
        by injecting an authority that rejects one candidate and
        confirming the reranker's fake never receives it (see
        TestGenerationAuthority.test_reranker_never_receives_an_unauthorized_candidate
        for the equivalent end-to-end proof through HybridRetriever;
        this test additionally documents WHY structurally: HybridRetriever
        calls `_passes_generation_check` filtering on both legs' raw
        candidates BEFORE `_finalize_results()` -- which is the only
        place `self._reranker.rerank(...)` is ever invoked -- is reached)."""

        import inspect

        source = inspect.getsource(HybridRetriever._retrieve_hybrid)
        generation_check_index = source.index("_passes_generation_check")
        finalize_index = source.index("_finalize_results")
        assert generation_check_index < finalize_index

    def test_disabled_reranker_preserves_prior_behavior(self):
        vector_store, bm25_index, chunk_cache, embedder = _two_workspace_universe()
        auth = GenericGenerationAuthorityClient({"doc-alpha-1": 1, "doc-beta-1": 1})
        retriever_no_reranker = _retriever(vector_store, bm25_index, embedder, generation_authority=auth, reranker=None)
        retriever_no_reranker._chunk_cache = chunk_cache

        results_a = retriever_no_reranker.retrieve("topic Q", workspace_id=WS_ALPHA.workspace_id, top_k=10, score_threshold=0.0, search_mode="hybrid")
        results_b = retriever_no_reranker.retrieve("topic Q", workspace_id=WS_ALPHA.workspace_id, top_k=10, score_threshold=0.0, search_mode="hybrid")

        assert [r.chunk_id for r in results_a] == [r.chunk_id for r in results_b] == ["chunk-alpha-1"]

    def test_candidate_pool_and_final_top_k_are_independently_configurable(self):
        vector_store, _client = _make_vector_store()
        bm25_index = BM25Index()
        chunks = [GenericChunkFixture(f"c{i}", GenericDocumentFixture("doc-1", WS_ALPHA.workspace_id), "topic Q", embedding=[1.0, 0.0]) for i in range(10)]
        chunk_cache = _index_chunks(vector_store, bm25_index, chunks)
        embedder = GenericEmbedder({"topic Q": [1.0, 0.0]})
        reranker = GenericReranker({})
        auth = GenericGenerationAuthorityClient({"doc-1": 1})
        retriever = _retriever(vector_store, bm25_index, embedder, generation_authority=auth, reranker=reranker, reranker_candidate_pool_size=8)
        retriever._chunk_cache = chunk_cache

        retriever.retrieve("topic Q", workspace_id=WS_ALPHA.workspace_id, top_k=3, score_threshold=0.0, search_mode="hybrid")

        assert len(reranker.received_candidates[0]) == 8  # pool size, not top_k


# ===========================================================================
# SECTION 13 -- citation integrity (INVARIANT 8)
# ===========================================================================


class TestCitationIntegrity:
    def test_source_attribution_reads_only_from_retrieved_metadata(self):
        result = RetrievalResult(
            chunk_id="c1", text="content", relevance_score=0.9,
            metadata={"document_id": "doc-1", "document_title": "Real Title", "page_number": 5},
        )

        attribution = to_source_attribution(result)

        assert attribution.document_id == "doc-1"
        assert attribution.document_title == "Real Title"
        assert attribution.chunk_id == "c1"

    def test_a_fabricated_answer_string_can_never_become_citation_metadata(self):
        """The LLM's generated ANSWER TEXT is never even passed into
        `to_source_attribution`/`assemble_query_response` -- structurally
        impossible for prose the model wrote to become trusted
        document_id/workspace_id/chunk_id metadata, since those functions
        only ever read from `RetrievalResult.metadata`, a dict populated
        exclusively by `VectorStoreManager`'s own read-side adapter."""

        import inspect
        from app.services import response_assembly

        source = inspect.getsource(response_assembly)
        assert "answer" not in inspect.getsource(response_assembly.to_source_attribution)

    def test_missing_document_id_or_title_raises_rather_than_fabricating(self):
        result = RetrievalResult(chunk_id="c1", text="content", relevance_score=0.9, metadata={})

        with pytest.raises(ValueError):
            to_source_attribution(result)

    def test_assembled_response_citations_correspond_only_to_actual_retrieval_results(self):
        from app.services.rag_service import RAGServiceResult

        retrieval_results = [
            RetrievalResult(chunk_id="c1", text="t1", relevance_score=0.9, metadata={"document_id": "doc-1", "document_title": "Doc One"}),
            RetrievalResult(chunk_id="c2", text="t2", relevance_score=0.8, metadata={"document_id": "doc-2", "document_title": "Doc Two"}),
        ]
        rag_result = RAGServiceResult(answer="a fabricated-sounding answer mentioning Doc Nine, page 999", session_id="s1", retrieval_results=retrieval_results, retrieval_metadata={})

        response = assemble_query_response(rag_result)

        cited_document_ids = {a.document_id for a in response.source_attributions}
        assert cited_document_ids == {"doc-1", "doc-2"}
        assert "Doc Nine" not in cited_document_ids


# ===========================================================================
# SECTION 14 -- empty / failure / edge cases
# ===========================================================================


class TestEdgeAndFailureCases:
    def test_empty_query_string_does_not_crash_and_returns_no_fabricated_results(self):
        vector_store, bm25_index, chunk_cache, embedder = _two_workspace_universe()
        retriever = _retriever(vector_store, bm25_index, embedder, generation_authority=GenericGenerationAuthorityClient({"doc-alpha-1": 1}))
        retriever._chunk_cache = chunk_cache

        results = retriever.retrieve("", workspace_id=WS_ALPHA.workspace_id, top_k=10, score_threshold=0.0, search_mode="keyword")

        assert results == []

    def test_whitespace_only_query_does_not_crash(self):
        vector_store, bm25_index, chunk_cache, embedder = _two_workspace_universe()
        retriever = _retriever(vector_store, bm25_index, embedder, generation_authority=GenericGenerationAuthorityClient({"doc-alpha-1": 1}))
        retriever._chunk_cache = chunk_cache

        results = retriever.retrieve("   ", workspace_id=WS_ALPHA.workspace_id, top_k=10, score_threshold=0.0, search_mode="keyword")

        assert results == []

    def test_nonexistent_workspace_returns_empty_not_an_error(self):
        vector_store, bm25_index, chunk_cache, embedder = _two_workspace_universe()
        retriever = _retriever(vector_store, bm25_index, embedder, generation_authority=GenericGenerationAuthorityClient({"doc-alpha-1": 1}))
        retriever._chunk_cache = chunk_cache

        results = retriever.retrieve("topic Q", workspace_id="ws-does-not-exist", top_k=10, score_threshold=0.0, search_mode="hybrid")

        assert results == []

    def test_nonexistent_document_id_filter_returns_empty(self):
        vector_store, bm25_index, chunk_cache, embedder = _two_workspace_universe()
        retriever = _retriever(vector_store, bm25_index, embedder, generation_authority=GenericGenerationAuthorityClient({"doc-alpha-1": 1}))
        retriever._chunk_cache = chunk_cache

        results = retriever.retrieve("topic Q", workspace_id=WS_ALPHA.workspace_id, top_k=10, score_threshold=0.0, search_mode="hybrid", document_ids=["doc-does-not-exist"])

        assert results == []

    def test_invalid_search_mode_raises_rather_than_silently_defaulting(self):
        vector_store, bm25_index, chunk_cache, embedder = _two_workspace_universe()
        retriever = _retriever(vector_store, bm25_index, embedder)

        with pytest.raises(InvalidSearchModeError):
            retriever.retrieve("topic Q", workspace_id=WS_ALPHA.workspace_id, top_k=10, score_threshold=0.0, search_mode="not-a-real-mode")  # type: ignore[arg-type]

    def test_reranker_unavailable_does_not_return_unauthorized_evidence_as_fallback(self):
        vector_store, _client = _make_vector_store()
        bm25_index = BM25Index()
        authorized = GenericChunkFixture("c-ok", GenericDocumentFixture("doc-ok", WS_ALPHA.workspace_id), "topic Q", embedding=[1.0, 0.0])
        chunk_cache = _index_chunks(vector_store, bm25_index, [authorized])
        embedder = GenericEmbedder({"topic Q": [1.0, 0.0]})
        auth = GenericGenerationAuthorityClient({"doc-ok": 1})
        retriever = _retriever(vector_store, bm25_index, embedder, generation_authority=auth, reranker=GenericReranker(raise_error=True), reranker_candidate_pool_size=10)
        retriever._chunk_cache = chunk_cache

        results = retriever.retrieve("topic Q", workspace_id=WS_ALPHA.workspace_id, top_k=10, score_threshold=0.0, search_mode="hybrid")

        assert [r.chunk_id for r in results] == ["c-ok"]

    def test_duplicate_chunk_ids_in_reranker_input_are_not_silently_dropped(self):
        from app.services.reranker import CrossEncoderReranker

        class FakeModel:
            def predict(self, pairs):
                return [0.0 for _ in pairs]

        reranker = CrossEncoderReranker(settings=_settings(), model=FakeModel())
        candidates = [
            RetrievalResult(chunk_id="dup", text="version A", relevance_score=0.5, metadata={}),
            RetrievalResult(chunk_id="dup", text="version B", relevance_score=0.5, metadata={}),
        ]

        results = reranker.rerank("q", candidates, top_k=5)

        assert len(results) == 2

    def test_candidate_pool_smaller_than_final_top_k_returns_all_available(self):
        vector_store, _client = _make_vector_store()
        bm25_index = BM25Index()
        chunks = [GenericChunkFixture(f"c{i}", GenericDocumentFixture("doc-1", WS_ALPHA.workspace_id), "topic Q", embedding=[1.0, 0.0]) for i in range(3)]
        chunk_cache = _index_chunks(vector_store, bm25_index, chunks)
        embedder = GenericEmbedder({"topic Q": [1.0, 0.0]})
        auth = GenericGenerationAuthorityClient({"doc-1": 1})
        retriever = _retriever(vector_store, bm25_index, embedder, generation_authority=auth, reranker=GenericReranker({}), reranker_candidate_pool_size=40)
        retriever._chunk_cache = chunk_cache

        results = retriever.retrieve("topic Q", workspace_id=WS_ALPHA.workspace_id, top_k=10, score_threshold=0.0, search_mode="hybrid")

        assert len(results) == 3

    def test_empty_candidate_pool_reranker_receives_empty_list_without_error(self):
        """No candidates survived upstream filtering (nothing indexed at
        all here) -- `_finalize_results` still calls the reranker
        (uniformly, regardless of pool size), and it must handle an
        empty list without crashing or fabricating a result."""

        vector_store, _client = _make_vector_store()
        bm25_index = BM25Index()
        embedder = GenericEmbedder({"topic Q": [1.0, 0.0]})
        reranker = GenericReranker({})
        retriever = _retriever(vector_store, bm25_index, embedder, reranker=reranker, reranker_candidate_pool_size=10)

        results = retriever.retrieve("topic Q", workspace_id=WS_ALPHA.workspace_id, top_k=10, score_threshold=0.0, search_mode="hybrid")

        assert results == []
        assert reranker.received_candidates == [[]]


# ===========================================================================
# SECTION 15 -- cross-cutting invariants not already covered by a dedicated
# section above (INVARIANT 9, 10, 11, 12 -- 1-8 are covered by the sections
# above and are cross-referenced there).
# ===========================================================================


class TestCrossCuttingInvariants:
    def test_invariant_9_and_10_new_domain_and_workspace_need_no_retrieval_code_change(self):
        """Already demonstrated per-subject in TestDomainGeneralization;
        this test asserts the STRUCTURAL claim directly: HybridRetriever's
        own source has no subject or workspace-id literal in it."""

        import inspect

        source = inspect.getsource(HybridRetriever)
        forbidden_literals = ["operating system", "dbms", "process scheduling", "sql", " os ", "database management"]
        lowered = source.lower()
        for literal in forbidden_literals:
            assert literal not in lowered, f"found forbidden subject-specific literal {literal!r} in HybridRetriever source"

    def test_invariant_11_source_filtering_enforced_in_semantic_leg_throughout_pipeline(self):
        """The semantic leg's own enforcement of collection_filter.
        PHASE4E-F1 additionally fixed the BM25 leg (previously a
        confirmed gap in hybrid mode) -- see
        test_PHASE4E_F1_FIXED_collection_filter_is_enforced_against_the_bm25_leg_in_hybrid_mode
        above and tests/test_phase4e_f1_bm25_source_filter.py for that
        coverage; Invariant 11 is now fully proven, not merely partial.
        """

        vector_store, _client = _make_vector_store()
        bm25_index = BM25Index()
        pdf_chunk = GenericChunkFixture("c-pdf", GenericDocumentFixture("doc-pdf", WS_ALPHA.workspace_id, source_type="pdf"), "topic Q", embedding=[1.0, 0.0])
        video_chunk = GenericChunkFixture("c-video", GenericDocumentFixture("doc-video", WS_ALPHA.workspace_id, source_type="mp4"), "topic Q", embedding=[1.0, 0.0])
        chunk_cache = _index_chunks(vector_store, bm25_index, [pdf_chunk, video_chunk])
        embedder = GenericEmbedder({"topic Q": [1.0, 0.0]})
        auth = GenericGenerationAuthorityClient({"doc-pdf": 1, "doc-video": 1})
        retriever = _retriever(vector_store, bm25_index, embedder, generation_authority=auth)
        retriever._chunk_cache = chunk_cache

        results = retriever.retrieve("topic Q", workspace_id=WS_ALPHA.workspace_id, top_k=10, score_threshold=0.0, search_mode="semantic", collection_filter=["video"])

        assert {r.chunk_id for r in results} == {"c-video"}

    def test_invariant_12_session_context_cannot_cross_workspace_boundaries(self):
        """Already proven end-to-end in TestSessionIsolation; this is
        the direct structural check: RAGService.handle_query has no
        default for workspace_id and no code path that infers it from
        session history."""

        import inspect
        from app.services.rag_service import RAGService

        signature = inspect.signature(RAGService.handle_query)
        assert signature.parameters["workspace_id"].default is inspect.Parameter.empty
