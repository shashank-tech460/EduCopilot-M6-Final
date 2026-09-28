"""Team 4A FastAPI routes and file-handling boundary (Task 10.1).

Implements Requirement 9.1-9.7:
    9.1 POST /ingest/pdf accepts multipart PDF uploads, returns a job id.
    9.2 POST /ingest/video accepts multipart MP4 uploads, returns a job id.
    9.3 POST /ingest/youtube accepts a JSON YouTube URL, returns a job id.
    9.4 GET /jobs/{job_id} returns status, progress, and metadata.
    9.5 GET /jobs returns a paginated list of jobs.
    9.6 Missing/invalid fields or unsupported file types -> HTTP 422 with a
        descriptive message.
    9.7 Uploaded files must match their declared content type before
        processing is initiated.

ARCHITECTURE BOUNDARY (read before modifying):
This module implements the API boundary -- request validation, file
saving, job-record bookkeeping, and dispatching each job to the real
Celery task that does the actual work. It deliberately does NOT:
    - call PDFProcessor / VideoProcessor / YouTubeProcessor directly
    - call Chunker / Embedder / MetadataEnricher / Publisher directly
    - advance job status past "queued" itself (the Celery task does
      that, in the separate worker process)
Every route creates an IngestionJob with status=queued, dispatches the
matching Celery task (`process_pdf`/`process_video`/`process_youtube`,
imported from app.tasks -- the same singleton task objects a real
worker has registered on the same `celery_app` instance, see
app/celery_app.py), and returns it.

TASK 10.2 INTEGRATION FIX (this was a real, previously-undiscovered gap,
found via a real Docker Compose diagnosis, not a hypothetical): Task
10.1 deliberately left this dispatch call unimplemented (marked with
`# TASK 10.2:` comments), and Task 10.2 itself implemented the Celery
task functions and fixed their *registration* on the worker, but never
actually wired these API routes to call them. The result: every upload
was accepted (HTTP 202, a real job_id, a real "queued" job record) but
never enqueued to Celery at all -- confirmed in a real environment via
`LLEN team4a_ingestion` / `LLEN celery` / `LLEN default` all reading 0
after a real POST. This was invisible to every prior automated test in
this project because orchestration tests call `_run_pdf_pipeline` etc.
directly (bypassing the HTTP boundary) and API tests never asserted a
Celery dispatch actually happened. This gap is now closed.

Job state (`JobStore`) and file storage (`FileStorage`) are both injected
via FastAPI dependencies -- see app/api/job_store.py and
app/api/file_storage.py.

SECURITY HARDENING STAGE 1: every route in this module now requires the
same internal-service JWT as the canonical `/v1/ingest` route
(`app.api.auth_dependency.require_ingest_identity`) -- previously,
`/ingest/pdf`, `/ingest/video`, `/ingest/youtube`, `/jobs/{job_id}`, and
`/jobs` accepted requests from anyone who could reach this service's
port, with no credential at all. Confirmed via `services/teamA/client.ts`
that Team 4C's real product traffic exclusively calls `/v1/ingest`
(canonical) and never any route in this file -- so gating these routes
does not change any real caller's behavior, only closes what was an
open, unauthenticated attack surface (arbitrary file-processing jobs,
enumerable job listings) that the live product never actually used.
KNOWN LIMITATION, not fixed by this change: `IngestionJob` (app/models/
schemas.py) carries no workspace_id/user_id field at all -- this legacy
pipeline predates the canonical contract's multi-tenant model. This
change authenticates WHO may call these routes (any holder of a valid
internal-service JWT), but cannot enforce "only the workspace that
created a job may read it," since that identity was never recorded on
the job in the first place. A real per-resource authorization fix would
require adding tenant fields to `IngestionJob` and the job store -- a
larger, out-of-scope data-model change for this security-hardening pass.
"""

from __future__ import annotations

import hashlib
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile, status

