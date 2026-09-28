"""Phase 2C / 2C-R tests -- the canonical `POST /v1/ingest` route.

Uses the REAL Phase 2B `ServiceJWTVerifier` (via `app.dependency_overrides`
to inject one configured with a real, test-generated ES256 key pair,
rather than mocking authentication away) and real `jwt.encode`-signed
tokens -- the same "no mocking the JWT library" discipline Phase 2B's own
test suite established.

Since Phase 2C-R, this route performs real work past authentication:
secure `file_url` retrieval (pdf/mp4) or direct `YouTubeProcessor`
invocation (youtube), then the real Phase 1
`CanonicalIngestionOrchestrator`. These tests inject a REAL orchestrator
built from fake-but-real-protocol infrastructure doubles (fakeredis,
mongomock, an in-memory Qdrant double) -- exactly Phase 1's own
established test convention (see tests/test_canonical_ingestion.py) --
via `app.dependency_overrides[get_canonical_orchestrator]`, never a mock
of the orchestrator's own logic. The extraction functions
(`extract_pdf_for_canonical_ingestion` etc.) are monkeypatched at their
IMPORT site in `app.api.canonical_ingest` for the mp4/youtube cases only,
since those would otherwise require a real video file / real network
access neither of which belongs in a deterministic unit test suite; the
PDF case uses the REAL resolver against a REAL local HTTP server and REAL
(tiny) PDF bytes, proving the actual secure-retrieval integration works,
not just that it COULD be mocked to appear to work.
"""

from __future__ import annotations

import json
import threading
import time
import http.server
from types import SimpleNamespace

import fakeredis
import jwt
import mongomock
import pytest
from bson import ObjectId
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi import status
from fastapi.testclient import TestClient

import app.api.canonical_ingest as canonical_ingest_module
from app.api.auth_dependency import get_service_jwt_verifier
from app.api.canonical_ingest import get_canonical_orchestrator
from app.config.settings import Settings
from app.main import app
from app.pipeline.canonical_ingestion import CanonicalIngestionOrchestrator
from app.pipeline.ingestion_lock import IngestionLock
from app.pipeline.mongo_authority import MongoAuthorityClient
from app.pipeline.publisher import Publisher
from app.security.service_jwt import ServiceJWTVerifier

ISSUER = "https://educopilot.internal"
AUDIENCE = "team4a-ingestion"
SCOPE = "ingest"
KID = "test-kid-1"


def _generate_es256_keypair() -> tuple[str, str]:
    private_key = ec.generate_private_key(ec.SECP256R1())
    private_pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()
    public_pem = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode()
    return private_pem, public_pem


PRIVATE_PEM, PUBLIC_PEM = _generate_es256_keypair()
_OTHER_PRIVATE_PEM, _OTHER_PUBLIC_PEM = _generate_es256_keypair()


def _mint(
    *,
    sub: str = "user-1",
    workspace_id: str = "ws-1",
    scope: str = SCOPE,
    issuer: str = ISSUER,
    audience: str = AUDIENCE,
    kid: str = KID,
    private_pem: str = PRIVATE_PEM,
    ttl_seconds: int = 300,
    jti: str = "jti-1",
    omit_claims: tuple[str, ...] = (),
) -> str:
    now = time.time()
    claims = {
        "sub": sub,
        "workspace_id": workspace_id,
        "scope": scope,
        "iss": issuer,
        "aud": audience,
        "iat": int(now),
        "exp": int(now + ttl_seconds),
        "jti": jti,
    }
    for claim in omit_claims:
        claims.pop(claim, None)
    return jwt.encode(claims, private_pem, algorithm="ES256", headers={"kid": kid})


_REAL_PDF_BYTES = b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF"
_TEST_DOCUMENT_ID = "6aa1c4d537e42519bd73e1cc"


class _PdfHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/pdf")
        self.send_header("Content-Length", str(len(_REAL_PDF_BYTES)))
        self.end_headers()
        self.wfile.write(_REAL_PDF_BYTES)


@pytest.fixture(scope="module")
def local_pdf_server():
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _PdfHandler)
    server.daemon_threads = True
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{port}/lecture.pdf"
    server.shutdown()
    thread.join(timeout=5)


