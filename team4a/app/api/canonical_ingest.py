"""Phase 2C / 2C-R -- the canonical `POST /v1/ingest` route (Rev.4.4 /
Phase 2A's frozen 4C -> 4A contract), authenticated via Phase 2B's
internal service JWT verifier, now wired through Phase 2C-R's secure
`file_url` retrieval into the existing Phase 1 canonical orchestration.

DISTINCT FROM LEGACY ROUTES: `/ingest/pdf`, `/ingest/video`,
`/ingest/youtube`, and `/jobs/{job_id}` (all in app/api/routes.py) are
existing, unmodified, unauthenticated, multipart-upload-based routes.
This module implements ONLY the new, separate, JWT-authenticated
canonical contract -- it does not replace, migrate, or share request
handling with the legacy routes in any way.

============================================================
FLOW (pdf / mp4)
============================================================
    JWT verification -> canonical request validation ->
    remote_source_resolver.resolve_pdf_or_mp4_source() (secure,
    IP-pinned, size/timeout/content-validated download to a temp file) ->
    existing PDFProcessor/VideoProcessor (via canonical_extraction.py,
    which reuses the exact same Chunker/Embedder/MetadataEnricher calls
    app/tasks.py's own pipelines use) -> existing Phase 1
    CanonicalIngestionOrchestrator (lock+generation, canonical Qdrant
    publication, Mongo completion-time authority, self-healing, cleanup
    -- all unmodified) -> temp file cleanup (always, success or failure).

============================================================
FLOW (youtube)
============================================================
    JWT verification -> canonical request validation -> `file_url` (a
    real YouTube URL) passed DIRECTLY to the existing, already-hardened
    `YouTubeProcessor.process()` -- `remote_source_resolver` is NEVER
    used for YouTube; that processor's own host validation
    (`_WATCH_HOSTS`/`_SHORT_HOST`) is the only URL check this branch
    relies on, exactly as the legacy `/ingest/youtube` route already
    does -- then into the same Phase 1 orchestration as pdf/mp4.
"""

from __future__ import annotations

import logging
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict, field_validator

from app.api.auth_dependency import require_ingest_identity
from app.config.settings import Settings, get_settings
from app.models.exceptions import TranscriptUnavailableError, VideoInaccessibleError
from app.models.schemas import SourceType
from app.pipeline.canonical_extraction import (
    extract_pdf_for_canonical_ingestion,
    extract_video_for_canonical_ingestion,
    extract_youtube_for_canonical_ingestion,
)
from app.pipeline.canonical_ingestion import (
    CanonicalIngestionInput,
    CanonicalIngestionOrchestrator,
    CanonicalIngestionOutcome,
    TrustedIdentityContext,
)
from app.pipeline.canonical_mutations import RealQdrantMutationClient
from app.pipeline.ingestion_lock import DocumentAlreadyLockedError, IngestionLock
from app.pipeline.mongo_authority import MongoAuthorityClient
from app.pipeline.publisher import Publisher, RealQdrantClient
from app.pipeline.remote_source_resolver import (
    ContentValidationError,
    RemoteFetchError,
    TrustedOriginError,
    resolve_pdf_or_mp4_source,
)
from app.security.service_jwt import ServiceIdentity

logger = logging.getLogger(__name__)

canonical_router = APIRouter()

#: STEP 1 REMEDIATION -- set once `_ensure_local_demo_canonical_collection`
#: has confirmed (or created) the canonical collection, so repeat requests
#: within this process don't re-check Qdrant on every single ingest call.
#: Left `False` on any failure, so the very next request retries -- never
#: cached as "done" on a failure path.
_canonical_collection_ensured = False