from app.api.auth_dependency import require_ingest_identity
from app.api.file_storage import FileStorage
from app.api.job_store import JobStore, RedisJobStore
from app.config.settings import Settings, get_settings
from app.models.exceptions import UploadTooLargeError
from app.models.schemas import ErrorDetail, IngestionJob, JobListResponse, JobResponse, JobStatus, SourceType, YouTubeRequest
from app.pipeline.ingestion_lock import DocumentAlreadyLockedError, IngestionLock
from app.security.service_jwt import ServiceIdentity
from app.tasks import _cleanup_upload, _mark_failed, process_pdf, process_video, process_youtube

logger = logging.getLogger(__name__)

router = APIRouter()

_PDF_CONTENT_TYPE = "application/pdf"
_VIDEO_CONTENT_TYPE = "video/mp4"
_BYTES_PER_MB = 1024 * 1024
_BYTES_PER_GB = 1024**3

# Task 10.2 integration fix (see app/api/job_store.py's module docstring):
# a Celery worker runs in a separate process from this API, so an
# in-memory store here would be invisible to it. RedisJobStore is
# constructed lazily (redis-py does not connect until the first command is
# issued), so importing this module never requires a live Redis server --
# exactly like every other lazy client in this project (Whisper,
# sentence-transformers, qdrant-client). Tests override this dependency
# with a fresh InMemoryJobStore for isolation (see tests/test_api_routes.py).
_default_job_store = RedisJobStore()


def get_job_store() -> JobStore:
    return _default_job_store


def get_file_storage(settings: Settings = Depends(get_settings)) -> FileStorage:
    return FileStorage(settings=settings)


# -- Stage 2 Part B: legacy-route content-hash deduplication ---------------
#
# ROOT CAUSE (confirmed by direct inspection, not assumed): unlike the
# canonical /v1/ingest path (IngestionLock, keyed by a caller-supplied
# document_id), these legacy routes create a brand-new IngestionJob with a
# fresh, random job_id on EVERY call, with no deduplication at all. Chunk
# identity here is a deterministic uuid5 of job_id (see app/pipeline/
# metadata.py), so two calls that upload the SAME bytes under two DIFFERENT
# job_ids always publish two fully disjoint sets of Qdrant points --
# genuine duplication, not merely wasted work, confirmed live by uploading
# the same fixture PDF twice and observing double the chunk count for one
# document. These routes have no caller-supplied document identity to key
# a lock on (unlike canonical) -- the content itself (its bytes, or its
# URL for YouTube) is the only available identity, so that is what is
# hashed and locked on here, reusing the EXISTING canonical IngestionLock
# primitive (a generic, already-tested Redis mutual-exclusion lock over
# any string key) rather than introducing a new locking mechanism.
_default_ingestion_lock: IngestionLock | None = None


def get_ingestion_lock(settings: Settings = Depends(get_settings)) -> IngestionLock:
    global _default_ingestion_lock
    if _default_ingestion_lock is None:
        import redis

        _default_ingestion_lock = IngestionLock(
            redis.Redis.from_url(settings.redis_result_backend_url, decode_responses=True)
        )
    return _default_ingestion_lock


def _content_hash(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _claim_legacy_content_or_409(
    lock: IngestionLock, source_type: str, content_hash: str, lease_seconds: int
) -> None:
    """Acquires the dedup lock for this exact content, or raises HTTP 409
    if an identical submission is already claimed (in flight, or
    completed within the lease window). `source_type` namespaces the hash
    so a PDF and a video that happened to hash identically (astronomically
    unlikely, but not worth relying on) can never collide with each other.
    """

    try:
        lock.acquire(document_id=f"legacy:{source_type}:{content_hash}", lease_seconds=lease_seconds)
    except DocumentAlreadyLockedError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="An identical upload is already being processed. Please wait for it to finish before retrying.",
        ) from exc