def make_fake_orchestrator(seed_document_id: str | None = None) -> tuple[CanonicalIngestionOrchestrator, object]:
    """A REAL CanonicalIngestionOrchestrator built from fake-but-real-
    protocol infrastructure doubles -- fakeredis, mongomock, an in-memory
    Qdrant double -- exactly Phase 1's own established test convention.
    Returns (orchestrator, qdrant_double) so tests can inspect published
    points."""

    class _FakeQdrantClient:
        def __init__(self):
            self.points_by_collection: dict[str, dict] = {}

        def upsert(self, collection_name, points):
            bucket = self.points_by_collection.setdefault(collection_name, {})
            for point in points:
                bucket[point.id] = point
            return {"status": "acknowledged"}

        def delete_points_by_id(self, collection_name, point_ids):
            bucket = self.points_by_collection.get(collection_name, {})
            for pid in point_ids:
                bucket.pop(pid, None)

        def delete_points_by_generation_filter(self, collection_name, document_id, less_than_generation):
            bucket = self.points_by_collection.get(collection_name, {})
            to_delete = [
                pid
                for pid, p in bucket.items()
                if p.payload.get("document_id") == document_id and p.payload.get("ingestion_generation", 0) < less_than_generation
            ]
            for pid in to_delete:
                bucket.pop(pid, None)

    redis_client = fakeredis.FakeStrictRedis(decode_responses=True)
    mongo_client = mongomock.MongoClient()
    if seed_document_id:
        mongo_client["test_db"]["files"].insert_one({"_id": ObjectId(seed_document_id), "currentIngestionGeneration": 0})

    lock = IngestionLock(redis_client)
    mongo_authority = MongoAuthorityClient(mongo_client, "test_db", "files")
    qdrant = _FakeQdrantClient()
    publisher = Publisher(
        settings=SimpleNamespace(
            qdrant_collection_name="team4a_ingested_chunks",
            qdrant_publish_batch_size=100,
            publisher_retry_count=1,
            publisher_initial_backoff_seconds=0.01,
        ),
        qdrant_client=qdrant,
    )
    orchestrator = CanonicalIngestionOrchestrator(
        lock=lock,
        publisher=publisher,
        mutation_client=qdrant,
        mongo_authority=mongo_authority,
        canonical_collection_name="educopilot_chunks",
        lease_seconds=14400,
    )
    return orchestrator, qdrant


@pytest.fixture()
def client():
    real_verifier = ServiceJWTVerifier(
        public_keys_by_kid={KID: PUBLIC_PEM},
        expected_issuer=ISSUER,
        expected_audience=AUDIENCE,
        required_scope=SCOPE,
    )
    app.dependency_overrides[get_service_jwt_verifier] = lambda: real_verifier
    orchestrator, _ = make_fake_orchestrator(seed_document_id=_TEST_DOCUMENT_ID)
    app.dependency_overrides[get_canonical_orchestrator] = lambda: orchestrator
    yield TestClient(app)
    app.dependency_overrides.clear()


def _valid_body(file_type: str = "pdf", file_url: str | None = None) -> dict:
    return {
        "document_id": _TEST_DOCUMENT_ID,
        "file_type": file_type,
        "file_url": file_url or "https://storage.example.test/lecture.pdf",
    }


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


# -- 1-3: valid requests -- full real flow through to Phase 1 orchestration --


def test_1_valid_pdf_request_reaches_the_existing_processor_and_phase1_orchestration(
    client, local_pdf_server, monkeypatch
):
    """The REAL flow: real resolver, real local HTTP server, real PDF
    bytes, real PDFProcessor/Chunker/Embedder/MetadataEnricher, real
    (fake-infra-backed) Phase 1 orchestrator."""

    settings_override = SimpleNamespace(
        **{
            **vars(get_settings_snapshot()),
            "file_url_trusted_origins_json": json.dumps(["127.0.0.1"]),
            "file_url_require_https": False,
        }
    )
    from app.config.settings import get_settings

    app.dependency_overrides[get_settings] = lambda: settings_override

    token = _mint()
    response = client.post(
        "/v1/ingest", json=_valid_body(file_type="pdf", file_url=local_pdf_server), headers=_auth(token)
    )

    assert response.status_code == status.HTTP_202_ACCEPTED, response.text
    body = response.json()
    assert body["document_id"] == _TEST_DOCUMENT_ID
    assert body["status"] == "completed"
    assert body["generation"] == 1


def get_settings_snapshot():
    from app.config.settings import get_settings

    return get_settings()


