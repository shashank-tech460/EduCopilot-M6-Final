"""Central configuration for the Team 4A Multi-Modal Data Ingestion service.

All values are environment-overridable so the service can run identically in
local development and in later deployment environments without code changes.
Defaults reflect the values specified in the official Team 4A requirements
and design document.

Values here are grouped by the pipeline stage that consumes them:

    FastAPI -> Celery/Redis -> Source Processors -> Chunker
    -> Embedding Generator -> Metadata Enricher -> Vector DB Publisher -> Qdrant

This module only defines configuration. It does not implement any processor,
pipeline stage, task, or route — those are introduced in later tasks.
"""

from __future__ import annotations

from functools import lru_cache

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime configuration for the Ingestion_Service and its workers.

    Every field can be overridden via an environment variable of the same
    name (case-insensitive), or via a local `.env` file. See `model_config`
    below.
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

    # ------------------------------------------------------------------
    # Chunker (Requirement 4)
    # ------------------------------------------------------------------
    chunk_size: int = Field(
        default=512,
        description="Target chunk size in tokens.",
        gt=0,
    )
    chunk_overlap: int = Field(
        default=50,
        description="Overlap between consecutive chunks, in tokens.",
        ge=0,
    )

    # ------------------------------------------------------------------
    # Embedding Generator (Requirement 5)
    # ------------------------------------------------------------------
    embedding_model_name: str = Field(
        default="all-MiniLM-L6-v2",
        description="sentence-transformers model used to generate embeddings.",
    )
    embedding_batch_size: int = Field(
        default=32,
        description="Number of chunks embedded per batch.",
        gt=0,
    )
    embedding_device: str = Field(
        default="cpu",
        description=(
            "Device used for embedding inference. Defaults to CPU so local "
            "development does not require a GPU. Set to 'cuda' to use a GPU "
            "where available."
        ),
    )
    embedding_dimensions: int = Field(
        default=384,
        description="Expected output dimensionality for the configured embedding model.",
        gt=0,
    )
    embedding_model_revision: str = Field(
        default="ea78891063587eb050ed4166b20062eaf978037c",
        description=(
            "Pinned Hugging Face Hub commit SHA for `embedding_model_name`, used as "
            "the embedding_model_version for provenance tracking (Requirement 6.5). "
            "Passed to sentence-transformers' `revision=` parameter so the exact "
            "pinned model snapshot is what actually gets loaded, not merely a label. "
            "Default is a real, verified commit on "
            "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/commits/main "
            "-- deliberately not the newest commit, so upstream repo pushes don't "
            "silently change which weights are loaded. Update this value (and verify "
            "the new hash) when intentionally upgrading the pinned model snapshot."
        ),
    )

    # ------------------------------------------------------------------
    # Video Processor (Requirement 2)
    # ------------------------------------------------------------------
    keyframe_interval_seconds: int = Field(
        default=30,
        description="Interval, in seconds, at which keyframes are extracted from video.",
        gt=0,
    )
    video_max_size_gb: int = Field(
        default=2,
        description="Maximum supported MP4 file size, in gigabytes.",
        gt=0,
    )
    video_max_duration_hours: int = Field(
        default=4,
        description="Maximum supported MP4 duration, in hours.",
        gt=0,
    )
    whisper_model_name: str = Field(
        default="base",
        description="openai-whisper model size used for audio transcription.",
    )
    whisper_device: str = Field(
        default="cpu",
        description=(
            "Device used for Whisper inference. Defaults to CPU so local "
            "development does not require a GPU."
        ),
    )

    # ------------------------------------------------------------------
    # PDF Processor (Requirement 1)
    # ------------------------------------------------------------------
    pdf_max_size_mb: int = Field(
        default=200,
        description="Maximum supported PDF file size, in megabytes.",
        gt=0,
    )
    pdf_max_pages: int = Field(
        default=5000,
        description="Maximum supported PDF page count.",
        gt=0,
    )

    # ------------------------------------------------------------------
    # YouTube Processor (Requirement 3)
    # ------------------------------------------------------------------
    youtube_default_language: str = Field(
        default="en",
        description="Default transcript language requested from the YouTube Transcript API.",
    )
    youtube_fallback_language: str | None = Field(
        default="hi",
        description=(
            "MVP M6 English+Hindi correction -- if the canonical YouTube "
            "extraction path's primary transcript request "
            "(youtube_default_language) raises TranscriptUnavailableError, "
            "exactly one deterministic fallback attempt is made in this "
            "language before surfacing the final, still-controlled error. "
            "Set to None to disable the fallback entirely (single-language "
            "behavior, matching pre-M6 behavior exactly). Not an LLM-driven "
            "or translated retry -- a second, ordinary request for a "
            "genuinely different transcript track that may already exist "
            "on the video."
        ),
    )

    # ------------------------------------------------------------------
    # Job Manager / Celery / Redis (Requirement 8)
    # ------------------------------------------------------------------
    redis_broker_url: str = Field(
        default="redis://localhost:6379/0",
        description="Redis connection URL used as the Celery message broker.",
    )
    redis_result_backend_url: str = Field(
        default="redis://localhost:6379/1",
        description="Redis connection URL used as the Celery result backend.",
    )
    celery_task_acks_late: bool = Field(
        default=True,
        description="Whether Celery tasks are acknowledged only after completion.",
    )
    celery_worker_prefetch_multiplier: int = Field(
        default=1,
        description="Number of tasks a Celery worker prefetches at a time.",
        ge=1,
    )
    celery_visibility_timeout_seconds: int = Field(
        default=60,
        description=(
            "Time after which an unacknowledged task is considered lost and "
            "re-queued for another worker."
        ),
        gt=0,
    )
    celery_worker_concurrency: int = Field(
        default=10,
        description="Minimum number of Ingestion_Jobs the Job_Manager must process concurrently.",
        gt=0,
    )

    # ------------------------------------------------------------------
    # Vector DB Publisher / Qdrant (Requirement 7)
    # ------------------------------------------------------------------
    qdrant_url: str = Field(
        default="http://localhost:6333",
        description="Base URL of the Qdrant instance chunks are published to.",
    )
    qdrant_api_key: str | None = Field(
        default=None,
        description="Optional Qdrant API key, required for secured deployments.",
    )
    qdrant_collection_name: str = Field(
        default="team4a_ingested_chunks",
        description="Qdrant collection that ingested chunks are published to.",
    )
    qdrant_publish_batch_size: int = Field(
        default=100,
        description="Maximum number of chunk records written to Qdrant per batch.",
        gt=0,
        le=100,
    )
    publisher_retry_count: int = Field(
        default=3,
        description="Number of retry attempts on Vector DB write failure.",
        ge=0,
    )
    publisher_initial_backoff_seconds: float = Field(
        default=2.0,
        description="Initial delay before the first retry; doubles on each subsequent retry.",
        gt=0,
    )

    # ------------------------------------------------------------------
    # PHASE 1 (Rev.4.4 canonical identity + ingestion-generation layer).
    #
    # Additive only: nothing above this block is changed, renamed, or
    # removed. `qdrant_collection_name` above remains 4A's *legacy*
    # collection default and is untouched -- the canonical write path
    # introduced in Phase 1 targets `canonical_qdrant_collection_name`
    # instead, via an entirely separate code path (CanonicalIngestionOrchestrator
    # / MutationAuthorityAdapter), never the existing `Publisher`/legacy
    # Celery tasks. This is what guarantees the legacy collection can
    # never receive new production writes as a side effect of Phase 1.
    # ------------------------------------------------------------------
    canonical_qdrant_collection_name: str = Field(
        default="educopilot_chunks",
        description=(
            "The Rev.4.4 canonical, tenant-aware Qdrant collection. Distinct from "
            "`qdrant_collection_name` (4A's legacy collection) on purpose -- the two "
            "are never conflated, and no code path writes canonical chunks to the "
            "legacy collection or vice versa."
        ),
    )

    # -- Mongo generation authority (narrow, explicitly scoped) ---------
    # Rev.4.4 §15/§16: 4A may read/write ONLY File.currentIngestionGeneration,
    # keyed by document_id (File._id). No other Mongo access is introduced.
    mongo_url: str = Field(
        default="mongodb://localhost:27017",
        description="Connection string for the narrow, explicitly-scoped Mongo generation-authority client.",
    )
    mongo_database_name: str = Field(
        default="educopilot",
        description="Database containing the `files` collection's `currentIngestionGeneration` field.",
    )
    mongo_files_collection_name: str = Field(
        default="files",
        description="Collection holding one document per File._id (= canonical document_id).",
    )

    # -- Ingestion lock / generation issuance (Redis-coordinated) --------
    ingestion_lock_lease_seconds: int = Field(
        default=14400,  # 4 hours, matching video_max_duration_hours' own ceiling
        description="Maximum time a worker may hold the per-document ingestion lock before it is considered abandoned.",
        gt=0,
    )
    ingestion_lock_renewal_fraction: float = Field(
        default=0.25,
        description="Renew the lock every (lease_seconds * this fraction) seconds during long-running stages.",
        gt=0,
        lt=1,
    )

    # -- Stage 2 Part B: legacy route (/ingest/pdf|video|youtube)
    # content-hash deduplication -------------------------------------
    #: Unlike the canonical /v1/ingest path (an in-process orchestration
    #: that actively RENEWs its lock throughout processing), the legacy
    #: routes only dispatch to a fire-and-forget Celery task and return
    #: immediately -- there is no in-process owner left alive to release
    #: this lock once processing genuinely finishes. It is therefore
    #: sized as a fixed window generous enough to cover this project's
    #: own measured PDF/video processing times (Team4A's own docs cite
    #: 8-55s per ingestion) with real headroom, not as a lease that gets
    #: renewed -- a duplicate submission of the EXACT SAME file content
    #: within this window is rejected; the same content submitted again
    #: after this window elapses is treated as a fresh, legitimate
    #: request (e.g. a deliberate re-upload after deleting the original).
    legacy_ingest_dedup_lease_seconds: int = Field(
        default=600,
        description="How long a legacy-route content hash stays claimed, rejecting duplicate submissions of the same bytes/URL.",
        gt=0,
    )

    # -- Stage 2 Part C: stuck-job (worker-crash) recovery ----------------
    #: A legacy-route IngestionJob's `updated_at` is touched at task start
    #: and at each of the 4 pipeline stage boundaries (app/tasks.py's
    #: `_touch_and_persist`) -- if a worker crashes mid-task, no further
    #: touch ever happens and the job is left at status=PROCESSING
    #: forever (Celery's own `task_acks_late`/`visibility_timeout`
    #: redelivery only helps once *some* worker is running again to poll
    #: for it; a worker that is never restarted leaves the job stuck with
    #: no path to recovery at all). There is deliberately no finer-grained
    #: mid-stage heartbeat than these 4 touches (adding one would be a
    #: pipeline-architecture change, out of this stage's scope), so
    #: staleness cannot be distinguished from "one single stage is
    #: legitimately still running" at a finer resolution than this. This
    #: value is therefore set to match `ingestion_lock_lease_seconds`
    #: (this project's own existing definition, on the canonical path, of
    #: "the maximum time a worker may hold a single document before being
    #: considered abandoned") rather than a new, smaller, arbitrary
    #: number -- avoiding false positives against a genuinely long-running
    #: single stage (e.g. Whisper transcription of a multi-hour video).
    stale_processing_threshold_seconds: int = Field(
        default=14400,
        description="A legacy-route job stuck at status=PROCESSING with no progress touch for longer than this is treated as abandoned (worker crash), not merely slow, and recovered to FAILED.",
        gt=0,
    )

    # ------------------------------------------------------------------
    # Phase 2B (Rev.4.4 internal service JWT foundation).
    #
    # 4A holds ONLY verification configuration -- no private signing key
    # field exists anywhere in this class, and none should ever be added
    # here. `service_jwt_public_keys_json` is a JSON-encoded
    # `{kid: PEM_public_key}` map (never a private key), read from the
    # environment as a single string because pydantic-settings' native
    # dict-from-env-var support requires a specific, easy-to-get-wrong
    # env-var-naming convention this project doesn't otherwise use --
    # `app.security.service_jwt.load_public_keys_json` is the one place
    # this string is ever parsed.
    # ------------------------------------------------------------------
    service_jwt_expected_issuer: str = Field(
        default="https://educopilot.internal",
        description="The fixed internal issuer identifier every accepted service JWT must present as `iss`.",
    )
    service_jwt_expected_audience: str = Field(
        default="team4a-ingestion",
        description="This service's own audience identifier -- a token minted for team4b-query must never verify here.",
    )
    service_jwt_required_scope: str = Field(
        default="ingest",
        description="The narrow scope an internal service JWT must carry to be accepted by Team 4A.",
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
    # Phase 2C-R (secure file_url retrieval for the canonical /v1/ingest
    # route -- PDF/MP4 only; YouTube uses YouTubeProcessor's own,
    # separate, already-hardened host validation and is NOT governed by
    # these settings at all).
    #
    # `file_url_trusted_origins` is a JSON-encoded list of EXACT hostnames
    # (never substrings/suffixes -- "trusted.example" must not match
    # "trusted.example.attacker.com"). Reuses `pdf_max_size_mb`/
    # `video_max_size_gb` for size limits rather than introducing
    # duplicate settings, per this project's own "smallest necessary
    # change" convention.
    # ------------------------------------------------------------------
    file_url_trusted_origins_json: str = Field(
        default="[]",
        description="JSON-encoded list of EXACT trusted hostnames file_url may point to. Fail-closed: empty means nothing is trusted.",
    )
    file_url_connect_timeout_seconds: float = Field(default=5.0, gt=0)
    file_url_read_timeout_seconds: float = Field(default=30.0, gt=0)
    file_url_total_timeout_seconds: float = Field(default=300.0, gt=0)
    file_url_max_redirects: int = Field(
        default=0,
        description="Redirects are rejected, not followed, by default -- the single most common SSRF-allowlist-bypass vector.",
        ge=0,
    )
    file_url_require_https: bool = Field(
        default=True,
        description="Reject http:// file_url values unless explicitly disabled (e.g. for deterministic local test infrastructure).",
    )

    # ------------------------------------------------------------------
    # Job progress stage weights (Requirement 8.3)
    # ------------------------------------------------------------------
    progress_extraction_pct: int = Field(default=25, ge=0, le=100)
    progress_chunking_pct: int = Field(default=50, ge=0, le=100)
    progress_embedding_pct: int = Field(default=75, ge=0, le=100)
    progress_publication_pct: int = Field(default=100, ge=0, le=100)

    # ------------------------------------------------------------------
    # Task 10.1: API file upload boundary
    # ------------------------------------------------------------------
    upload_directory: str = Field(
        default="/tmp/team4a_uploads",
        description=(
            "Local directory where POST /ingest/pdf and POST /ingest/video "
            "save uploaded files before Task 10.2's Celery task picks them "
            "up. Not cloud storage -- the official spec doesn't define "
            "external storage for Team 4A, so a configurable local "
            "directory is used, per Task 10.1's explicit guidance."
        ),
    )

    # ------------------------------------------------------------------
    # Production Hardening Task 6: structured logging
    # ------------------------------------------------------------------
    log_level: str = Field(
        default="INFO",
        description=(
            "Application log level, used by both the API and the Celery "
            "worker (see app/logging_config.py). Accepts the standard "
            "logging level names: DEBUG, INFO, WARNING, ERROR, CRITICAL."
        ),
    )

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

    Cached so the environment/`.env` file is only parsed once per process,
    while still remaining easy to override in tests via
    `get_settings.cache_clear()`.
    """

    return Settings()