def _reject_wrong_content_type(declared_content_type: str | None, expected: str, kind: str) -> None:
    """Raise HTTP 422 unless `declared_content_type` matches `expected` exactly.

    Deliberately strict (Requirement 9.7 / Task 10.1 section 10): does not
    accept a wildcard (e.g. "video/*"), does not accept
    "application/octet-stream" as a substitute, and does not infer type
    from the filename extension -- only the client-declared Content-Type
    header is checked, which is the specific, minimal interpretation Task
    10.1 asks for (see the Task 10.1 report for the "declared type" vs.
    "byte-sniffed type" scoping decision).
    """

    if declared_content_type != expected:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=(
                f"Invalid {kind} content type: expected '{expected}', "
                f"got {declared_content_type!r}."
            ),
        )


def _parse_content_length(raw_header_value: str | None) -> int | None:
    """Parse the `Content-Length` header into a non-negative int, or None.

    Production Hardening Task 2: Content-Length can be missing or
    malformed -- both are treated the same as "no early size hint
    available" (the caller falls back entirely on the authoritative
    streaming byte-count check in `FileStorage.save`), never as an error
    in their own right and never trusted as authoritative even when
    present and well-formed.
    """

    if raw_header_value is None:
        return None
    try:
        parsed = int(raw_header_value)
    except ValueError:
        return None
    return parsed if parsed >= 0 else None