@pytest.mark.parametrize("file_type", ["mp4", "youtube"])
def test_2_and_3_valid_mp4_and_youtube_requests_reach_phase1_orchestration(client, file_type, monkeypatch):
    """mp4/youtube extraction is monkeypatched at its import site in
    app.api.canonical_ingest -- a real video file / real YouTube network
    access does not belong in a deterministic unit test; the resolver
    (for mp4) and YouTubeProcessor (for youtube) each have their own
    dedicated, real tests elsewhere (test_remote_source_resolver.py;
    the existing, unmodified test_youtube_processor.py)."""

    from app.models.schemas import ChunkMetadata, Chunk, EnrichedChunk
    from datetime import datetime, timezone

    # Uses PDF-shaped metadata regardless of the file_type under test --
    # these tests verify tenancy/orchestration wiring, not source-type
    # metadata shape (already covered elsewhere by Phase 1's own tests).
    fake_metadata = ChunkMetadata(
        chunk_id=f"chunk-{file_type}-1",
        source_type="pdf",
        job_id=f"canonical-{_TEST_DOCUMENT_ID}",
        ingestion_timestamp=datetime.now(timezone.utc),
        embedding_model="fake-model",
        embedding_model_version="fake-version",
        chunk_position=0,
        filename="fake.pdf",
        page_number=1,
    )
    fake_chunk = EnrichedChunk(chunk=Chunk(text="fake content", chunk_index=0, total_chunks=1), metadata=fake_metadata)

    if file_type == "mp4":
        monkeypatch.setattr(
            canonical_ingest_module,
            "extract_video_for_canonical_ingestion",
            lambda job_id, path, settings: ([fake_chunk], [[0.1] * 384]),
        )
        # Also bypass the real resolver for mp4 (no real video file here).
        monkeypatch.setattr(
            canonical_ingest_module, "resolve_pdf_or_mp4_source", lambda url, ft, settings: __import__("pathlib").Path("/tmp/fake.mp4")
        )
        monkeypatch.setattr("pathlib.Path.unlink", lambda self, missing_ok=False: None)
    else:
        monkeypatch.setattr(
            canonical_ingest_module,
            "extract_youtube_for_canonical_ingestion",
            lambda job_id, url, settings: ([fake_chunk], [[0.1] * 384]),
        )

    token = _mint()
    response = client.post("/v1/ingest", json=_valid_body(file_type=file_type), headers=_auth(token))

    assert response.status_code == status.HTTP_202_ACCEPTED, response.text
    assert response.json()["status"] == "completed"


# -- 4-10: authentication failures -------------------------------------------


def test_4_missing_authorization_rejected(client):
    response = client.post("/v1/ingest", json=_valid_body())
    assert response.status_code == status.HTTP_401_UNAUTHORIZED


def test_5_invalid_jwt_rejected(client):
    response = client.post("/v1/ingest", json=_valid_body(), headers=_auth("not-a-real-jwt"))
    assert response.status_code == status.HTTP_401_UNAUTHORIZED


def test_6_expired_jwt_rejected(client):
    token = _mint(ttl_seconds=-3600)
    response = client.post("/v1/ingest", json=_valid_body(), headers=_auth(token))
    assert response.status_code == status.HTTP_401_UNAUTHORIZED


def test_7_unknown_kid_rejected(client):
    token = _mint(kid="kid-does-not-exist")
    response = client.post("/v1/ingest", json=_valid_body(), headers=_auth(token))
    assert response.status_code == status.HTTP_401_UNAUTHORIZED


def test_8_wrong_audience_rejected(client):
    token = _mint(audience="team4b-query")
    response = client.post("/v1/ingest", json=_valid_body(), headers=_auth(token))
    assert response.status_code == status.HTTP_401_UNAUTHORIZED


def test_9_wrong_scope_rejected(client):
    token = _mint(scope="query")
    response = client.post("/v1/ingest", json=_valid_body(), headers=_auth(token))
    assert response.status_code == status.HTTP_401_UNAUTHORIZED


def test_10_wrong_issuer_rejected(client):
    token = _mint(issuer="https://not-educopilot.example")
    response = client.post("/v1/ingest", json=_valid_body(), headers=_auth(token))
    assert response.status_code == status.HTTP_401_UNAUTHORIZED


def test_11_missing_sub_rejected(client):
    token = _mint(omit_claims=("sub",))
    response = client.post("/v1/ingest", json=_valid_body(), headers=_auth(token))
    assert response.status_code == status.HTTP_401_UNAUTHORIZED


def test_12_missing_workspace_id_rejected(client):
    token = _mint(omit_claims=("workspace_id",))
    response = client.post("/v1/ingest", json=_valid_body(), headers=_auth(token))
    assert response.status_code == status.HTTP_401_UNAUTHORIZED


def test_signature_from_a_different_key_rejected(client):
    token = _mint(private_pem=_OTHER_PRIVATE_PEM)  # a real, differently-keyed signature
    response = client.post("/v1/ingest", json=_valid_body(), headers=_auth(token))
    assert response.status_code == status.HTTP_401_UNAUTHORIZED


# -- 13-16: contract validation ----------------------------------------------


def test_13_missing_document_id_rejected(client):
    token = _mint()
    body = _valid_body()
    del body["document_id"]
    response = client.post("/v1/ingest", json=body, headers=_auth(token))
    assert response.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT


def test_14_invalid_document_id_rejected(client):
    token = _mint()
    body = _valid_body()
    body["document_id"] = "   "  # blank/whitespace-only
    response = client.post("/v1/ingest", json=body, headers=_auth(token))
    assert response.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT


def test_15_unsupported_file_type_rejected(client):
    token = _mint()
    body = _valid_body()
    body["file_type"] = "docx"
    response = client.post("/v1/ingest", json=body, headers=_auth(token))
    assert response.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT


def test_16_missing_file_url_rejected(client):
    token = _mint()
    body = _valid_body()
    del body["file_url"]
    response = client.post("/v1/ingest", json=body, headers=_auth(token))
    assert response.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT


def test_malformed_file_url_rejected(client):
    token = _mint()
    body = _valid_body()
    body["file_url"] = "not-a-url"
    response = client.post("/v1/ingest", json=body, headers=_auth(token))
    assert response.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT


