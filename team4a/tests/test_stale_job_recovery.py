"""Stage 2 Part C -- regression tests for stuck-job (worker-crash) recovery
(app/api/routes.py's `_recover_if_stale`, wired into GET /jobs/{job_id} and
GET /jobs).

ROOT CAUSE (traced through app/tasks.py, not assumed): a legacy job's
`updated_at` is touched at task start and at each of the 4 pipeline stage
boundaries. If the worker crashes mid-task, no further touch ever happens,
leaving the job at status=PROCESSING with a frozen `updated_at` forever
unless some worker later comes back online for Celery's own redelivery to
matter. This suite proves the fix: a PROCESSING job with no touch for
longer than `settings.stale_processing_threshold_seconds` is recovered to
FAILED (with a clear, distinguishing error) the next time it is read,
while a PROCESSING job well within that window (genuinely slow-but-active)
is left completely untouched.

Uses the same `client`/`job_store` fixtures already established in
tests/test_api_routes.py.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.api.routes import get_ingestion_lock
from app.models.schemas import IngestionJob, JobStatus, SourceType
from app.pipeline.ingestion_lock import IngestionLock
from tests.test_api_routes import client, job_store  # noqa: F401 (fixtures, reused not duplicated)

# Matches Settings.stale_processing_threshold_seconds' own default (4 hours) --
# see app/config/settings.py for why that default was chosen.
_DEFAULT_THRESHOLD_SECONDS = 14400


def _processing_job(*, age_seconds: float) -> IngestionJob:
    job = IngestionJob(source_type=SourceType.PDF, status=JobStatus.PROCESSING, progress=25)
    job.updated_at = datetime.now(timezone.utc) - timedelta(seconds=age_seconds)
    return job


class TestStaleJobIsRecoveredOnRead:
    def test_a_processing_job_stuck_past_the_threshold_is_recovered_to_failed_via_get_job(self, client, job_store):
        job = _processing_job(age_seconds=_DEFAULT_THRESHOLD_SECONDS + 60)
        job_store.create(job)

        response = client.get(f"/jobs/{job.job_id}")

        assert response.status_code == 200
        body = response.json()
        assert body["status"] == "failed"
        assert body["error_details"]["error_type"] == "WorkerStalled"
        assert "retry" in body["error_details"]["message"].lower()

    def test_the_recovered_status_is_persisted_not_just_returned_once(self, client, job_store):
        job = _processing_job(age_seconds=_DEFAULT_THRESHOLD_SECONDS + 60)
        job_store.create(job)

        client.get(f"/jobs/{job.job_id}")
        persisted = job_store.get(job.job_id)

        assert persisted.status == JobStatus.FAILED
        assert persisted.error_details is not None

    def test_a_stale_processing_job_is_also_recovered_when_seen_via_list_jobs(self, client, job_store):
        job = _processing_job(age_seconds=_DEFAULT_THRESHOLD_SECONDS + 60)
        job_store.create(job)

        response = client.get("/jobs")

        assert response.status_code == 200
        listed = response.json()["jobs"][0]
        assert listed["status"] == "failed"
        assert job_store.get(job.job_id).status == JobStatus.FAILED


class TestSlowButActiveJobsAreLeftAlone:
    def test_a_processing_job_well_within_the_threshold_is_returned_unchanged(self, client, job_store):
        job = _processing_job(age_seconds=30)
        job_store.create(job)

        response = client.get(f"/jobs/{job.job_id}")

        assert response.status_code == 200
        assert response.json()["status"] == "processing"
        assert job_store.get(job.job_id).status == JobStatus.PROCESSING

    def test_a_processing_job_exactly_at_the_threshold_boundary_is_not_yet_recovered(self, client, job_store):
        # <= threshold is defined as "not yet stale" (see _recover_if_stale);
        # this proves the boundary itself is inclusive of "still active".
        job = _processing_job(age_seconds=_DEFAULT_THRESHOLD_SECONDS - 1)
        job_store.create(job)

        response = client.get(f"/jobs/{job.job_id}")

        assert response.json()["status"] == "processing"

    @pytest.mark.parametrize("status", [JobStatus.QUEUED, JobStatus.COMPLETED, JobStatus.FAILED])
    def test_non_processing_statuses_are_never_touched_regardless_of_age(self, client, job_store, status):
        from app.models.schemas import ErrorDetail

        error_details = (
            ErrorDetail(error_type="X", status_code="X", message="pre-existing failure")
            if status == JobStatus.FAILED
            else None
        )
        job = IngestionJob(
            source_type=SourceType.PDF,
            status=status,
            progress=0 if status == JobStatus.QUEUED else 100,
            error_details=error_details,
        )
        job.updated_at = datetime.now(timezone.utc) - timedelta(seconds=_DEFAULT_THRESHOLD_SECONDS + 60)
        job_store.create(job)

        response = client.get(f"/jobs/{job.job_id}")

        assert response.json()["status"] == status.value


class TestConcurrentRecoveryIsSerialized:
    def test_a_recovery_already_in_progress_for_this_job_is_not_duplicated(self, client, job_store):
        """Simulates a second, truly-concurrent read racing in while a
        first read already holds the recovery lock for this exact job --
        the second read must not also attempt (or fail on) the FAILED
        transition; it simply returns the job as-is and lets the first
        read's recovery finish."""

        job = _processing_job(age_seconds=_DEFAULT_THRESHOLD_SECONDS + 60)
        job_store.create(job)

        lock: IngestionLock = client.app.dependency_overrides[get_ingestion_lock]()
        held_handle = lock.acquire(document_id=f"legacy:recovery:{job.job_id}", lease_seconds=10)

        response = client.get(f"/jobs/{job.job_id}")

        assert response.status_code == 200
        # The racing read deferred to the lock holder rather than erroring
        # or double-recovering -- the job is left exactly as it was.
        assert response.json()["status"] == "processing"
        assert job_store.get(job.job_id).status == JobStatus.PROCESSING

        lock.release(held_handle)

    def test_after_the_lock_is_released_a_later_read_still_recovers_the_job(self, client, job_store):
        job = _processing_job(age_seconds=_DEFAULT_THRESHOLD_SECONDS + 60)
        job_store.create(job)

        lock: IngestionLock = client.app.dependency_overrides[get_ingestion_lock]()
        handle = lock.acquire(document_id=f"legacy:recovery:{job.job_id}", lease_seconds=10)
        lock.release(handle)

        response = client.get(f"/jobs/{job.job_id}")

        assert response.json()["status"] == "failed"