@router.post("/ingest/pdf", response_model=JobResponse, status_code=status.HTTP_202_ACCEPTED)
def ingest_pdf(
    request: Request,
    file: UploadFile = File(...),
    job_store: JobStore = Depends(get_job_store),
    file_storage: FileStorage = Depends(get_file_storage),
    settings: Settings = Depends(get_settings),
    ingestion_lock: IngestionLock = Depends(get_ingestion_lock),
    _identity: ServiceIdentity = Depends(require_ingest_identity),
) -> JobResponse:
    """Accept a PDF upload, save it, and dispatch it to the Celery worker.

    Does not extract or process the PDF itself in this process -- this
    route only saves the file and enqueues `process_pdf` (app.tasks),
    which runs PDFProcessor and the rest of the pipeline in the separate
    worker process using the saved file path.

    Production Hardening Task 2: the configured `pdf_max_size_mb` limit is
    enforced here, at upload time, as defense in depth alongside
    PDFProcessor's own existing (unchanged) check against the file once
    it's on disk. An oversized upload is rejected with 422 -- the same
    convention already used for every other upload-validation failure on
    this endpoint -- before its complete body is ever written to disk,
    and no IngestionJob is created for it.
    """

    _reject_wrong_content_type(file.content_type, _PDF_CONTENT_TYPE, "PDF")

    max_bytes = settings.pdf_max_size_mb * _BYTES_PER_MB
    declared_content_length = _parse_content_length(request.headers.get("content-length"))

    job = IngestionJob(source_type=SourceType.PDF)
    try:
        saved_path = file_storage.save(
            file.file,
            job_id=job.job_id,
            extension=".pdf",
            max_bytes=max_bytes,
            declared_content_length=declared_content_length,
        )
    except UploadTooLargeError as exc:
        logger.warning(
            "Upload rejected: exceeds size limit",
            extra={"source_type": "pdf", "reason": "too_large"},
        )
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=exc.message) from exc

    # Stage 2 Part B: content-hash dedup, computed from the just-saved
    # file (streamed off disk, never loaded whole into memory) -- see
    # `_claim_legacy_content_or_409`'s own module-level comment for the
    # full root-cause/rationale. No job is created (and the just-saved
    # file is removed) for a rejected duplicate, matching this route's
    # existing convention that a rejected request never leaves behind a
    # job record.
    hasher = hashlib.sha256()
    with open(saved_path, "rb") as saved_file:
        for chunk in iter(lambda: saved_file.read(1024 * 1024), b""):
            hasher.update(chunk)
    try:
        _claim_legacy_content_or_409(
            ingestion_lock, "pdf", hasher.hexdigest(), settings.legacy_ingest_dedup_lease_seconds
        )
    except HTTPException:
        logger.warning(
            "Upload rejected: identical content already being processed",
            extra={"source_type": "pdf", "reason": "duplicate_content"},
        )
        _cleanup_upload(job.job_id, saved_path, settings.upload_directory)
        raise

    job_store.create(job)
    logger.info("Upload accepted", extra={"job_id": job.job_id, "source_type": "pdf"})

    # TASK 10.2 INTEGRATION FIX: dispatch the real Celery task. The job
    # was already created (status=queued) above, using the SAME job_id
    # now passed to the task -- this ordering is required (a job record
    # must exist before a worker could ever look it up) and matches the
    # dispatch contract exactly:
    #   process_pdf.delay(job_id=job.job_id, file_path=saved_path)
    # `process_pdf` is the real, singleton task object imported from
    # app.tasks -- the SAME object a Celery worker started via
    # `celery -A app.celery_app worker` has registered on the SAME
    # `celery_app` instance (verified directly: `routes.process_pdf is
    # tasks.process_pdf` and `.app is celery_app`, both True). No second
    # Celery application or task implementation is created here.
    try:
        process_pdf.delay(job_id=job.job_id, file_path=saved_path)
    except Exception as exc:  # noqa: BLE001
        # DISPATCH FAILURE HANDLING: if the broker is unreachable (or any
        # other error occurs) at the moment of enqueueing, the job record
        # already exists but will never be picked up by any worker --
        # exactly the "job that can never run" this task explicitly warns
        # against silently returning. Reusing the existing, approved
        # `_mark_failed` helper (app/tasks.py) marks the job FAILED with
        # a real ErrorDetail -- the same terminal-failure representation
        # already used for every other failure mode in this project, so
        # `GET /jobs/{job_id}` accurately reflects that this job will not
        # be processed, rather than showing "queued" forever. The saved
        # upload is cleaned up via the existing `_cleanup_upload` helper
        # (Production Hardening Task 3's terminal-failure convention),
        # since this job will never reach any later stage that would
        # otherwise do so. The response itself is a 503 (not the normal
        # 202) -- consistent with this project's existing convention of
        # using 503 for "a required downstream dependency is unavailable"
        # (see app/api/health.py's GET /readyz) -- so the client is never
        # told "accepted for processing" when that is not true.
        logger.error(
            "Failed to enqueue Celery task for job %s: %s",
            job.job_id,
            exc,
            extra={"job_id": job.job_id, "source_type": "pdf"},
            exc_info=True,
        )
        _mark_failed(job, job_store, exc)
        _cleanup_upload(job.job_id, saved_path, settings.upload_directory)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Failed to enqueue the ingestion task for processing. Please retry the request.",
        ) from exc

    return JobResponse(job_id=job.job_id, status=job.status)


