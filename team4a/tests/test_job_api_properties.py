"""Task 10.3: Optional property-based tests for Job Management / API.

Covers exactly the five official correctness properties assigned to Task
10.3, using their real names and wording as verified directly against the
official specification document:

    Property 25: Job completion status accuracy (Requirement 7.3)
        "For any Ingestion_Job where all chunks are successfully
         published, the job status SHALL be updated to completed and the
         recorded chunk_count SHALL equal the actual number of chunks
         published."

    Property 26: Job ID uniqueness (Requirement 8.2)
        "For any two ingestion requests submitted to the system, the
         assigned job identifiers SHALL be distinct (no collisions)."

    Property 27: Job progress stage mapping (Requirements 8.3, 8.4)
        "For any Ingestion_Job, the progress percentage SHALL be exactly
         25% after extraction completes, 50% after chunking completes,
         75% after embedding completes, and 100% after publication
         completes."

    Property 28: API validation error handling (Requirements 9.6, 9.7)
        "For any ingestion request missing required fields or containing
         a content type that does not match the endpoint's expected
         type, the API SHALL return HTTP 422 with a non-empty validation
         error message."

    Property 29: Pagination correctness (Requirement 9.5)
        "For any set of N jobs and page parameters (page, page_size), the
         GET /jobs endpoint SHALL return at most page_size results, and
         iterating through all pages SHALL yield exactly N total jobs
         with no duplicates."

PRIOR STATE (confirmed by direct inspection before writing this file):
Task 10.3 had never been implemented as a dedicated property-test file.
`tests/test_api_routes.py` and `tests/test_tasks.py` already exercised
the real API/orchestration paths for these five properties, but only as
fixed, non-generative example tests (no `@given`, single hard-coded
inputs -- e.g. exactly 7 jobs at page_size=3, exactly 2 job-creation
calls, one fixed page-count scenario). This file adds genuine
Hypothesis-based property coverage on top of those, reusing (not
duplicating) the existing fixtures/fakes via direct import:
`tests.test_api_routes.client`/`job_store`/`pdf_upload` and
`tests.test_tasks.FakePDFProcessor`/`FakeEmbedder`/`RecordingPublisher`/
`FakeRedis`.

All properties exercise the REAL production path:
    P25/P27: the real `app.tasks._run_pdf_pipeline` orchestration function
        (real Chunker, real MetadataEnricher; fake processor/embedder/
        publisher/job_store/redis only where a real dependency would
        require network/model access).
    P26/P28/P29: the real FastAPI app (`app.api.routes.router`) through
        `TestClient`, exactly as `test_api_routes.py` does.

No network, Redis, Qdrant, Celery worker, Docker, Whisper, or Hugging
Face access is used anywhere in this file. No production code was
changed to write these tests.
"""

from __future__ import annotations

import string
import uuid

import pytest
from hypothesis import HealthCheck, given, settings as hyp_settings
from hypothesis import strategies as st

from app.api.job_store import InMemoryJobStore
from app.models.schemas import IngestionJob, JobStatus, PDFSegment, PublicationResult, SourceType
from app.tasks import _PipelineDependencies, _run_pdf_pipeline
from tests.test_api_routes import (  # noqa: F401 (fixtures, reused not duplicated)
    _AUDIENCE,
    _ISSUER,
    _KID,
    _PUBLIC_PEM,
    _SCOPE,
    client,
    job_store,
    mint_token,
    pdf_upload,
)
from tests.test_tasks import FakeEmbedder, FakePDFProcessor, FakeRedis, RecordingPublisher, make_settings

# ---------------------------------------------------------------------------
# Property 25: Job completion status accuracy
# ---------------------------------------------------------------------------


@given(page_count=st.integers(min_value=1, max_value=15))
@hyp_settings(max_examples=30, deadline=None, suppress_health_check=[HealthCheck.function_scoped_fixture])
def test_property_25_successful_publication_sets_completed_and_correct_chunk_count(page_count):
    """For any generated number of source pages (varying the eventual
    chunk count), running the real orchestration end-to-end results in a
    persisted job (read back from the job store, not merely the
    Publisher's own return value) with status COMPLETED and chunk_count
    exactly equal to the number of records the Publisher actually
    received.
    """

    job_store_instance = InMemoryJobStore()
    job = IngestionJob(source_type=SourceType.PDF)
    job_store_instance.create(job)

    processor = FakePDFProcessor(
        [PDFSegment(text=f"Distinct content number {i} appears here today.", page_number=i) for i in range(1, page_count + 1)]
    )
    publisher = RecordingPublisher()
    deps = _PipelineDependencies(
        settings=make_settings(), job_store=job_store_instance, embedder=FakeEmbedder(), publisher=publisher
    )

    _run_pdf_pipeline(job.job_id, "/tmp/doc.pdf", deps, processor=processor)

    stored_job = job_store_instance.get(job.job_id)  # read back from the STORE, not the return value alone
    assert stored_job.status == JobStatus.COMPLETED
    assert stored_job.status != JobStatus.PROCESSING

    enriched_chunks, _embeddings = publisher.calls[0]
    assert stored_job.chunk_count == len(enriched_chunks)
    assert stored_job.updated_at >= job.created_at