# -- 17/18: tenancy invariant -- body cannot override JWT identity -----------


def test_17_body_workspace_id_cannot_override_jwt_workspace_id(client):
    """The canonical contract has no workspace_id field at all --
    including one in the body must be REJECTED outright (strict contract
    rejection), never silently accepted and ignored, and certainly never
    used as authority."""

    token = _mint(workspace_id="ws-from-jwt")
    body = _valid_body()
    body["workspace_id"] = "ws-INJECTED-FROM-BODY"
    response = client.post("/v1/ingest", json=body, headers=_auth(token))
    assert response.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT


def test_18_body_user_id_cannot_override_jwt_sub(client):
    token = _mint(sub="user-from-jwt")
    body = _valid_body()
    body["user_id"] = "user-INJECTED-FROM-BODY"
    response = client.post("/v1/ingest", json=body, headers=_auth(token))
    assert response.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT


def test_tenancy_invariant_two_requests_same_document_different_jwt_identity(client, monkeypatch):
    """The exact scenario named in the governing task: the same
    document_id, two different verified JWT identities, must each
    resolve strictly to their own JWT's workspace_id/sub -- never
    cross-contaminated, and never overridable by any body field (there
    is none to override with, by construction). Extraction is
    monkeypatched (youtube path, to avoid needing a real network fetch)
    so this test isolates the tenancy-resolution behavior specifically.
    """

    from app.models.schemas import Chunk, ChunkMetadata, EnrichedChunk
    from datetime import datetime, timezone

    fake_metadata = ChunkMetadata(
        chunk_id="chunk-tenancy-1",
        source_type="pdf",
        job_id="canonical-tenancy-test",
        ingestion_timestamp=datetime.now(timezone.utc),
        embedding_model="fake-model",
        embedding_model_version="fake-version",
        chunk_position=0,
        filename="fake.pdf",
        page_number=1,
    )
    fake_chunk = EnrichedChunk(chunk=Chunk(text="fake content", chunk_index=0, total_chunks=1), metadata=fake_metadata)
    monkeypatch.setattr(
        canonical_ingest_module,
        "extract_youtube_for_canonical_ingestion",
        lambda job_id, url, settings: ([fake_chunk], [[0.1] * 384]),
    )

    document_id = _TEST_DOCUMENT_ID

    token_a = _mint(sub="user-A", workspace_id="workspace-A")
    response_a = client.post(
        "/v1/ingest",
        json={"document_id": document_id, "file_type": "youtube", "file_url": "https://youtube.com/watch?v=x"},
        headers=_auth(token_a),
    )
    assert response_a.status_code == status.HTTP_202_ACCEPTED, response_a.text
    assert response_a.json()["workspace_id"] == "workspace-A"

    token_b = _mint(sub="user-B", workspace_id="workspace-B")
    response_b = client.post(
        "/v1/ingest",
        json={"document_id": document_id, "file_type": "youtube", "file_url": "https://youtube.com/watch?v=x"},
        headers=_auth(token_b),
    )
    assert response_b.status_code == status.HTTP_202_ACCEPTED, response_b.text
    assert response_b.json()["workspace_id"] == "workspace-B"


# -- Extra field rejection (defense in depth for the tenancy invariant) -----


def test_any_unexpected_field_in_the_body_is_rejected(client):
    token = _mint()
    body = _valid_body()
    body["unexpected_field"] = "anything"
    response = client.post("/v1/ingest", json=body, headers=_auth(token))
    assert response.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT


# -- Route does not leak JWT/crypto internals --------------------------------


def test_auth_failure_response_does_not_leak_verification_details(client):
    token = _mint(kid="kid-does-not-exist")
    response = client.post("/v1/ingest", json=_valid_body(), headers=_auth(token))
    body_text = response.text.lower()
    assert "kid-does-not-exist" not in body_text
    assert "-----begin" not in body_text  # no PEM key material of any kind


# -- 19/33: existing File required; Team 4A cannot create a File ------------