@router.post("/ingest/video", response_model=JobResponse, status_code=status.HTTP_202_ACCEPTED)
def ingest_video(
    request: Request,
    file: UploadFile = File(...),
    job_store: JobStore = Depends(get_job_store),
    file_storage: FileStorage = Depends(get_file_storage),
    settings: Settings = Depends(get_settings),
    ingestion_lock: IngestionLock = Depends(get_ingestion_lock),
    _identity: ServiceIdentity = Depends(require_ingest_identity),
) -> JobResponse:
    """Accept an MP4 upload, save it, and dispatch it to the Celery worker.

    Does not run VideoProcessor/Whisper/ffmpeg in this process -- this
    route only saves the file and enqueues `process_video` (app.tasks),
    which runs the pipeline in the separate worker process.

    Production Hardening Task 2: the configured `video_max_size_gb` limit
    is enforced here, at upload time, as defense in depth alongside
    VideoProcessor's own existing (unchanged) check against the file once
    it's on disk. See `ingest_pdf` above for the identical rationale.
    """

    _reject_wrong_content_type(file.content_type, _VIDEO_CONTENT_TYPE, "video")

    max_bytes = settings.video_max_size_gb * _BYTES_PER_GB
    declared_content_length = _parse_content_length(request.headers.get("content-length"))

    job = IngestionJob(source_type=SourceType.MP4)
    try:
        saved_path = file_storage.save(
            file.file,
            job_id=job.job_id,
            extension=".mp4",
            max_bytes=max_bytes,
            declared_content_length=declared_content_length,
        )
    except UploadTooLargeError as exc:
        logger.warning(
            "Upload rejected: exceeds size limit",
            extra={"source_type": "mp4", "reason": "too_large"},
        )
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=exc.message) from exc

    # Stage 2 Part B: see ingest_pdf above for the full rationale --
    # identical mechanism, applied to the video upload.
    hasher = hashlib.sha256()
    with open(saved_path, "rb") as saved_file:
        for chunk in iter(lambda: saved_file.read(1024 * 1024), b""):
            hasher.update(chunk)
    try:
        _claim_legacy_content_or_409(
            ingestion_lock, "video", hasher.hexdigest(), settings.legacy_ingest_dedup_lease_seconds
        )
    except HTTPException:
        logger.warning(
            "Upload rejected: identical content already being processed",
            extra={"source_type": "mp4", "reason": "duplicate_content"},
        )
        _cleanup_upload(job.job_id, saved_path, settings.upload_directory)
        raise

    job_store.create(job)
    logger.info("Upload accepted", extra={"job_id": job.job_id, "source_type": "mp4"})

    # TASK 10.2 INTEGRATION FIX: see ingest_pdf above for the full
    # rationale (identical pattern, applied to the video task).
    try:
        process_video.delay(job_id=job.job_id, file_path=saved_path)
    except Exception as exc:  # noqa: BLE001
        logger.error(
            "Failed to enqueue Celery task for job %s: %s",
            job.job_id,
            exc,
            extra={"job_id": job.job_id, "source_type": "mp4"},
            exc_info=True,
        )
        _mark_failed(job, job_store, exc)
        _cleanup_upload(job.job_id, saved_path, settings.upload_directory)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Failed to enqueue the ingestion task for processing. Please retry the request.",
        ) from exc

    return JobResponse(job_id=job.job_id, status=job.status)


@router.post("/ingest/youtube", response_model=JobResponse, status_code=status.HTTP_202_ACCEPTED)
def ingest_youtube(
    request: YouTubeRequest,
    job_store: JobStore = Depends(get_job_store),
    settings: Settings = Depends(get_settings),
    ingestion_lock: IngestionLock = Depends(get_ingestion_lock),
    _identity: ServiceIdentity = Depends(require_ingest_identity),
) -> JobResponse:
    """Accept a YouTube URL request and dispatch it to the Celery worker.

    `request.url` is validated as a real HTTP/HTTPS URL by Pydantic's
    `HttpUrl` (via the existing `YouTubeRequest` model) before this
    handler body ever runs -- an invalid or missing URL never reaches
    here; FastAPI returns HTTP 422 automatically. This route does not
    call YouTubeProcessor or make any network request itself -- it only
    enqueues `process_youtube` (app.tasks), which does so in the
    separate worker process.
    """

    # Stage 2 Part B: see ingest_pdf's own module-level comment for the
    # full rationale -- here the URL string itself (normalized via
    # Pydantic's own HttpUrl parsing, so trivial formatting differences
    # like a trailing slash don't evade dedup) is the "content" to hash,
    # since there are no file bytes to read.
    url_hash = _content_hash(str(request.url).encode("utf-8"))
    _claim_legacy_content_or_409(ingestion_lock, "youtube", url_hash, settings.legacy_ingest_dedup_lease_seconds)

    job = IngestionJob(source_type=SourceType.YOUTUBE)
    job_store.create(job)

    # TASK 10.2 INTEGRATION FIX: see ingest_pdf above for the full
    # rationale. YouTube ingestion saves no local file (confirmed:
    # _run_youtube_pipeline takes a `url`, never a `file_path`), so a
    # dispatch failure here has nothing to clean up -- `_cleanup_upload`
    # is correctly not called, matching app/tasks.py's own established
    # "nothing to clean up, by construction, not a special case" pattern
    # for this source type.
    try:
        process_youtube.delay(
            job_id=job.job_id,
            url=str(request.url),
            language=request.language,
        )
    except Exception as exc:  # noqa: BLE001
        logger.error(
            "Failed to enqueue Celery task for job %s: %s",
            job.job_id,
            exc,
            extra={"job_id": job.job_id, "source_type": "youtube"},
            exc_info=True,
        )
        _mark_failed(job, job_store, exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Failed to enqueue the ingestion task for processing. Please retry the request.",
        ) from exc

    return JobResponse(job_id=job.job_id, status=job.status)