def test_property_25_zero_chunks_still_completes_with_chunk_count_zero():
    """A job whose source produces no chunks at all (e.g. an empty
    document) is still a valid COMPLETED job with chunk_count == 0 --
    matching the existing, approved audio_absent-style "zero chunks is
    not a failure" contract.
    """

    job_store_instance = InMemoryJobStore()
    job = IngestionJob(source_type=SourceType.PDF)
    job_store_instance.create(job)

    processor = FakePDFProcessor([])  # no segments at all
    publisher = RecordingPublisher()
    deps = _PipelineDependencies(
        settings=make_settings(), job_store=job_store_instance, embedder=FakeEmbedder(), publisher=publisher
    )

    _run_pdf_pipeline(job.job_id, "/tmp/doc.pdf", deps, processor=processor)

    stored_job = job_store_instance.get(job.job_id)
    assert stored_job.status == JobStatus.COMPLETED
    assert stored_job.chunk_count == 0


@given(published_count=st.integers(min_value=0, max_value=4), total_count=st.integers(min_value=1, max_value=5))
@hyp_settings(max_examples=20, deadline=None, suppress_health_check=[HealthCheck.function_scoped_fixture])
def test_property_25_mismatched_published_count_cannot_yield_completed_job(published_count, total_count):
    """A publisher result that did not publish every record (a genuine
    partial/permanent failure) must never leave the job COMPLETED --
    generated across many (published_count, total_count) combinations
    where published_count < total_count.
    """

    if published_count >= total_count:
        published_count = total_count - 1  # force a genuine mismatch for this property
    if total_count < 1:
        return

    from app.models.schemas import ErrorDetail

    job_store_instance = InMemoryJobStore()
    job = IngestionJob(source_type=SourceType.PDF)
    job_store_instance.create(job)

    processor = FakePDFProcessor(
        [PDFSegment(text=f"Content page {i} here today now.", page_number=i) for i in range(1, total_count + 1)]
    )
    failure_result = PublicationResult(
        status=JobStatus.PUBLISH_FAILED,
        published_count=published_count,
        total_count=total_count,
        error_details=ErrorDetail(error_type="X", status_code="PublicationFailed", message="partial failure", detail={}),
    )
    publisher = RecordingPublisher(result=failure_result)
    deps = _PipelineDependencies(
        settings=make_settings(), job_store=job_store_instance, embedder=FakeEmbedder(), publisher=publisher
    )

    _run_pdf_pipeline(job.job_id, "/tmp/doc.pdf", deps, processor=processor)

    stored_job = job_store_instance.get(job.job_id)
    assert stored_job.status != JobStatus.COMPLETED
    assert stored_job.status == JobStatus.PUBLISH_FAILED


# ---------------------------------------------------------------------------
# Property 26: Job ID uniqueness
# ---------------------------------------------------------------------------


@given(num_jobs=st.integers(min_value=1, max_value=20))
@hyp_settings(max_examples=15, deadline=None, suppress_health_check=[HealthCheck.function_scoped_fixture])
def test_property_26_job_ids_are_unique_across_n_real_api_creations(client, num_jobs):
    """For any generated number of real POST /ingest/pdf requests through
    the actual FastAPI route (not the UUID library tested in isolation),
    all resulting job IDs are distinct, non-empty, and valid UUIDs.
    """

    job_ids = []
    for _ in range(num_jobs):
        # Globally-unique content per call, not just per loop index: the
        # `client` fixture (and its one IngestionLock/fakeredis instance)
        # is reused across EVERY Hypothesis example in this test (that is
        # what suppress_health_check=[function_scoped_fixture] signs off
        # on), so index-based content like f"job {i}" would collide with
        # an earlier example's own iteration 0, 1, 2, ... and be spuriously
        # rejected as a Stage 2 Part B content-hash duplicate.
        response = client.post("/ingest/pdf", files=pdf_upload(content=f"%PDF-1.4 {uuid.uuid4()}".encode()))
        assert response.status_code == 202
        job_ids.append(response.json()["job_id"])

    assert len(job_ids) == num_jobs
    assert len(set(job_ids)) == num_jobs  # no collisions
    for job_id in job_ids:
        assert job_id != ""
        uuid.UUID(job_id)  # valid UUID format


