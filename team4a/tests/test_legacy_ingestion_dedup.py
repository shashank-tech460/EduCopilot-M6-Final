"""Stage 2 Part B -- regression tests for the legacy-route
(`/ingest/pdf`, `/ingest/video`, `/ingest/youtube`) content-hash
deduplication fix (app/api/routes.py's `_claim_legacy_content_or_409`).

ROOT CAUSE (reproduced and confirmed here, not assumed): before this fix,
each of these routes created a brand-new `IngestionJob` with a fresh,
random `job_id` on every call, with no deduplication at all. Since chunk
identity is a deterministic uuid5 of `job_id` (app/pipeline/metadata.py),
two calls uploading the SAME bytes under two DIFFERENT job_ids always
published two fully disjoint sets of Qdrant points -- genuine chunk
duplication, not merely wasted work. `test_reproduces_the_original_bug_*`
below proves this directly against the OLD (pre-fix) code path by
bypassing the new dedup check, so the fix's own value is falsifiable, not
just asserted.

Uses the SAME `client`/`job_store`/`pdf_upload`/`video_upload` fixtures
already established in tests/test_api_routes.py (each test client's own
`IngestionLock` is backed by a fresh, isolated `fakeredis.FakeRedis()`
instance -- see that file's `client` fixture for why).
"""

from __future__ import annotations

import fakeredis
import pytest

from app.api.routes import get_ingestion_lock
from app.pipeline.ingestion_lock import DocumentAlreadyLockedError, IngestionLock
from tests.test_api_routes import client, job_store, pdf_upload, video_upload  # noqa: F401 (fixtures, reused not duplicated)


class TestDuplicatePdfUpload:
    def test_a_second_identical_upload_is_rejected_with_409(self, client):
        first = client.post("/ingest/pdf", files=pdf_upload())
        second = client.post("/ingest/pdf", files=pdf_upload())

        assert first.status_code == 202
        assert second.status_code == 409

    def test_only_one_job_is_created_for_two_identical_uploads(self, client, job_store):
        client.post("/ingest/pdf", files=pdf_upload())
        client.post("/ingest/pdf", files=pdf_upload())

        assert job_store.list(page=1, page_size=10)[1] == 1

    def test_two_uploads_with_genuinely_different_content_both_succeed(self, client, job_store):
        first = client.post("/ingest/pdf", files=pdf_upload(content=b"%PDF-1.4 document A"))
        second = client.post("/ingest/pdf", files=pdf_upload(content=b"%PDF-1.4 document B"))

        assert first.status_code == 202
        assert second.status_code == 202
        assert job_store.list(page=1, page_size=10)[1] == 2
        assert first.json()["job_id"] != second.json()["job_id"]

    def test_a_rejected_duplicate_does_not_leave_an_orphaned_file_on_disk(self, client, tmp_path):
        client.post("/ingest/pdf", files=pdf_upload())
        rejected = client.post("/ingest/pdf", files=pdf_upload())
        assert rejected.status_code == 409

        # Exactly one saved file should exist (the first, accepted
        # upload) -- the rejected duplicate's own save must have been
        # cleaned up, not left behind.
        saved_files = list(tmp_path.rglob("*.pdf"))
        assert len(saved_files) == 1

    def test_the_409_response_does_not_leak_internal_details(self, client):
        client.post("/ingest/pdf", files=pdf_upload())
        rejected = client.post("/ingest/pdf", files=pdf_upload())

        assert "redis" not in rejected.text.lower()
        assert "Traceback" not in rejected.text


class TestDuplicateVideoUpload:
    def test_a_second_identical_upload_is_rejected_with_409(self, client):
        first = client.post("/ingest/video", files=video_upload())
        second = client.post("/ingest/video", files=video_upload())

        assert first.status_code == 202
        assert second.status_code == 409

    def test_different_video_content_is_not_deduplicated_against_a_pdf_with_the_same_bytes(self, client, job_store):
        # Namespaced by source_type (see _claim_legacy_content_or_409's
        # own docstring) -- a PDF and a video upload that happen to hash
        # identically (e.g. both empty, or a contrived collision) must
        # never be treated as duplicates of EACH OTHER.
        same_bytes = b"identical content across source types"
        pdf_response = client.post("/ingest/pdf", files=pdf_upload(content=same_bytes))
        video_response = client.post(
            "/ingest/video", files={"file": ("t.mp4", same_bytes, "video/mp4")}
        )

        assert pdf_response.status_code == 202
        assert video_response.status_code == 202
        assert job_store.list(page=1, page_size=10)[1] == 2