def test_19_existing_file_is_required_missing_file_is_reported_not_created(monkeypatch):
    """Uses a FRESH client/orchestrator (not the seeded `client` fixture)
    so no File exists for this document_id at all."""

    real_verifier = ServiceJWTVerifier(
        public_keys_by_kid={KID: PUBLIC_PEM}, expected_issuer=ISSUER, expected_audience=AUDIENCE, required_scope=SCOPE
    )
    orchestrator, _ = make_fake_orchestrator(seed_document_id=None)  # no File seeded

    from app.models.schemas import Chunk, ChunkMetadata, EnrichedChunk
    from datetime import datetime, timezone

    fake_metadata = ChunkMetadata(
        chunk_id="chunk-missing-file-1",
        source_type="pdf",
        job_id="canonical-test",
        ingestion_timestamp=datetime.now(timezone.utc),
        embedding_model="fake-model",
        embedding_model_version="fake-version",
        chunk_position=0,
        filename="fake.pdf",
        page_number=1,
    )
    fake_chunk = EnrichedChunk(chunk=Chunk(text="fake content", chunk_index=0, total_chunks=1), metadata=fake_metadata)
    monkeypatch.setattr(
        canonical_ingest_module,
        "extract_youtube_for_canonical_ingestion",
        lambda job_id, url, settings: ([fake_chunk], [[0.1] * 384]),
    )

    app.dependency_overrides[get_service_jwt_verifier] = lambda: real_verifier
    app.dependency_overrides[get_canonical_orchestrator] = lambda: orchestrator
    test_client = TestClient(app)
    try:
        token = _mint()
        response = test_client.post(
            "/v1/ingest",
            json={"document_id": _TEST_DOCUMENT_ID, "file_type": "youtube", "file_url": "https://youtube.com/watch?v=x"},
            headers=_auth(token),
        )
        assert response.status_code == status.HTTP_404_NOT_FOUND
        assert "aborted_missing_file" in response.text
    finally:
        app.dependency_overrides.clear()


# -- Object-id conversion isolation: re-confirmed at the route level --------


def test_20_document_id_stays_a_plain_string_through_the_route(client, monkeypatch):
    """document_id must never be converted to ObjectId anywhere the route
    itself touches -- only inside MongoAuthorityClient (Phase 1, untouched
    and unmodified by this route)."""

    from app.models.schemas import Chunk, ChunkMetadata, EnrichedChunk
    from datetime import datetime, timezone

    fake_metadata = ChunkMetadata(
        chunk_id="chunk-oid-1",
        source_type="pdf",
        job_id="canonical-test",
        ingestion_timestamp=datetime.now(timezone.utc),
        embedding_model="fake-model",
        embedding_model_version="fake-version",
        chunk_position=0,
        filename="fake.pdf",
        page_number=1,
    )
    fake_chunk = EnrichedChunk(chunk=Chunk(text="fake content", chunk_index=0, total_chunks=1), metadata=fake_metadata)
    monkeypatch.setattr(
        canonical_ingest_module,
        "extract_youtube_for_canonical_ingestion",
        lambda job_id, url, settings: ([fake_chunk], [[0.1] * 384]),
    )

    token = _mint()
    response = client.post(
        "/v1/ingest",
        json={"document_id": _TEST_DOCUMENT_ID, "file_type": "youtube", "file_url": "https://youtube.com/watch?v=x"},
        headers=_auth(token),
    )
    assert response.status_code == status.HTTP_202_ACCEPTED
    assert response.json()["document_id"] == _TEST_DOCUMENT_ID
    assert isinstance(response.json()["document_id"], str)


def test_untrusted_pdf_origin_rejected_with_a_safe_error(client):
    token = _mint()
    response = client.post(
        "/v1/ingest",
        json=_valid_body(file_type="pdf", file_url="https://evil.example.com/lecture.pdf"),
        headers=_auth(token),
    )
    assert response.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT
    assert "evil.example.com" not in response.text


# -- MVP M3, TEST 14: re-ingestion preserves the same workspace boundary ----


def test_reingestion_of_the_same_document_preserves_the_trusted_workspace_id(client, monkeypatch):
    """Re-ingesting the same document_id (a new generation) under the
    SAME real workspace identity must publish the new generation's
    chunks with that SAME workspace_id -- the trusted value is derived
    fresh from the JWT on every call, never cached/reset incorrectly
    across generations."""

    from app.models.schemas import Chunk, ChunkMetadata, EnrichedChunk
    from datetime import datetime, timezone

    def make_fake_chunk(generation_label: str):
        fake_metadata = ChunkMetadata(
            chunk_id=f"chunk-reingest-{generation_label}",
            source_type="pdf",
            job_id=f"canonical-{_TEST_DOCUMENT_ID}-{generation_label}",
            ingestion_timestamp=datetime.now(timezone.utc),
            embedding_model="fake-model",
            embedding_model_version="fake-version",
            chunk_position=0,
            filename="fake.pdf",
            page_number=1,
        )
        return EnrichedChunk(chunk=Chunk(text="fake content", chunk_index=0, total_chunks=1), metadata=fake_metadata)

    monkeypatch.setattr(
        canonical_ingest_module,
        "extract_youtube_for_canonical_ingestion",
        lambda job_id, url, settings: ([make_fake_chunk(job_id)], [[0.1] * 384]),
    )

    token = _mint(sub="user-A", workspace_id="workspace-consistent")
    body = {"document_id": _TEST_DOCUMENT_ID, "file_type": "youtube", "file_url": "https://youtube.com/watch?v=x"}

    response_gen1 = client.post("/v1/ingest", json=body, headers=_auth(token))
    assert response_gen1.status_code == status.HTTP_202_ACCEPTED, response_gen1.text
    assert response_gen1.json()["generation"] == 1
    assert response_gen1.json()["workspace_id"] == "workspace-consistent"

    response_gen2 = client.post("/v1/ingest", json=body, headers=_auth(token))
    assert response_gen2.status_code == status.HTTP_202_ACCEPTED, response_gen2.text
    assert response_gen2.json()["generation"] == 2
    assert response_gen2.json()["workspace_id"] == "workspace-consistent"


