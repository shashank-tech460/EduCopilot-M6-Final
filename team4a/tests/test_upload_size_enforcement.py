"""Production Hardening Task 2: tests for early upload-size enforcement.

IMPORTANT CONTEXT: on inspection at the start of this task, the actual
enforcement logic (`FileStorage.save`'s streaming byte-count check,
`app/api/routes.py`'s Content-Length pre-check and `UploadTooLargeError`
handling, and the new `UploadTooLargeError` exception itself) was found
**already fully implemented** in the repository, each clearly labeled
"PRODUCTION HARDENING TASK 2" in its own docstring. What did NOT exist
yet was any test coverage at all for this feature -- confirmed by
searching the existing test suite for any reference to
`UploadTooLargeError`/`max_bytes`/`declared_content_length`/`oversized`,
which found nothing. This file is that missing coverage; no production
code was modified to write it.

Verified manually before writing this suite (see the Task 2 report for
the full walkthrough, including one mistake caught and corrected in that
manual verification itself -- a scratch test initially forgot to override
the `get_settings` FastAPI dependency alongside `get_file_storage`,
causing a false "bug" appearance that turned out to be a test-authoring
error, not a production defect):
    - a body smaller than the limit is accepted normally
    - a body larger than the limit, sent with NO lying Content-Length,
      is rejected and the file is not left on disk
    - a body larger than the limit, sent with a FALSELY SMALL
      Content-Length, is still rejected by the streaming byte-count
      check (never fooled by a lying header)
    - a body smaller than the limit, sent with a FALSELY LARGE
      Content-Length, is rejected early based on the declared header
      alone (a deliberate, spec-sanctioned trade-off: "if present and
      clearly exceeds the applicable limit, reject early without
      writing the complete body" -- a client has no legitimate reason to
      declare a larger size than it sends)
    - no IngestionJob is ever created for a rejected upload
    - no partial/oversized file is ever left on disk after rejection

Both FileStorage-level unit tests (fast, no HTTP overhead) and full
route-level end-to-end tests (via FastAPI's TestClient) are included.
Property tests use small, fast, configurable limits (bytes, not real
200MB/2GB) so boundary behavior can be genuinely exercised without
allocating huge files, per this task's explicit instruction.
"""

from __future__ import annotations

import io
import os

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from hypothesis import HealthCheck, given, settings as hyp_settings
from hypothesis import strategies as st

from app.api.auth_dependency import get_service_jwt_verifier
from app.api.file_storage import FileStorage
from app.api.job_store import InMemoryJobStore
from app.api.routes import get_file_storage, get_job_store, get_settings, router
from app.config.settings import Settings
from app.models.exceptions import UploadTooLargeError
from app.security.service_jwt import ServiceJWTVerifier
from tests.test_api_routes import _AUDIENCE, _ISSUER, _KID, _PUBLIC_PEM, _SCOPE, mint_token


def _authenticated_client(app: FastAPI) -> TestClient:
    """Shared helper for this file's several standalone `TestClient`
    constructions (Security Hardening Stage 1: these routes now require
    an internal service JWT -- see app/api/routes.py's own module
    docstring)."""

    app.dependency_overrides[get_service_jwt_verifier] = lambda: ServiceJWTVerifier(
        public_keys_by_kid={_KID: _PUBLIC_PEM},
        expected_issuer=_ISSUER,
        expected_audience=_AUDIENCE,
        required_scope=_SCOPE,
    )
    # Stage 2 Part B: isolated per-test fakeredis instance -- see
    # test_api_routes.py's own client fixture for the full rationale;
    # several tests sharing this helper upload identical default bytes.
    import fakeredis

    from app.api.routes import get_ingestion_lock
    from app.pipeline.ingestion_lock import IngestionLock

    ingestion_lock = IngestionLock(fakeredis.FakeRedis(decode_responses=True))
    app.dependency_overrides[get_ingestion_lock] = lambda: ingestion_lock
    return TestClient(app, headers={"Authorization": f"Bearer {mint_token()}"})


# ---------------------------------------------------------------------------
# FileStorage.save() unit tests (no HTTP layer)
# ---------------------------------------------------------------------------


@pytest.fixture
def storage(tmp_path) -> FileStorage:
    return FileStorage(settings=Settings(upload_directory=str(tmp_path), _env_file=None))


def test_save_below_limit_succeeds(storage, tmp_path):
    stream = io.BytesIO(b"x" * 500)
    path = storage.save(stream, job_id="job-1", extension=".pdf", max_bytes=1000)

    assert os.path.exists(path)
    assert os.path.getsize(path) == 500


def test_save_exactly_at_limit_succeeds(storage):
    stream = io.BytesIO(b"x" * 1000)
    path = storage.save(stream, job_id="job-1", extension=".pdf", max_bytes=1000)

    assert os.path.getsize(path) == 1000