@given(num_jobs=st.integers(min_value=1, max_value=10))
@hyp_settings(max_examples=15, deadline=None, suppress_health_check=[HealthCheck.function_scoped_fixture])
def test_property_26_job_ids_unique_across_mixed_endpoint_types(client, num_jobs):
    """Uniqueness must hold across different source types too, not just
    repeated calls to the same endpoint.
    """

    job_ids = []
    for i in range(num_jobs):
        # Globally-unique content/URL per call, not just per loop index --
        # see the sibling test above for why (Stage 2 Part B content-hash
        # dedup against a fixture reused across Hypothesis examples).
        if i % 2 == 0:
            response = client.post("/ingest/pdf", files=pdf_upload(content=f"%PDF-1.4 {uuid.uuid4()}".encode()))
        else:
            response = client.post("/ingest/youtube", json={"url": f"https://www.youtube.com/watch?v={uuid.uuid4().hex[:11]}"})
        job_ids.append(response.json()["job_id"])

    assert len(set(job_ids)) == len(job_ids)


# ---------------------------------------------------------------------------
# Property 27: Job progress stage mapping
# ---------------------------------------------------------------------------


@given(page_count=st.integers(min_value=1, max_value=12))
@hyp_settings(max_examples=30, deadline=None, suppress_health_check=[HealthCheck.function_scoped_fixture])
def test_property_27_progress_sequence_is_exactly_25_50_75_100(page_count):
    """For any generated valid processing scenario (varying source size),
    the observed progress sequence recorded via the real orchestration's
    Redis-mirroring seam is exactly [25, 50, 75, 100], in that order, with
    no missing, duplicated, reordered, or unexpected values.
    """

    job_store_instance = InMemoryJobStore()
    job = IngestionJob(source_type=SourceType.PDF)
    job_store_instance.create(job)
    redis_client = FakeRedis()

    processor = FakePDFProcessor(
        [PDFSegment(text=f"Some content for page {i} here today.", page_number=i) for i in range(1, page_count + 1)]
    )
    deps = _PipelineDependencies(
        settings=make_settings(),
        job_store=job_store_instance,
        embedder=FakeEmbedder(),
        publisher=RecordingPublisher(),
        redis_client=redis_client,
    )

    _run_pdf_pipeline(job.job_id, "/tmp/doc.pdf", deps, processor=processor)

    progress_values = [int(v) for _, v in redis_client.set_calls]
    assert progress_values == [25, 50, 75, 100]


@given(page_count=st.integers(min_value=1, max_value=8))
@hyp_settings(max_examples=20, deadline=None, suppress_health_check=[HealthCheck.function_scoped_fixture])
def test_property_27_publication_failure_never_falsely_reaches_100(page_count):
    """If publication permanently fails, progress must stop at 75 (the
    last genuinely completed stage) and must NEVER report 100, for any
    generated source size.
    """

    from app.models.schemas import ErrorDetail

    job_store_instance = InMemoryJobStore()
    job = IngestionJob(source_type=SourceType.PDF)
    job_store_instance.create(job)
    redis_client = FakeRedis()

    processor = FakePDFProcessor(
        [PDFSegment(text=f"Some content for page {i} here today.", page_number=i) for i in range(1, page_count + 1)]
    )
    failure_result = PublicationResult(
        status=JobStatus.PUBLISH_FAILED,
        published_count=0,
        total_count=page_count,
        error_details=ErrorDetail(error_type="X", status_code="PublicationFailed", message="boom", detail={}),
    )
    deps = _PipelineDependencies(
        settings=make_settings(),
        job_store=job_store_instance,
        embedder=FakeEmbedder(),
        publisher=RecordingPublisher(result=failure_result),
        redis_client=redis_client,
    )

    _run_pdf_pipeline(job.job_id, "/tmp/doc.pdf", deps, processor=processor)

    progress_values = [int(v) for _, v in redis_client.set_calls]
    assert progress_values == [25, 50, 75]
    assert 100 not in progress_values
    assert job_store_instance.get(job.job_id).progress != 100


# ---------------------------------------------------------------------------
# Property 28: API validation error handling
# ---------------------------------------------------------------------------