# ---------------------------------------------------------------------------
# MVP M6 correction — YouTube transcript/video-inaccessible error translation
# ---------------------------------------------------------------------------


def test_youtube_transcript_unavailable_returns_controlled_502_not_500(client, monkeypatch):
    """The live-confirmed root cause: TranscriptUnavailableError (raised
    when a video has no transcript in the requested language -- exactly
    the real youtube_transcript_api.NoTranscriptFound scenario observed
    live) must become a controlled 502, never an unhandled 500."""

    from app.models.exceptions import TranscriptUnavailableError

    def _raise_transcript_unavailable(job_id, url, settings):
        raise TranscriptUnavailableError("No transcript available for this video in language 'en'")

    monkeypatch.setattr(canonical_ingest_module, "extract_youtube_for_canonical_ingestion", _raise_transcript_unavailable)

    token = _mint()
    response = client.post("/v1/ingest", json=_valid_body(file_type="youtube"), headers=_auth(token))

    assert response.status_code == status.HTTP_502_BAD_GATEWAY, response.text
    assert response.status_code != status.HTTP_500_INTERNAL_SERVER_ERROR
    assert "transcript" in response.json()["detail"].lower()


def test_youtube_video_inaccessible_returns_controlled_502_not_500(client, monkeypatch):
    """VideoInaccessibleError (private/deleted/otherwise unreachable
    video) must ALSO become a controlled 502, never an unhandled 500 --
    Requirement 3 of this correction."""

    from app.models.exceptions import VideoInaccessibleError

    def _raise_video_inaccessible(job_id, url, settings):
        raise VideoInaccessibleError("YouTube video is inaccessible or could not be retrieved")

    monkeypatch.setattr(canonical_ingest_module, "extract_youtube_for_canonical_ingestion", _raise_video_inaccessible)

    token = _mint()
    response = client.post("/v1/ingest", json=_valid_body(file_type="youtube"), headers=_auth(token))

    assert response.status_code == status.HTTP_502_BAD_GATEWAY, response.text
    assert response.status_code != status.HTTP_500_INTERNAL_SERVER_ERROR


def test_youtube_transcript_unavailable_does_not_leak_a_python_traceback(client, monkeypatch):
    """The exact live symptom being corrected: previously this scenario
    produced FastAPI's generic unhandled-exception 500 -- confirms the
    response body is now the controlled, human-readable message, not a
    raw traceback/exception repr."""

    from app.models.exceptions import TranscriptUnavailableError

    monkeypatch.setattr(
        canonical_ingest_module,
        "extract_youtube_for_canonical_ingestion",
        lambda job_id, url, settings: (_ for _ in ()).throw(TranscriptUnavailableError("No transcript available for this video in language 'en'")),
    )

    token = _mint()
    response = client.post("/v1/ingest", json=_valid_body(file_type="youtube"), headers=_auth(token))

    body = response.json()
    assert "Traceback" not in json.dumps(body)
    assert body["detail"] == "No transcript available for this video in language 'en'"


def test_unexpected_exception_on_youtube_branch_still_behaves_as_before_this_correction(client, monkeypatch):
    """Requirement 5/9's own explicit boundary: an exception that is NOT
    TranscriptUnavailableError/VideoInaccessibleError must NOT be
    silently swallowed by the new except clauses -- it must still
    propagate exactly as it did before this correction (an unhandled
    500), since this task is scoped to only the two named, already-
    anticipated domain exceptions."""

    def _raise_unexpected(job_id, url, settings):
        raise RuntimeError("some genuinely unexpected internal failure")

    monkeypatch.setattr(canonical_ingest_module, "extract_youtube_for_canonical_ingestion", _raise_unexpected)

    token = _mint()
    with pytest.raises(RuntimeError):
        client.post("/v1/ingest", json=_valid_body(file_type="youtube"), headers=_auth(token))


def test_successful_youtube_ingestion_remains_unchanged_by_this_correction(client, monkeypatch):
    """Requirement 8's explicit regression case: a successful YouTube
    ingestion (no exception raised) must behave exactly as before --
    already covered by test_2_and_3 above, re-asserted here narrowly and
    explicitly for this correction's own record."""

    from app.models.schemas import ChunkMetadata, Chunk, EnrichedChunk
    from datetime import datetime, timezone

    fake_metadata = ChunkMetadata(
        chunk_id="chunk-youtube-1",
        source_type="pdf",
        job_id=f"canonical-{_TEST_DOCUMENT_ID}",
        ingestion_timestamp=datetime.now(timezone.utc),
        embedding_model="fake-model",
        embedding_model_version="fake-version",
        chunk_position=0,
        filename="fake.pdf",
        page_number=1,
    )
    fake_chunk = EnrichedChunk(chunk=Chunk(text="fake content", chunk_index=0, total_chunks=1), metadata=fake_metadata)

    monkeypatch.setattr(
        canonical_ingest_module,
        "extract_youtube_for_canonical_ingestion",
        lambda job_id, url, settings: ([fake_chunk], [[0.1] * 384]),
    )

    token = _mint()
    response = client.post("/v1/ingest", json=_valid_body(file_type="youtube"), headers=_auth(token))

    assert response.status_code == status.HTTP_202_ACCEPTED, response.text
    assert response.json()["status"] == "completed"