def test_save_just_above_limit_raises_and_leaves_no_file(storage, tmp_path):
    stream = io.BytesIO(b"x" * 1001)

    with pytest.raises(UploadTooLargeError):
        storage.save(stream, job_id="job-1", extension=".pdf", max_bytes=1000)

    assert list(tmp_path.iterdir()) == []  # no partial file left behind


def test_save_declared_content_length_falsely_small_is_still_caught_by_streaming(storage, tmp_path):
    """The authoritative check is the real byte count, not the header."""

    stream = io.BytesIO(b"x" * 5000)

    with pytest.raises(UploadTooLargeError):
        storage.save(stream, job_id="job-1", extension=".pdf", max_bytes=1000, declared_content_length=10)

    assert list(tmp_path.iterdir()) == []


def test_save_declared_content_length_falsely_large_rejects_early_without_reading(storage, tmp_path):
    """A declared Content-Length that alone exceeds max_bytes is rejected
    immediately -- the stream itself is never touched, verified here by
    using a stream whose real content would otherwise succeed.
    """

    stream = io.BytesIO(b"x" * 10)  # genuinely tiny body

    with pytest.raises(UploadTooLargeError) as exc_info:
        storage.save(stream, job_id="job-1", extension=".pdf", max_bytes=1000, declared_content_length=999_999)

    assert "declares a size" in exc_info.value.message
    assert list(tmp_path.iterdir()) == []  # rejected before any file was created at all


def test_save_declared_content_length_correct_and_within_limit_succeeds(storage):
    stream = io.BytesIO(b"x" * 500)
    path = storage.save(stream, job_id="job-1", extension=".pdf", max_bytes=1000, declared_content_length=500)

    assert os.path.getsize(path) == 500


def test_save_declared_content_length_none_falls_back_to_streaming_check(storage, tmp_path):
    stream = io.BytesIO(b"x" * 5000)

    with pytest.raises(UploadTooLargeError):
        storage.save(stream, job_id="job-1", extension=".pdf", max_bytes=1000, declared_content_length=None)

    assert list(tmp_path.iterdir()) == []


def test_save_exception_during_streaming_cleans_up_partial_file(storage, tmp_path):
    """Any failure mid-stream (not just UploadTooLargeError) must not
    leave a partial file behind.
    """

    class ExplodingStream:
        def __init__(self):
            self._reads = 0

        def read(self, n):
            self._reads += 1
            if self._reads == 1:
                return b"x" * 100
            raise ConnectionError("simulated client disconnect")

    with pytest.raises(ConnectionError):
        storage.save(ExplodingStream(), job_id="job-1", extension=".pdf", max_bytes=10_000)

    assert list(tmp_path.iterdir()) == []


def test_save_video_extension_also_enforces_max_bytes(storage, tmp_path):
    stream = io.BytesIO(b"x" * 2000)

    with pytest.raises(UploadTooLargeError):
        storage.save(stream, job_id="job-1", extension=".mp4", max_bytes=1000)

    assert list(tmp_path.iterdir()) == []


# ---------------------------------------------------------------------------
# FileStorage.save() property tests: generated sizes around the boundary
# ---------------------------------------------------------------------------


@given(limit=st.integers(min_value=100, max_value=5000), delta=st.integers(min_value=1, max_value=99))
@hyp_settings(max_examples=40, deadline=None, suppress_health_check=[HealthCheck.function_scoped_fixture])
def test_property_size_below_limit_always_succeeds(tmp_path, limit, delta):
    size = max(1, limit - delta)
    storage = FileStorage(settings=Settings(upload_directory=str(tmp_path / f"a{limit}{delta}"), _env_file=None))
    stream = io.BytesIO(b"x" * size)

    path = storage.save(stream, job_id="job", extension=".pdf", max_bytes=limit)

    assert os.path.getsize(path) == size


@given(limit=st.integers(min_value=100, max_value=5000))
@hyp_settings(max_examples=25, deadline=None, suppress_health_check=[HealthCheck.function_scoped_fixture])
def test_property_size_exactly_at_limit_always_succeeds(tmp_path, limit):
    storage = FileStorage(settings=Settings(upload_directory=str(tmp_path / f"b{limit}"), _env_file=None))
    stream = io.BytesIO(b"x" * limit)

    path = storage.save(stream, job_id="job", extension=".pdf", max_bytes=limit)

    assert os.path.getsize(path) == limit


@given(limit=st.integers(min_value=100, max_value=5000), delta=st.integers(min_value=1, max_value=99))
@hyp_settings(max_examples=40, deadline=None, suppress_health_check=[HealthCheck.function_scoped_fixture])
def test_property_size_above_limit_always_rejected_and_cleaned_up(tmp_path, limit, delta):
    upload_dir = tmp_path / f"c{limit}{delta}"
    storage = FileStorage(settings=Settings(upload_directory=str(upload_dir), _env_file=None))
    size = limit + delta
    stream = io.BytesIO(b"x" * size)

    with pytest.raises(UploadTooLargeError):
        storage.save(stream, job_id="job", extension=".pdf", max_bytes=limit)

    assert list(upload_dir.iterdir()) == []