# -- Stage 2 Part C: stuck-job (worker-crash) recovery ----------------------
#
# ROOT CAUSE (traced directly through app/tasks.py, not assumed): a legacy
# job's `updated_at` is touched at task start (-> PROCESSING) and at each of
# the 4 pipeline stage boundaries. If the worker process crashes mid-task
# (killed, OOM, or any fatal error outside the `except Exception` blocks
# that already turn ordinary failures into a clean FAILED status), no
# further touch ever happens -- the job is left at status=PROCESSING with a
# frozen `updated_at`, forever, unless SOME worker later comes back online
# to let Celery's own `task_acks_late`/`visibility_timeout` redelivery
# mechanism run (that mechanism is untouched by this fix and continues to
# work exactly as configured; this only adds a safety net for the case
# where no worker ever comes back). See Settings.stale_processing_
# threshold_seconds for why 4 hours (matching the canonical path's own
# "abandoned lock" definition) is used rather than a smaller number.
#
# Recovery is applied lazily, at the existing read paths (GET /jobs/{id}
# and GET /jobs) -- no new always-running component (no Celery Beat
# schedule, no background thread/process) is introduced, and no existing
# component's behavior changes for any job that is not both PROCESSING and
# stale. The recovery mutation itself is serialized with the EXISTING
# `IngestionLock` Redis primitive (a short-lived, separate lock namespace
# from Part B's own dedup locks) so that two concurrent reads of the same
# stale job can never both attempt the FAILED transition, and the job is
# re-fetched and re-checked *after* acquiring that lock so a job that
# genuinely completes in the narrow window between the first check and the
# lock acquisition is never incorrectly overwritten.
#
# "Retries don't duplicate chunks" after this recovery holds for the same
# reason Part B's own reproduction-test docstring already establishes:
# Publisher chunk identity is a deterministic uuid5 of `job_id`
# (app/pipeline/metadata.py) and Qdrant publication is an upsert, so even
# in the rare race where a stale job is recovered to FAILED *and* the
# original crashed attempt's task message is later redelivered by Celery,
# both paths converge on the same chunk IDs rather than creating disjoint
# duplicates.