def test_pdf_branch_error_handling_remains_completely_unchanged(client, monkeypatch):
    """Requirement 8's explicit regression case: the PDF branch's own,
    pre-existing exception handling (TrustedOriginError -> 422) must be
    completely untouched by this YouTube-only correction."""

    from app.pipeline.remote_source_resolver import TrustedOriginError

    monkeypatch.setattr(
        canonical_ingest_module,
        "resolve_pdf_or_mp4_source",
        lambda url, ft, settings: (_ for _ in ()).throw(TrustedOriginError("file_url host is not on the trusted-origin allowlist")),
    )

    token = _mint()
    response = client.post("/v1/ingest", json=_valid_body(file_type="pdf"), headers=_auth(token))

    assert response.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT, response.text


def test_mp4_branch_error_handling_remains_completely_unchanged(client, monkeypatch):
    """Same as above, for the mp4 branch's RemoteFetchError -> 502
    handling -- explicitly re-verified untouched by this correction."""

    from app.pipeline.remote_source_resolver import RemoteFetchError

    monkeypatch.setattr(
        canonical_ingest_module,
        "resolve_pdf_or_mp4_source",
        lambda url, ft, settings: (_ for _ in ()).throw(RemoteFetchError("could not retrieve file_url")),
    )

    token = _mint()
    response = client.post("/v1/ingest", json=_valid_body(file_type="mp4"), headers=_auth(token))

    assert response.status_code == status.HTTP_502_BAD_GATEWAY, response.text


# ---------------------------------------------------------------------------
# STEP 1 REMEDIATION -- _ensure_local_demo_canonical_collection: the
# canonical-ingestion sibling of test_celery_app.py's own
# _ensure_local_demo_qdrant_collection tests, same fake-client convention
# (a fake exposing only the real qdrant_client.QdrantClient methods this
# function actually needs -- get_collections/create_collection/
# create_payload_index -- never Publisher's deliberately narrower
# upsert-only QdrantClientProtocol).
# ---------------------------------------------------------------------------


class _FakeCanonicalCollection:
    def __init__(self, name):
        self.name = name


class _FakeCanonicalCollectionsResponse:
    def __init__(self, names):
        self.collections = [_FakeCanonicalCollection(n) for n in names]


class _FakeCanonicalQdrantAdminClient:
    def __init__(self, existing_names=(), raise_on_get_collections=None):
        self.existing = set(existing_names)
        self.create_calls: list[tuple[str, object]] = []
        self.index_calls: list[tuple[str, str, object]] = []
        self.get_collections_calls = 0
        self._raise_on_get_collections = raise_on_get_collections

    def get_collections(self):
        self.get_collections_calls += 1
        if self._raise_on_get_collections is not None:
            raise self._raise_on_get_collections
        return _FakeCanonicalCollectionsResponse(self.existing)

    def create_collection(self, collection_name, vectors_config):
        self.create_calls.append((collection_name, vectors_config))
        self.existing.add(collection_name)

    def create_payload_index(self, collection_name, field_name, field_schema):
        self.index_calls.append((collection_name, field_name, field_schema))


@pytest.fixture(autouse=True)
def _reset_canonical_collection_ensured_flag():
    """The provisioning function caches success in a module-level flag
    (so it only round-trips to Qdrant once per process, not once per
    request) -- reset between tests so one test's success doesn't make
    the next test's "still needs provisioning" scenario silently skip
    the real check.
    """

    canonical_ingest_module._canonical_collection_ensured = False
    yield
    canonical_ingest_module._canonical_collection_ensured = False


def test_canonical_collection_already_exists_does_nothing():
    settings = Settings(canonical_qdrant_collection_name="educopilot_chunks", _env_file=None)
    client = _FakeCanonicalQdrantAdminClient(existing_names=["educopilot_chunks"])

    canonical_ingest_module._ensure_local_demo_canonical_collection(settings, client=client)

    assert client.create_calls == []
    assert client.get_collections_calls == 1