def _ensure_local_demo_canonical_collection(settings: Settings, client: object = None) -> None:
    """Idempotently create the SHARED canonical Qdrant collection
    (`educopilot_chunks`) for THIS PROJECT'S OWN self-contained local/demo
    deployment, if it does not already exist -- the canonical-ingestion
    sibling of `app/celery_app.py`'s `_ensure_local_demo_qdrant_collection`
    for the legacy collection. Same scope note applies verbatim: Team 4B
    is the documented owner of this collection's production lifecycle
    (`team4b/app/services/vector_store.py` deliberately only VERIFIES,
    never creates, the canonical collection when a caller supplies one
    other than its own configured legacy collection). This function exists
    ONLY so this project's own bundled local/demo Qdrant instance doesn't
    require an undocumented manual provisioning step before the very
    first canonical ingestion can ever succeed -- in a real multi-team
    deployment this collection is expected to already exist, and this
    function's create branch would never execute.

    ROOT CAUSE this fixes: without this, `Publisher.publish()`'s first
    write to a not-yet-existing `educopilot_chunks` fails (correctly,
    cleanly, with retries exhausted), and the orchestrator's own
    self-heal cleanup for the (zero) points published then ALSO hit the
    same missing-collection error -- previously unhandled, crashing with
    a bare 500 that hid the real cause (see `canonical_mutations.py`'s
    `_tolerate_missing_collection`, the companion fix for that second
    half of the bug). This function addresses the root cause directly:
    the collection now exists before the first publish attempt ever runs.

    Deliberately lazy, best-effort, never blocking a request: any
    failure here is logged and swallowed -- if the collection genuinely
    doesn't get created, the existing, unmodified Publisher retry/
    backoff/`PublicationFailedError` contract handles that exactly as it
    already did before this function existed. Payload indexes
    (`workspace_id`, `document_id`, `ingestion_generation`) match
    `team4b/app/core/config.py`'s own documented expectation for this
    collection.
    """

    global _canonical_collection_ensured
    if _canonical_collection_ensured:
        return

    try:
        if client is None:
            from qdrant_client import QdrantClient

            client = QdrantClient(url=settings.qdrant_url, api_key=settings.qdrant_api_key, check_compatibility=False)

        collection_name = settings.canonical_qdrant_collection_name
        existing_names = {collection.name for collection in client.get_collections().collections}

        if collection_name not in existing_names:
            from qdrant_client.models import Distance, PayloadSchemaType, VectorParams

            client.create_collection(
                collection_name=collection_name,
                vectors_config=VectorParams(size=settings.embedding_dimensions, distance=Distance.COSINE),
            )
            client.create_payload_index(collection_name, "workspace_id", PayloadSchemaType.KEYWORD)
            client.create_payload_index(collection_name, "document_id", PayloadSchemaType.KEYWORD)
            client.create_payload_index(collection_name, "ingestion_generation", PayloadSchemaType.INTEGER)
            logger.info(
                "Created canonical Qdrant collection for local/demo deployment "
                "(a real deployment is expected to already have this provisioned)",
                extra={
                    "collection": collection_name,
                    "vector_size": settings.embedding_dimensions,
                    "distance": "cosine",
                },
            )
        else:
            logger.info(
                "Canonical Qdrant collection already exists (local/demo provisioning check) -- nothing to do",
                extra={"collection": collection_name},
            )

        _canonical_collection_ensured = True

    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "Could not verify/create the local/demo canonical Qdrant collection "
            "(the existing Publisher retry/backoff contract handles this during "
            "actual publication if it remains unresolved)",
            extra={"collection": settings.canonical_qdrant_collection_name, "error_type": type(exc).__name__},
        )


class CanonicalIngestRequest(BaseModel):
    """The frozen Phase 2A canonical request body -- EXACTLY
    `{document_id, file_type, file_url}`, nothing else. `extra="forbid"`
    is the tenancy-invariant enforcement mechanism at the contract layer.
    """

    model_config = ConfigDict(extra="forbid")

    document_id: str
    file_type: SourceType
    file_url: str

    @field_validator("document_id")
    @classmethod
    def _document_id_must_be_non_blank(cls, value: str) -> str:
        if not value or not value.strip():
            raise ValueError("document_id must not be blank")
        return value

    @field_validator("file_url")
    @classmethod
    def _file_url_must_be_a_well_formed_http_url(cls, value: str) -> str:
        if not value or not value.strip():
            raise ValueError("file_url must not be blank")
        if not (value.startswith("http://") or value.startswith("https://")):
            raise ValueError("file_url must be an http(s) URL")
        return value


class CanonicalIngestResponse(BaseModel):
    document_id: str
    workspace_id: str
    file_type: SourceType
    status: str
    generation: int | None = None


def get_canonical_orchestrator(settings: Settings = Depends(get_settings)) -> CanonicalIngestionOrchestrator:
    """Constructs the REAL Phase 1 orchestrator from real infrastructure
    clients (Redis, Mongo, Qdrant) -- unmodified Phase 1 classes, used
    exactly as their own test suites use them. Overridden in tests via
    `app.dependency_overrides` with fake-but-real-protocol doubles
    (fakeredis/mongomock/an in-memory Qdrant double), matching Phase 1's
    own established test convention -- never overridden with a mock of
    the orchestrator's own logic.
    """

    import pymongo
    import redis

    _ensure_local_demo_canonical_collection(settings)

    redis_client = redis.Redis.from_url(settings.redis_broker_url)
    mongo_client = pymongo.MongoClient(settings.mongo_url)
    lock = IngestionLock(redis_client)
    mongo_authority = MongoAuthorityClient(mongo_client, settings.mongo_database_name, settings.mongo_files_collection_name)
    qdrant_client = RealQdrantClient(settings.qdrant_url, settings.qdrant_api_key)
    qdrant_mutations = RealQdrantMutationClient(settings.qdrant_url, settings.qdrant_api_key)
    publisher = Publisher(settings=settings, qdrant_client=qdrant_client)

    return CanonicalIngestionOrchestrator(
        lock=lock,
        publisher=publisher,
        mutation_client=qdrant_mutations,
        mongo_authority=mongo_authority,
        canonical_collection_name=settings.canonical_qdrant_collection_name,
        lease_seconds=settings.ingestion_lock_lease_seconds,
    )