def _recover_if_stale(job: IngestionJob, job_store: JobStore, lock: IngestionLock, threshold_seconds: int) -> IngestionJob:
    """If `job` is PROCESSING and has not been touched for longer than
    `threshold_seconds`, recover it to FAILED. Otherwise return it
    unchanged. See the module comment above for the full rationale.
    """

    if job.status != JobStatus.PROCESSING:
        return job

    age_seconds = (datetime.now(timezone.utc) - job.updated_at).total_seconds()
    if age_seconds <= threshold_seconds:
        return job

    try:
        handle = lock.acquire(document_id=f"legacy:recovery:{job.job_id}", lease_seconds=10)
    except DocumentAlreadyLockedError:
        # Another concurrent read is already recovering (or about to
        # recover) this exact job -- let it finish rather than racing it.
        return job

    try:
        # Re-fetch and re-check under the lock: the job may have genuinely
        # completed (or already been recovered by a request that raced
        # ahead of this one) between the check above and acquiring the lock.
        fresh_job = job_store.get(job.job_id)
        if fresh_job is None or fresh_job.status != JobStatus.PROCESSING:
            return fresh_job if fresh_job is not None else job
        fresh_age_seconds = (datetime.now(timezone.utc) - fresh_job.updated_at).total_seconds()
        if fresh_age_seconds <= threshold_seconds:
            return fresh_job

        fresh_job.status = JobStatus.FAILED
        fresh_job.error_details = ErrorDetail(
            error_type="WorkerStalled",
            status_code="ProcessingStalled",
            message=(
                "This job stopped making progress and did not complete within the "
                "expected processing window, likely because the worker handling it "
                "crashed or was restarted. It is safe to retry the same upload."
            ),
            detail={"stale_for_seconds": int(fresh_age_seconds)},
        )
        fresh_job.updated_at = datetime.now(timezone.utc)
        job_store.update(fresh_job)
        logger.warning(
            "Recovered a stale PROCESSING job to FAILED (no progress for %ds)",
            int(fresh_age_seconds),
            extra={"job_id": fresh_job.job_id, "stage": "recovery", "outcome": "stalled"},
        )
        return fresh_job
    finally:
        lock.release(handle)


@router.get("/jobs/{job_id}", response_model=IngestionJob)
def get_job(
    job_id: str,
    job_store: JobStore = Depends(get_job_store),
    ingestion_lock: IngestionLock = Depends(get_ingestion_lock),
    settings: Settings = Depends(get_settings),
    _identity: ServiceIdentity = Depends(require_ingest_identity),
) -> IngestionJob:
    """Return the current state of one Ingestion_Job.

    Exposes job_id, source_type, status, progress, chunk_count,
    error_details, created_at, updated_at -- exactly IngestionJob's own
    fields (Requirement 9.4), so the model is returned directly rather
    than restated in a parallel response schema.

    Stage 2 Part C: a job stuck at PROCESSING with no progress for longer
    than `stale_processing_threshold_seconds` is recovered to FAILED before
    being returned -- see `_recover_if_stale`'s own module comment.
    """

    job = job_store.get(job_id)
    if job is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Job '{job_id}' not found.")
    return _recover_if_stale(job, job_store, ingestion_lock, settings.stale_processing_threshold_seconds)


@router.get("/jobs", response_model=JobListResponse)
def list_jobs(
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    job_store: JobStore = Depends(get_job_store),
    ingestion_lock: IngestionLock = Depends(get_ingestion_lock),
    settings: Settings = Depends(get_settings),
    _identity: ServiceIdentity = Depends(require_ingest_identity),
) -> JobListResponse:
    """Return a paginated list of Ingestion_Jobs (Requirement 9.5).

    `page`/`page_size` are validated by FastAPI's `Query(..., ge=..., le=...)`
    constraints, which produce HTTP 422 automatically for out-of-range
    values (e.g. page=0, page_size=0, or page_size > 100) before this
    handler body runs.

    Stage 2 Part C: every job on the returned page is passed through the
    same stale-job recovery as GET /jobs/{job_id} (see `_recover_if_stale`)
    -- bounded work, since page_size is capped at 100.
    """

    jobs, total = job_store.list(page=page, page_size=page_size)
    jobs = [
        _recover_if_stale(job, job_store, ingestion_lock, settings.stale_processing_threshold_seconds)
        for job in jobs
    ]
    return JobListResponse(jobs=jobs, page=page, page_size=page_size, total=total)