def test_canonical_collection_missing_is_created_with_payload_indexes():
    settings = Settings(canonical_qdrant_collection_name="educopilot_chunks", _env_file=None)
    client = _FakeCanonicalQdrantAdminClient(existing_names=[])

    canonical_ingest_module._ensure_local_demo_canonical_collection(settings, client=client)

    assert len(client.create_calls) == 1
    created_name, _vectors_config = client.create_calls[0]
    assert created_name == "educopilot_chunks"
    # All three payload indexes team4b/app/core/config.py documents as
    # required for this collection -- workspace_id, document_id,
    # ingestion_generation -- created, none skipped.
    indexed_fields = {field_name for _coll, field_name, _schema in client.index_calls}
    assert indexed_fields == {"workspace_id", "document_id", "ingestion_generation"}


def test_canonical_collection_uses_the_configured_embedding_dimensions_and_cosine_distance():
    from qdrant_client.models import Distance

    settings = Settings(
        canonical_qdrant_collection_name="educopilot_chunks",
        embedding_dimensions=384,
        _env_file=None,
    )
    client = _FakeCanonicalQdrantAdminClient(existing_names=[])

    canonical_ingest_module._ensure_local_demo_canonical_collection(settings, client=client)

    _name, vectors_config = client.create_calls[0]
    assert vectors_config.size == 384
    assert vectors_config.distance == Distance.COSINE


def test_canonical_collection_initialization_is_idempotent_across_repeated_calls():
    settings = Settings(canonical_qdrant_collection_name="educopilot_chunks", _env_file=None)
    client = _FakeCanonicalQdrantAdminClient(existing_names=[])

    canonical_ingest_module._ensure_local_demo_canonical_collection(settings, client=client)
    canonical_ingest_module._ensure_local_demo_canonical_collection(settings, client=client)
    canonical_ingest_module._ensure_local_demo_canonical_collection(settings, client=client)

    # The SECOND and THIRD calls don't even touch Qdrant -- the module-
    # level "already ensured" flag short-circuits them before
    # get_collections() is ever called again.
    assert len(client.create_calls) == 1
    assert client.get_collections_calls == 1


def test_canonical_collection_qdrant_temporarily_unavailable_does_not_raise():
    settings = Settings(canonical_qdrant_collection_name="educopilot_chunks", _env_file=None)
    client = _FakeCanonicalQdrantAdminClient(raise_on_get_collections=ConnectionError("simulated: Qdrant not ready yet"))

    canonical_ingest_module._ensure_local_demo_canonical_collection(settings, client=client)  # must not raise

    assert client.create_calls == []


def test_canonical_collection_failure_does_not_cache_the_ensured_flag_so_the_next_call_retries():
    settings = Settings(canonical_qdrant_collection_name="educopilot_chunks", _env_file=None)
    failing_client = _FakeCanonicalQdrantAdminClient(raise_on_get_collections=ConnectionError("simulated"))
    canonical_ingest_module._ensure_local_demo_canonical_collection(settings, client=failing_client)

    recovered_client = _FakeCanonicalQdrantAdminClient(existing_names=[])
    canonical_ingest_module._ensure_local_demo_canonical_collection(settings, client=recovered_client)

    assert len(recovered_client.create_calls) == 1, "a failed attempt must not block a later, successful retry"


def test_canonical_collection_warning_does_not_leak_connection_details(caplog):
    import logging

    settings = Settings(
        canonical_qdrant_collection_name="educopilot_chunks",
        qdrant_url="http://secret-internal-host:6333",
        qdrant_api_key="super-secret-key-12345",
        _env_file=None,
    )
    client = _FakeCanonicalQdrantAdminClient(
        raise_on_get_collections=ConnectionError("connect to super-secret-key-12345@secret-internal-host failed")
    )

    with caplog.at_level(logging.WARNING):
        canonical_ingest_module._ensure_local_demo_canonical_collection(settings, client=client)

    warning_text = "\n".join(record.getMessage() for record in caplog.records)
    assert "super-secret-key-12345" not in warning_text
    assert "secret-internal-host" not in warning_text


def test_get_canonical_orchestrator_calls_the_provisioning_check(monkeypatch):
    """The DI provider (get_canonical_orchestrator) -- constructed fresh
    on every request, no caching -- must invoke the provisioning check
    every time it's called; the check's OWN module-level flag is what
    keeps repeated Qdrant round-trips cheap, not the provider skipping
    the call outright.
    """

    calls = []
    monkeypatch.setattr(
        canonical_ingest_module,
        "_ensure_local_demo_canonical_collection",
        lambda settings, client=None: calls.append(settings.canonical_qdrant_collection_name),
    )
    # Avoid real Redis/Mongo connections for this narrow DI-wiring check --
    # MongoAuthorityClient's own __init__ subscripts the client twice
    # (mongo_client[db][collection]), so the fake must support that.
    monkeypatch.setattr("redis.Redis.from_url", lambda *_a, **_k: SimpleNamespace())
    fake_mongo_client = {"educopilot": {"files": SimpleNamespace()}}
    monkeypatch.setattr("pymongo.MongoClient", lambda *_a, **_k: fake_mongo_client)

    settings = Settings(_env_file=None)
    canonical_ingest_module.get_canonical_orchestrator(settings=settings)

    assert calls == [settings.canonical_qdrant_collection_name]
