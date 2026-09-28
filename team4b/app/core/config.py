"""Central configuration for the Team 4B Advanced RAG & Semantic Search service.

Task 1.1 scope: project structure and configuration only. This module
defines configuration exclusively -- it does not implement any route,
service, or domain model (those are Tasks 1.2+).

Every value is environment-overridable, matching the established
convention of the Team 4A service this integrates with (see
``app/config/settings.py`` in the Team 4A codebase), so the service runs
identically in local development and later deployment environments
without code changes.

Values are grouped by the Team 4B requirement/component that consumes
them, per Requirement 7 (Configurable Retrieval Parameters) and the
approved Final Architecture/Contract Checkpoint.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime configuration for the RAG_Service and its dependencies.

    Every field can be overridden via an environment variable of the same
    name (case-insensitive), or via a local ``.env`` file.
    """

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # ------------------------------------------------------------------
    # General / environment
    # ------------------------------------------------------------------
    environment: str = Field(
        default="local",
        description="Deployment environment name (local, staging, production).",
    )
    log_level: str = Field(
        default="INFO",
        description="Application log level: DEBUG, INFO, WARNING, ERROR, CRITICAL.",
    )

    # ------------------------------------------------------------------
    # Vector_Store / Qdrant (Requirement 1)
    #
    # Per the approved Final Architecture/Contract Checkpoint:
    #   - Team 4B owns/provisions the SHARED PRODUCTION collection.
    #   - Team 4B reads the records Team 4A publishes directly out of
    #     this same collection -- there is no republishing/synchronization
    #     pipeline, and Team 4A's code/local-demo collection
    #     ("team4a_ingested_chunks") is never read from or written to.
    #   - Default vector configuration matches Team 4A's actual, verified
    #     output: 384-dimensional, Cosine distance, all-MiniLM-L6-v2.
    #     This is configurable, not hard-coded, per the checkpoint.
    # ------------------------------------------------------------------
    qdrant_url: str = Field(
        default="http://localhost:6333",
        description="Base URL of the shared production Qdrant instance.",
    )
    qdrant_api_key: str | None = Field(
        default=None,
        description="Optional Qdrant API key, required for secured deployments.",
    )
    qdrant_collection_name: str = Field(
        default="team4b_shared_production_chunks",
        description=(
            "The shared PRODUCTION Qdrant collection that both Team 4A "
            "(writer) and Team 4B (reader/provisioner) use. This is the "
            "integration boundary defined in the approved checkpoint -- "
            "distinct from, and never to be confused with, Team 4A's own "
            "local/demo collection ('team4a_ingested_chunks')."
        ),
    )
    canonical_qdrant_collection_name: str = Field(
        default="educopilot_chunks",
        description=(
            "MVP M3: the canonical, SHARED, multi-tenant Qdrant collection "
            "(Phase 0.A) both Team 4A's canonical /v1/ingest and Team 4B's "
            "canonical query path use -- distinct from `qdrant_collection_name` "
            "above (the older, legacy production collection), which "
            "remains untouched and is not used by the new canonical query "
            "path. Payload indexes already provisioned: workspace_id "
            "(KEYWORD), document_id (KEYWORD), ingestion_generation "
            "(INTEGER) -- this setting does not create or modify them."
        ),
    )
    mongo_url: str = Field(
        default="mongodb://localhost:27017",
        description=(
            "MVP M4: the ONLY reason Team 4B ever connects to MongoDB at "
            "all -- a narrow, read-only authority check against Team 4C's "
            "`File.currentIngestionGeneration` (app/services/generation_authority.py). "
            "Team 4B never writes to Mongo, never creates/mutates a File "
            "document, and this is the sole client construction point for "
            "any Mongo access anywhere in this codebase."
        ),
    )
    mongo_database_name: str = Field(
        default="edu-copilot-team-c",
        description="Team 4C's own MongoDB database name -- Team 4B remains a read-only guest here.",
    )
    mongo_files_collection_name: str = Field(
        default="files",
        description="Team 4C's `File` collection name -- the only collection Team 4B ever reads.",
    )
    generation_authority_mongo_timeout_ms: int = Field(
        default=2000,
        description=(
            "MVP M4 fail-closed requirement: a bounded timeout for the "
            "generation-authority Mongo read. A timeout is treated "
            "identically to Mongo being unavailable -- the candidate(s) "
            "in flight are excluded, never assumed current."
        ),
        gt=0,
    )
    embedding_dimensions: int = Field(
        default=384,
        description=(
            "Vector dimensionality for the shared production collection. "
            "384 matches Team 4A's verified all-MiniLM-L6-v2 output; kept "
            "configurable rather than hard-coded per the approved "
            "checkpoint (Team 4B's own spec permits 384 or 768)."
        ),
        gt=0,
    )
    embedding_distance: Literal["Cosine", "Dot", "Euclid"] = Field(
        default="Cosine",
        description=(
            "Distance metric for the shared production collection. Cosine "
            "matches Team 4A's actual collection-init call "
            "(VectorParams(distance=Distance.COSINE)) and is the documented "
            "convention for all-MiniLM-L6-v2 embeddings."
        ),
    )
    embedding_model_name: str = Field(
        default="all-MiniLM-L6-v2",
        description=(
            "sentence-transformers model used for query-time embedding. "
            "Must match the model that produced the vectors already in "
            "the shared collection (Team 4A's all-MiniLM-L6-v2) so that "
            "query vectors and stored vectors live in the same space."
        ),
    )
    qdrant_publish_batch_size: int = Field(
        default=1000,
        description="Maximum chunks per batch indexing request (Requirement 1.3).",
        gt=0,
        le=1000,
    )
    vector_store_retry_count: int = Field(
        default=3,
        description="Retry attempts on Qdrant unavailability before VectorStoreUnavailable (Requirement 1.5).",
        ge=0,
    )
    vector_store_initial_backoff_seconds: float = Field(
        default=2.0,
        description="Initial backoff delay before the first retry; doubles on each subsequent retry.",
        gt=0,
    )

    # ------------------------------------------------------------------
    # Hybrid_Retriever (Requirement 2)
    # ------------------------------------------------------------------
    rrf_k: int = Field(
        default=60,
        description="Reciprocal Rank Fusion constant k (Requirement 2.2 / Property 5 default).",
        gt=0,
    )
    hybrid_candidate_pool_size: int = Field(
        default=100,
        description=(
            "ADDED IN TASK 3.2, not Task 1.1: neither official document "
            "specifies how many pre-fusion candidates HybridRetriever "
            "should pull from the Vector_Store before applying "
            "Reciprocal Rank Fusion, thresholding, and top_k (Properties "
            "5-6 all operate on the FUSED/final result, not on what each "
            "individual leg retrieves beforehand). This is a necessary, "
            "explicit Task 3.2 implementation decision, not a value "
            "either specification defines -- flagged here rather than "
            "silently assumed. The actual per-query pool used is "
            "max(top_k, this value), so a caller's own larger top_k is "
            "always respected."
        ),
        gt=0,
    )

    # ------------------------------------------------------------------
    # Reranker (Phase 4B -- generalized post-RRF retrieval-quality layer)
    # ------------------------------------------------------------------
    reranker_enabled: bool = Field(
        default=False,
        description=(
            "Phase 4B: OPT-IN ONLY, False by default -- preserves the exact "
            "pre-Phase-4B retrieval behavior (RRF/similarity-ordered "
            "results, never reranked) for every existing deployment until "
            "an operator explicitly turns this on. Never enabled "
            "automatically by this codebase."
        ),
    )
    reranker_model_name: str = Field(
        default="cross-encoder/mmarco-mMiniLMv2-L12-H384-v1",
        description=(
            "sentence-transformers CrossEncoder model used to rerank the "
            "post-RRF candidate pool. Chosen for CPU-practical size "
            "(~470MB, 12-layer MiniLM) and multilingual training data "
            "(mMARCO covers English and Hindi, among other languages) -- "
            "see app/services/reranker.py's module docstring for the "
            "evaluated alternative and its tradeoffs."
        ),
    )
    reranker_candidate_pool_size: int = Field(
        default=40,
        description=(
            "Phase 4B: number of post-RRF/post-threshold candidates handed "
            "to the reranker before truncating to a caller's top_k. The "
            "pool actually used is max(top_k, this value), matching "
            "hybrid_candidate_pool_size's own precedent -- a caller's "
            "larger top_k is always respected. Neither official spec "
            "defines this Phase 4B concept; 40 is a deliberate middle of "
            "the requested 30-50 range: large enough to give the reranker "
            "real headroom to promote a candidate RRF ranked outside the "
            "final top_k, small enough to keep reranking latency low."
        ),
        gt=0,
    )

    # ------------------------------------------------------------------
    # Retrieval_Config defaults (Requirement 7)
    # ------------------------------------------------------------------
    default_top_k: int = Field(
        default=5,
        description="Default top_k when a query doesn't override it.",
        ge=1,
        le=50,
    )
    default_score_threshold: float = Field(
        default=0.3,
        description="Default score_threshold when a query doesn't override it.",
        ge=0.0,
        le=1.0,
    )
    default_search_mode: Literal["hybrid", "semantic", "keyword"] = Field(
        default="hybrid",
        description="Default search_mode when a query doesn't override it.",
    )

    # ------------------------------------------------------------------
    # LLM_Generator / Ollama (Requirement 3)
    # ------------------------------------------------------------------
    ollama_url: str = Field(
        default="http://localhost:11434",
        description="Base URL of the Ollama instance used for response generation.",
    )
    ollama_model_name: str = Field(
        default="llama3",
        description="Ollama model used for response generation.",
    )
    llm_generation_timeout_seconds: float = Field(
        default=15.0,
        description="Target/maximum generation time for up to 10 retrieved chunks (Requirement 3.5).",
        gt=0,
    )
    ollama_num_gpu: int | None = Field(
        default=None,
        description=(
            "MVP M6 reliability correction -- OPT-IN ONLY, `None` by default, "
            "preserving Ollama's own default GPU/CPU allocation exactly as "
            "before this field existed. Live evidence on one specific local "
            "Windows/RTX 3050 environment showed Ollama's own llama-server "
            "worker process crashing with a genuine CUDA initialization "
            "failure (exit status 0xc0000409) under its own default mixed "
            "GPU/CPU allocation -- a real instability in Ollama's own GPU "
            "backend on that specific hardware/driver combination, not a "
            "defect in this application's request construction (confirmed: "
            "the request sent is a bare {model, prompt, stream=false}, no "
            "GPU-related parameter at all, so this crash is not something "
            "this codebase was ever causing). Setting this to `0` lets an "
            "operator experiencing that exact instability force CPU-only "
            "Ollama inference (trading speed for stability) via their own "
            "local .env, without changing this service's default behavior "
            "for any other environment. Never set automatically, never "
            "inferred from a crash -- an explicit, informed operator choice."
        ),
    )
    ollama_num_predict: int | None = Field(
        default=None,
        ge=1,
        description=(
            "MVP M6 local-stabilization correction -- OPT-IN ONLY, `None` by "
            "default, preserving Ollama's own default (model-determined, "
            "effectively unbounded) output length exactly as before this "
            "field existed. Evidence: a revision-notes request's real prompt "
            "(system instructions + up to 5 full retrieved chunks + history) "
            "combined with uncapped CPU-only generation length pushed total "
            "request time past the configured LLM generation timeout. "
            "Setting this caps the number of tokens Ollama may generate for "
            "one request, giving an explicit, controllable ceiling on "
            "generation time -- independent of how large the retrieved "
            "context happens to be. Never set automatically; an explicit, "
            "informed operator choice, exactly like `ollama_num_gpu` above."
        ),
    )

    # ------------------------------------------------------------------
    # Conversation_Manager / Redis (Requirements 4, 5)
    # ------------------------------------------------------------------
    redis_url: str = Field(
        default="redis://localhost:6379/0",
        description="Redis connection URL used for session/conversation storage.",
    )
    session_ttl_minutes: int = Field(
        default=30,
        description="Session inactivity expiry, reset on each interaction (Requirement 4.6).",
        gt=0,
    )
    conversation_window_size: int = Field(
        default=5,
        description="Number of recent conversation turns included in the LLM prompt (Requirement 5.3).",
        gt=0,
    )

    # ------------------------------------------------------------------
    # Evaluation_Pipeline / RAGAS (Requirement 8)
    # ------------------------------------------------------------------
    evaluation_batch_max_size: int = Field(
        default=50,
        description="Maximum query-response pairs per evaluation batch (Requirement 8.2).",
        gt=0,
    )
    evaluation_batch_timeout_seconds: float = Field(
        default=60.0,
        description="Target/maximum processing time for a full evaluation batch (Requirement 8.2).",
        gt=0,
    )
    faithfulness_flag_threshold: float = Field(
        default=0.5,
        description="Faithfulness scores below this value are flagged as potentially hallucinated (Requirement 8.4).",
        ge=0.0,
        le=1.0,
    )
    evaluation_results_path: str = Field(
        default="data/evaluation_results.jsonl",
        description=(
            "ADDED IN TASK 9.1: file path for JSONL-backed, timestamped "
            "evaluation-result persistence (Requirement 8's 'timestamped "
            "evaluation storage'). Neither official document specifies an "
            "exact storage mechanism; a file-backed JSONL append log was "
            "chosen as the smallest production-sensible option that "
            "doesn't require a new database dependency -- documented in "
            "app/services/evaluation.py's module docstring."
        ),
    )

    # ------------------------------------------------------------------
    # Phase 2B (Rev.4.4 internal service JWT foundation).
    #
    # 4B holds ONLY verification configuration -- no private signing key
    # field exists anywhere in this class. `service_jwt_public_keys_json`
    # is a JSON-encoded {kid: PEM_public_key} map (never a private key) --
    # see app/security/service_jwt.py::load_public_keys_json, the one
    # place this string is ever parsed.
    # ------------------------------------------------------------------
    service_jwt_expected_issuer: str = Field(
        default="https://educopilot.internal",
        description="The fixed internal issuer identifier every accepted service JWT must present as `iss`.",
    )
    service_jwt_expected_audience: str = Field(
        default="team4b-query",
        description="This service's own audience identifier -- a token minted for team4a-ingestion must never verify here.",
    )
    service_jwt_required_scope: str = Field(
        default="query",
        description="The narrow scope an internal service JWT must carry to be accepted by Team 4B.",
    )
    service_jwt_clock_skew_seconds: int = Field(
        default=30,
        description="Tolerance applied to `exp` (via PyJWT's own leeway) and, explicitly, to a future-dated `iat`.",
        ge=0,
    )
    service_jwt_public_keys_json: str = Field(
        default="{}",
        description="JSON-encoded {kid: PEM public key} map. NEVER a private key -- verification-only.",
    )

    # ------------------------------------------------------------------
    # Security Hardening Stage 1 -- CORS
    # ------------------------------------------------------------------
    #: This is a purely internal, service-to-service API (Team 4C's
    #: server calls it with a service JWT that is never exposed to a
    #: browser; no legitimate browser origin should ever call it
    #: directly). The correct default deployment posture is therefore NO
    #: cross-origin browser access at all -- an empty list here means
    #: `create_app()` adds no permissive `Access-Control-Allow-Origin`
    #: header, matching FastAPI/Starlette's own un-configured default
    #: exactly, but now an explicit, auditable decision rather than an
    #: accidental omission. Left overridable (never hard-coded) only in
    #: case a genuinely new deployment shape needs it -- never widened
    #: automatically by this codebase.
    cors_allowed_origins: list[str] = Field(default_factory=list)

    # ------------------------------------------------------------------
    # Security Hardening Stage 1 -- rate limiting for expensive operations
    # ------------------------------------------------------------------
    #: Bounds how many expensive calls (real LLM generation or a real
    #: RAGAS/embedding batch) one authenticated internal-service identity
    #: (the JWT's own `sub`+`workspace_id`) may make per rolling window --
    #: a defense-in-depth control against a compromised/misbehaving
    #: caller driving unbounded LLM/embedding cost, not a general traffic
    #: shaper. Deliberately generous: this must never throttle this
    #: product's own real, legitimate chat/evaluation traffic under
    #: normal use.
    rate_limit_requests_per_window: int = Field(default=30, gt=0)
    rate_limit_window_seconds: int = Field(default=60, gt=0)

    @field_validator("log_level")
    @classmethod
    def _log_level_must_be_a_known_level(cls, value: str) -> str:
        normalized = value.strip().upper()
        valid_levels = {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}
        if normalized not in valid_levels:
            raise ValueError(f"log_level must be one of {sorted(valid_levels)}, got {value!r}")
        return normalized


@lru_cache
def get_settings() -> Settings:
    """Return a cached Settings instance.

    Cached so the environment/``.env`` file is only parsed once per
    process, while remaining easy to override in tests via
    ``get_settings.cache_clear()``.
    """

    return Settings()