_wrong_pdf_content_type = st.text(alphabet=string.ascii_lowercase + "/-", min_size=3, max_size=25).filter(
    lambda s: s != "application/pdf" and "/" in s and not s.startswith("/") and not s.endswith("/")
)


@given(wrong_content_type=_wrong_pdf_content_type)
@hyp_settings(max_examples=30, deadline=None, suppress_health_check=[HealthCheck.function_scoped_fixture])
def test_property_28_pdf_any_wrong_content_type_returns_422(client, job_store, wrong_content_type):
    """For any generated content-type string that isn't exactly
    'application/pdf', the PDF endpoint returns 422 with a non-empty
    message, and no job is created.
    """

    response = client.post("/ingest/pdf", files={"file": ("test.pdf", b"content", wrong_content_type)})

    assert response.status_code == 422
    assert response.json()["detail"]
    assert job_store.list(page=1, page_size=1)[1] == 0  # no job created


_wrong_video_content_type = st.text(alphabet=string.ascii_lowercase + "/-", min_size=3, max_size=25).filter(
    lambda s: s != "video/mp4" and "/" in s and not s.startswith("/") and not s.endswith("/")
)


@given(wrong_content_type=_wrong_video_content_type)
@hyp_settings(max_examples=30, deadline=None, suppress_health_check=[HealthCheck.function_scoped_fixture])
def test_property_28_video_any_wrong_content_type_returns_422(client, job_store, wrong_content_type):
    response = client.post("/ingest/video", files={"file": ("test.mp4", b"content", wrong_content_type)})

    assert response.status_code == 422
    assert response.json()["detail"]
    assert job_store.list(page=1, page_size=1)[1] == 0


@given(
    malformed_url=st.text(alphabet=string.ascii_letters + string.digits + " .:,", min_size=1, max_size=40).filter(
        lambda s: not s.strip().lower().startswith(("http://", "https://"))
    )
)
@hyp_settings(max_examples=30, deadline=None, suppress_health_check=[HealthCheck.function_scoped_fixture])
def test_property_28_youtube_any_malformed_url_returns_422(client, job_store, malformed_url):
    """For any generated string that isn't a well-formed http(s) URL, the
    YouTube endpoint returns 422 and creates no job.
    """

    response = client.post("/ingest/youtube", json={"url": malformed_url})

    assert response.status_code == 422
    assert response.json()["detail"]
    assert job_store.list(page=1, page_size=1)[1] == 0


def test_property_28_pdf_missing_upload_returns_422_no_job(client, job_store):
    response = client.post("/ingest/pdf")
    assert response.status_code == 422
    assert job_store.list(page=1, page_size=1)[1] == 0


def test_property_28_video_missing_upload_returns_422_no_job(client, job_store):
    response = client.post("/ingest/video")
    assert response.status_code == 422
    assert job_store.list(page=1, page_size=1)[1] == 0


def test_property_28_youtube_missing_url_returns_422_no_job(client, job_store):
    response = client.post("/ingest/youtube", json={})
    assert response.status_code == 422
    assert job_store.list(page=1, page_size=1)[1] == 0


# ---------------------------------------------------------------------------
# Property 29: Pagination correctness
# ---------------------------------------------------------------------------