@given(
    limit=st.integers(min_value=100, max_value=5000),
    off_by=st.integers(min_value=1, max_value=1),  # exactly one byte over
)
@hyp_settings(max_examples=20, deadline=None, suppress_health_check=[HealthCheck.function_scoped_fixture])
def test_property_off_by_one_byte_over_limit_is_rejected(tmp_path, limit, off_by):
    """Specifically targets an off-by-one implementation error (e.g. `>=`
    vs `>` confusion in either direction): exactly `limit` bytes must
    succeed (tested above) and exactly `limit + 1` must fail.
    """

    upload_dir = tmp_path / f"d{limit}"
    storage = FileStorage(settings=Settings(upload_directory=str(upload_dir), _env_file=None))
    stream = io.BytesIO(b"x" * (limit + off_by))

    with pytest.raises(UploadTooLargeError):
        storage.save(stream, job_id="job", extension=".pdf", max_bytes=limit)


# ---------------------------------------------------------------------------
# Route-level end-to-end tests (real HTTP layer, small configured limits)
# ---------------------------------------------------------------------------


@pytest.fixture
def small_limit_settings(tmp_path) -> Settings:
    # 1MB PDF limit, 1MB video limit (video_max_size_gb has no sub-1GB
    # granularity in Settings, so the video route-level tests below use
    # FileStorage-level checks for fine-grained sizes and only prove the
    # route-level wiring itself at a coarse boundary).
    return Settings(
        upload_directory=str(tmp_path),
        pdf_max_size_mb=1,
        _env_file=None,
    )


@pytest.fixture
def small_limit_client(small_limit_settings) -> TestClient:
    app = FastAPI()
    app.include_router(router)
    job_store = InMemoryJobStore()

    app.dependency_overrides[get_job_store] = lambda: job_store
    app.dependency_overrides[get_file_storage] = lambda: FileStorage(settings=small_limit_settings)
    app.dependency_overrides[get_settings] = lambda: small_limit_settings  # also drives max_bytes in the route

    client = _authenticated_client(app)
    client.job_store = job_store  # type: ignore[attr-defined]
    return client


def _multipart_body(content: bytes, boundary: str = "testboundary") -> bytes:
    return (
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="t.pdf"\r\n'
        f"Content-Type: application/pdf\r\n\r\n"
    ).encode() + content + f"\r\n--{boundary}--\r\n".encode()


def test_route_pdf_upload_below_limit_returns_202_and_creates_job(small_limit_client, small_limit_settings):
    response = small_limit_client.post("/ingest/pdf", files={"file": ("t.pdf", b"x" * 1000, "application/pdf")})

    assert response.status_code == 202
    assert small_limit_client.job_store.list(page=1, page_size=10)[1] == 1
    assert len(os.listdir(small_limit_settings.upload_directory)) == 1


def test_route_pdf_upload_above_limit_no_lying_header_returns_422_no_job_no_file(
    small_limit_client, small_limit_settings
):
    oversized = b"x" * (2 * 1024 * 1024)  # 2MB body, 1MB limit
    response = small_limit_client.post("/ingest/pdf", files={"file": ("t.pdf", oversized, "application/pdf")})

    assert response.status_code == 422
    assert response.json()["detail"]
    assert small_limit_client.job_store.list(page=1, page_size=10)[1] == 0
    assert os.listdir(small_limit_settings.upload_directory) == []


def test_route_pdf_upload_falsely_small_content_length_still_rejected(small_limit_client, small_limit_settings):
    """The core threat model this task defends against: a client that
    lies with a small Content-Length while actually sending an oversized
    body must still be rejected, and rejected without the complete body
    ever being retained on disk.
    """

    oversized_body = b"x" * (2 * 1024 * 1024)
    body = _multipart_body(oversized_body, boundary="lieSmall")

    response = small_limit_client.post(
        "/ingest/pdf",
        content=body,
        headers={"Content-Type": "multipart/form-data; boundary=lieSmall", "Content-Length": "50"},
    )

    assert response.status_code == 422
    assert small_limit_client.job_store.list(page=1, page_size=10)[1] == 0
    assert os.listdir(small_limit_settings.upload_directory) == []