_OUTCOME_TO_STATUS = {
    CanonicalIngestionOutcome.COMPLETED: status.HTTP_202_ACCEPTED,
    CanonicalIngestionOutcome.ABORTED_LOCK_LOST: status.HTTP_409_CONFLICT,
    CanonicalIngestionOutcome.ABORTED_AUTHORITY_LOST: status.HTTP_409_CONFLICT,
    CanonicalIngestionOutcome.ABORTED_MISSING_FILE: status.HTTP_404_NOT_FOUND,
}


@canonical_router.post("/v1/ingest", response_model=CanonicalIngestResponse, status_code=status.HTTP_202_ACCEPTED)
def canonical_ingest(
    body: CanonicalIngestRequest,
    identity: ServiceIdentity = Depends(require_ingest_identity),
    orchestrator: CanonicalIngestionOrchestrator = Depends(get_canonical_orchestrator),
    settings: Settings = Depends(get_settings),
) -> CanonicalIngestResponse:
    """The canonical Phase 2A ingestion endpoint.

    TENANCY INVARIANT: `workspace_id`/`user_id` are read EXCLUSIVELY from
    `identity` (the verified JWT) -- `body` has no such fields to read
    from at all (schema-enforced, see `CanonicalIngestRequest`).
    """

    workspace_id = identity.workspace_id
    user_id = identity.sub

    temp_file_path: Path | None = None
    try:
        if body.file_type is SourceType.YOUTUBE:
            job_id = f"canonical-{body.document_id}"
            try:
                enriched_chunks, embeddings = extract_youtube_for_canonical_ingestion(job_id, body.file_url, settings)
            except VideoInaccessibleError as exc:
                # Same category as RemoteFetchError below (a real,
                # already-defined, ANTICIPATED YouTube processing failure
                # -- the video itself cannot be reached/read by
                # yt-dlp/youtube_transcript_api), not a client input
                # error and not an unexpected internal failure. Mapped
                # to the SAME status as RemoteFetchError/
                # ContentValidationError, matching the existing
                # PDF/MP4 branch's own convention for "we could not
                # obtain valid, processable content from the given
                # source" -- deliberately not inventing a third status
                # category for what is, at this level, the same kind of
                # failure.
                logger.warning(
                    "YouTube video inaccessible", extra={"document_id": body.document_id}
                )
                raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=exc.message) from exc
            except TranscriptUnavailableError as exc:
                # Same category/status as VideoInaccessibleError above --
                # the video was reachable, but no usable transcript
                # content could be obtained from it. This task
                # deliberately does NOT add multilingual fallback,
                # translation, or any change to transcript-language
                # selection -- only converts this already-defined,
                # already-raised domain exception into a controlled
                # response instead of an unhandled 500.
                logger.warning(
                    "YouTube transcript unavailable", extra={"document_id": body.document_id}
                )
                raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=exc.message) from exc
        else:
            try:
                temp_file_path = resolve_pdf_or_mp4_source(body.file_url, body.file_type, settings)
            except TrustedOriginError as exc:
                logger.warning("file_url rejected by trusted-origin policy", extra={"document_id": body.document_id})
                raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="file_url is not permitted.") from exc
            except (RemoteFetchError, ContentValidationError) as exc:
                logger.warning("file_url retrieval failed", extra={"document_id": body.document_id})
                raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Unable to retrieve file_url.") from exc

            job_id = f"canonical-{body.document_id}"
            if body.file_type is SourceType.PDF:
                enriched_chunks, embeddings = extract_pdf_for_canonical_ingestion(job_id, temp_file_path, settings)
            else:
                enriched_chunks, embeddings = extract_video_for_canonical_ingestion(job_id, temp_file_path, settings)

        canonical_input = CanonicalIngestionInput(
            identity=TrustedIdentityContext(document_id=body.document_id, workspace_id=workspace_id, user_id=user_id),
            enriched_chunks=enriched_chunks,
            embeddings=embeddings,
        )

        try:
            result = orchestrator.run(canonical_input)
        except DocumentAlreadyLockedError as exc:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="An ingestion attempt is already in progress for this document.") from exc

        http_status = _OUTCOME_TO_STATUS.get(result.outcome, status.HTTP_500_INTERNAL_SERVER_ERROR)
        if result.outcome != CanonicalIngestionOutcome.COMPLETED:
            raise HTTPException(status_code=http_status, detail=f"Ingestion did not complete: {result.outcome.value}")

        return CanonicalIngestResponse(
            document_id=body.document_id,
            workspace_id=workspace_id,
            file_type=body.file_type,
            status=result.outcome.value,
            generation=result.generation,
        )
    finally:
        if temp_file_path is not None:
            temp_file_path.unlink(missing_ok=True)