@given(total=st.integers(min_value=0, max_value=30), page_size=st.integers(min_value=1, max_value=15))
@hyp_settings(max_examples=25, deadline=None, suppress_health_check=[HealthCheck.function_scoped_fixture])
def test_property_29_pagination_reconstructs_full_dataset_no_duplicates_no_omissions(tmp_path, total, page_size):
    """For any generated dataset size and page_size, every page returns at
    most page_size jobs, and iterating all pages yields exactly the N
    created jobs with no duplicates and no omissions -- generalizing the
    single fixed (7 jobs, page_size=3) example already in test_api_routes.py.

    Builds a fully isolated FastAPI app + InMemoryJobStore *inside the
    test body* for each Hypothesis example, rather than using the shared
    `client`/`job_store` pytest fixtures (which are constructed once per
    test *function* invocation and then reused across every Hypothesis
    example within it). An earlier version of this test used the shared
    fixture and failed with hundreds of leftover jobs from prior examples
    still present in the store -- exactly the state-leakage
    `HealthCheck.function_scoped_fixture` warns about; suppressing that
    health check does not itself guarantee correctness, only that
    Hypothesis won't refuse to run the test. Per-example isolation must
    still be arranged explicitly, as done here.
    """

    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.api.auth_dependency import get_service_jwt_verifier
    from app.api.file_storage import FileStorage
    from app.api.routes import get_file_storage, get_job_store, router
    from app.config.settings import Settings
    from app.security.service_jwt import ServiceJWTVerifier

    app = FastAPI()
    app.include_router(router)
    isolated_job_store = InMemoryJobStore()
    isolated_settings = Settings(upload_directory=str(tmp_path / f"uploads-{total}-{page_size}"), _env_file=None)
    app.dependency_overrides[get_job_store] = lambda: isolated_job_store
    app.dependency_overrides[get_file_storage] = lambda: FileStorage(settings=isolated_settings)
    # Security Hardening Stage 1: this route now requires an internal
    # service JWT -- see test_api_routes.py's own client fixture for the
    # full rationale; this isolated app/client needs the same override
    # since it deliberately does not reuse that shared fixture.
    app.dependency_overrides[get_service_jwt_verifier] = lambda: ServiceJWTVerifier(
        public_keys_by_kid={_KID: _PUBLIC_PEM},
        expected_issuer=_ISSUER,
        expected_audience=_AUDIENCE,
        required_scope=_SCOPE,
    )
    # Stage 2 Part B: isolated per-example fakeredis instance -- see
    # test_api_routes.py's own client fixture for the full rationale;
    # without this, EVERY Hypothesis example in this one test would share
    # the same real Redis dedup state (all using the identical default
    # `pdf_upload()` bytes), and every example after the first would be
    # spuriously rejected as a duplicate of the one before it.
    import fakeredis

    from app.api.routes import get_ingestion_lock
    from app.pipeline.ingestion_lock import IngestionLock

    ingestion_lock = IngestionLock(fakeredis.FakeRedis(decode_responses=True))
    app.dependency_overrides[get_ingestion_lock] = lambda: ingestion_lock
    local_client = TestClient(app, headers={"Authorization": f"Bearer {mint_token()}"})

    created_ids = []
    for i in range(total):
        # Each upload must have genuinely distinct content: this test's
        # own purpose is pagination over `total` real, distinct jobs, and
        # Stage 2 Part B's content-hash dedup would otherwise correctly
        # reject the 2nd..nth upload as a duplicate of the 1st (they were
        # previously all identical bytes, which only "worked" because of
        # a since-fixed bug that gave every request a fresh, empty lock).
        response = local_client.post("/ingest/pdf", files=pdf_upload(content=f"%PDF-1.4 job number {i}".encode()))
        created_ids.append(response.json()["job_id"])

    seen_ids: list[str] = []
    page = 1
    while True:
        response = local_client.get(f"/jobs?page={page}&page_size={page_size}")
        assert response.status_code == 200
        body = response.json()
        assert len(body["jobs"]) <= page_size
        page_ids = [j["job_id"] for j in body["jobs"]]
        assert len(page_ids) == len(set(page_ids))  # no duplicates within a page
        seen_ids.extend(page_ids)
        if page * page_size >= body["total"] or not body["jobs"]:
            break
        page += 1

    assert sorted(seen_ids) == sorted(created_ids)
    assert len(seen_ids) == len(set(seen_ids))  # no duplicates across pages
    assert len(seen_ids) == total  # no omissions


@given(total=st.integers(min_value=0, max_value=5))
@hyp_settings(max_examples=10, deadline=None, suppress_health_check=[HealthCheck.function_scoped_fixture])
def test_property_29_page_beyond_final_page_returns_empty_not_error(client, total):
    for _ in range(total):
        client.post("/ingest/pdf", files=pdf_upload())

    response = client.get(f"/jobs?page=9999&page_size=10")
    assert response.status_code == 200
    assert response.json()["jobs"] == []


@given(invalid_page=st.integers(max_value=0))
@hyp_settings(max_examples=15, deadline=None, suppress_health_check=[HealthCheck.function_scoped_fixture])
def test_property_29_any_non_positive_page_returns_422(client, invalid_page):
    response = client.get(f"/jobs?page={invalid_page}")
    assert response.status_code == 422


@given(
    invalid_page_size=st.one_of(
        st.integers(max_value=0),
        st.integers(min_value=101, max_value=100_000),
    )
)
@hyp_settings(max_examples=20, deadline=None, suppress_health_check=[HealthCheck.function_scoped_fixture])
def test_property_29_any_out_of_range_page_size_returns_422(client, invalid_page_size):
    response = client.get(f"/jobs?page_size={invalid_page_size}")
    assert response.status_code == 422


def test_property_29_valid_boundary_page_sizes_are_accepted(client):
    for _ in range(3):
        client.post("/ingest/pdf", files=pdf_upload())

    for page_size in (1, 100):
        response = client.get(f"/jobs?page=1&page_size={page_size}")
        assert response.status_code == 200