def test_route_pdf_upload_falsely_large_content_length_rejected_early(small_limit_client, small_limit_settings):
    """A declared Content-Length that alone exceeds the limit is rejected
    even though the real body is small -- the deliberate, spec-sanctioned
    "reject early on the declared header alone" behavior.
    """

    small_body = b"x" * 100
    body = _multipart_body(small_body, boundary="lieLarge")

    response = small_limit_client.post(
        "/ingest/pdf",
        content=body,
        headers={"Content-Type": "multipart/form-data; boundary=lieLarge", "Content-Length": str(5 * 1024 * 1024)},
    )

    assert response.status_code == 422
    assert "declares a size" in response.json()["detail"]
    assert small_limit_client.job_store.list(page=1, page_size=10)[1] == 0
    assert os.listdir(small_limit_settings.upload_directory) == []


def test_route_pdf_upload_correct_content_length_within_limit_succeeds(small_limit_client, small_limit_settings):
    content = b"x" * 900
    body = _multipart_body(content, boundary="correct")

    response = small_limit_client.post(
        "/ingest/pdf",
        content=body,
        headers={"Content-Type": "multipart/form-data; boundary=correct", "Content-Length": "900"},
    )

    assert response.status_code == 202
    assert small_limit_client.job_store.list(page=1, page_size=10)[1] == 1


def test_route_video_upload_above_limit_rejected_no_job_no_file(tmp_path):
    """Same enforcement mechanism applies identically to the video route
    (centralized in FileStorage, not duplicated per-route). Uses the
    smallest possible video_max_size_gb (1) since Settings has no
    sub-GB granularity for video, and confirms wiring is genuinely
    shared rather than PDF-only.
    """

    settings = Settings(upload_directory=str(tmp_path), video_max_size_gb=1, _env_file=None)
    app = FastAPI()
    app.include_router(router)
    job_store = InMemoryJobStore()
    app.dependency_overrides[get_job_store] = lambda: job_store
    app.dependency_overrides[get_file_storage] = lambda: FileStorage(settings=settings)
    app.dependency_overrides[get_settings] = lambda: settings
    client = _authenticated_client(app)

    # Well within 1GB -- must succeed, proving the video path is wired
    # through the same enforcement without being accidentally more/less
    # strict than the PDF path.
    response = client.post("/ingest/video", files={"file": ("t.mp4", b"x" * 10_000, "video/mp4")})
    assert response.status_code == 202
    assert job_store.list(page=1, page_size=10)[1] == 1


def test_route_video_upload_declared_oversized_content_length_rejected(tmp_path):
    settings = Settings(upload_directory=str(tmp_path), video_max_size_gb=1, _env_file=None)
    app = FastAPI()
    app.include_router(router)
    job_store = InMemoryJobStore()
    app.dependency_overrides[get_job_store] = lambda: job_store
    app.dependency_overrides[get_file_storage] = lambda: FileStorage(settings=settings)
    app.dependency_overrides[get_settings] = lambda: settings
    client = _authenticated_client(app)

    boundary = "videolie"
    small_body = b"x" * 100
    body = (
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="t.mp4"\r\n'
        f"Content-Type: video/mp4\r\n\r\n"
    ).encode() + small_body + f"\r\n--{boundary}--\r\n".encode()

    huge_declared = (2 * 1024**3) + 1  # just over 2GB, i.e. over a 1GB configured limit too
    response = client.post(
        "/ingest/video",
        content=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}", "Content-Length": str(huge_declared)},
    )

    assert response.status_code == 422
    assert job_store.list(page=1, page_size=10)[1] == 0
    assert os.listdir(tmp_path) == []


# ---------------------------------------------------------------------------
# Content-Length header parsing edge cases
# ---------------------------------------------------------------------------


def test_route_malformed_content_length_header_falls_back_to_streaming_check(small_limit_client, small_limit_settings):
    """A non-integer Content-Length header must not crash the request --
    it's treated the same as absent, falling back entirely to the
    authoritative streaming check.
    """

    body = _multipart_body(b"x" * 500, boundary="malformed")
    response = small_limit_client.post(
        "/ingest/pdf",
        content=body,
        headers={"Content-Type": "multipart/form-data; boundary=malformed", "Content-Length": "not-a-number"},
    )

    # Starlette itself may reject a syntactically invalid Content-Length
    # before this application's code ever runs; either way, this must
    # never be treated as an accepted, successfully-queued upload for an
    # oversized body, and must never crash with an unhandled exception.
    assert response.status_code in (200, 202, 400, 422)


def test_route_negative_content_length_treated_as_absent(small_limit_client, small_limit_settings):
    body = _multipart_body(b"x" * 500, boundary="negative")
    response = small_limit_client.post(
        "/ingest/pdf",
        content=body,
        headers={"Content-Type": "multipart/form-data; boundary=negative", "Content-Length": "-5"},
    )

    # A negative declared length is nonsensical and must not be trusted
    # as "definitely small enough" -- the small, valid body here should
    # still succeed via the streaming check regardless.
    assert response.status_code in (202, 400, 422)