class TestRecoveryDoesNotOverwriteAJobThatFinishedInTheRace:
    def test_a_job_that_completes_between_the_initial_check_and_the_lock_is_not_overwritten(self, client, job_store):
        """If the job legitimately reaches a terminal status in the narrow
        window between _recover_if_stale's first (unlocked) staleness
        check and it actually acquiring the recovery lock, the re-check
        performed *after* acquiring the lock must see that and skip the
        FAILED transition entirely."""

        job = _processing_job(age_seconds=_DEFAULT_THRESHOLD_SECONDS + 60)
        job_store.create(job)

        lock: IngestionLock = client.app.dependency_overrides[get_ingestion_lock]()
        real_acquire = lock.acquire

        def _acquire_then_complete_the_job(*args, **kwargs):
            # Simulate a worker finishing the job in the exact instant
            # before the recovery path itself acquires the lock.
            completed = job_store.get(job.job_id)
            completed.status = JobStatus.COMPLETED
            completed.progress = 100
            completed.chunk_count = 3
            completed.updated_at = datetime.now(timezone.utc)
            job_store.update(completed)
            return real_acquire(*args, **kwargs)

        lock.acquire = _acquire_then_complete_the_job
        try:
            response = client.get(f"/jobs/{job.job_id}")
        finally:
            lock.acquire = real_acquire

        assert response.json()["status"] == "completed"
        assert response.json()["chunk_count"] == 3