class TestDuplicateYouTubeUpload:
    def test_a_second_identical_url_is_rejected_with_409(self, client):
        body = {"url": "https://www.youtube.com/watch?v=abc123"}
        first = client.post("/ingest/youtube", json=body)
        second = client.post("/ingest/youtube", json=body)

        assert first.status_code == 202
        assert second.status_code == 409

    def test_two_different_urls_both_succeed(self, client, job_store):
        first = client.post("/ingest/youtube", json={"url": "https://www.youtube.com/watch?v=aaa111"})
        second = client.post("/ingest/youtube", json={"url": "https://www.youtube.com/watch?v=bbb222"})

        assert first.status_code == 202
        assert second.status_code == 202
        assert job_store.list(page=1, page_size=10)[1] == 2


class TestRetrySafety:
    """'Retries after partial failures do not create duplicate chunks' --
    a retry of the SAME content within the dedup window is, by design,
    treated identically to any other duplicate: rejected. This is the
    deliberately safe choice (never risk a duplicate) over a more
    elaborate "resume my own failed attempt" mechanism, consistent with
    this fix's minimal, additive scope. A genuinely NEW attempt (after
    the dedup window elapses, or with different content) is always still
    possible -- proven below.
    """

    def test_retrying_the_same_upload_shortly_after_a_prior_success_is_rejected_not_duplicated(self, client, job_store):
        client.post("/ingest/pdf", files=pdf_upload())
        retry = client.post("/ingest/pdf", files=pdf_upload())

        assert retry.status_code == 409
        assert job_store.list(page=1, page_size=10)[1] == 1

    def test_a_genuinely_new_upload_after_the_dedup_window_elapses_is_accepted(self, client, job_store):
        # Simulates window expiry directly against the same fakeredis
        # instance this client's IngestionLock uses, rather than sleeping
        # in a test -- the mechanism under test is the lock's own TTL,
        # already covered by app/pipeline/ingestion_lock.py's dedicated
        # tests; this only proves THIS route wires it up so expiry
        # actually re-permits a later attempt.
        first = client.post("/ingest/pdf", files=pdf_upload())
        assert first.status_code == 202

        fake_redis: fakeredis.FakeRedis = client.app.dependency_overrides[get_ingestion_lock]().__dict__["_redis"]
        for key in fake_redis.keys("lock:ingestion:legacy:pdf:*"):
            fake_redis.delete(key)

        retry = client.post("/ingest/pdf", files=pdf_upload())
        assert retry.status_code == 202
        assert job_store.list(page=1, page_size=10)[1] == 2


class TestConcurrentRequestsDoNotDuplicate:
    """Genuine concurrency is exercised directly against the underlying
    `IngestionLock` (already covered exhaustively by
    tests/test_ingestion_lock.py's own concurrency tests, including real
    multi-threaded acquisition races) -- this class instead proves that
    THIS route correctly refuses a second request the moment the first
    has already claimed the lock, which is the actual behavior that
    prevents concurrent duplicate chunks; two real concurrent HTTP
    requests hitting a single-threaded TestClient can only ever be
    exercised sequentially anyway."""

    def test_a_lock_already_held_for_this_exact_content_is_rejected_immediately(self, client, job_store):
        lock: IngestionLock = client.app.dependency_overrides[get_ingestion_lock]()
        # Simulates a second, truly-concurrent request's save+hash
        # already having completed and raced ahead to acquire the lock
        # first -- the route's own request below must lose that race
        # cleanly, not create a job anyway.
        import hashlib

        content_hash = hashlib.sha256(b"%PDF-1.4 fake content").hexdigest()
        lock.acquire(document_id=f"legacy:pdf:{content_hash}", lease_seconds=60)

        response = client.post("/ingest/pdf", files=pdf_upload())

        assert response.status_code == 409
        assert job_store.list(page=1, page_size=10)[1] == 0


def test_reproduces_the_original_bug_when_dedup_is_bypassed(client, job_store, monkeypatch):
    """Proves the FIX has real effect, not just that the new code path
    exists: with `_claim_legacy_content_or_409` forced to a no-op
    (simulating the pre-fix route), two identical uploads both succeed
    and create two SEPARATE jobs -- the exact duplicate-ingestion
    condition this stage was asked to fix."""

    import app.api.routes as routes_module

    monkeypatch.setattr(routes_module, "_claim_legacy_content_or_409", lambda *args, **kwargs: None)

    first = client.post("/ingest/pdf", files=pdf_upload())
    second = client.post("/ingest/pdf", files=pdf_upload())

    assert first.status_code == 202
    assert second.status_code == 202
    assert job_store.list(page=1, page_size=10)[1] == 2  # the bug: two jobs for one real document
    assert first.json()["job_id"] != second.json()["job_id"]
