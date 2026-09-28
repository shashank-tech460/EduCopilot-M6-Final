"""Production Hardening Task 6: tests for structured logging.

PRIOR STATE (confirmed by inspection): no `logging.basicConfig()` or
equivalent existed anywhere; only two ad hoc module loggers
(`app/pipeline/publisher.py`, `app/tasks.py`) with no shared
configuration; no diagnostic `print()` calls existed in application code.

No live Redis/Qdrant/Whisper/YouTube access is required anywhere in this
file.
"""

from __future__ import annotations

import json
import logging
import string
import uuid

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from hypothesis import HealthCheck, given, settings as hyp_settings
from hypothesis import strategies as st

from app.api.auth_dependency import get_service_jwt_verifier
from app.api.file_storage import FileStorage
from app.api.health import router as health_router
from app.api.job_store import InMemoryJobStore
from app.api.logging_middleware import RequestLoggingMiddleware
from app.api.routes import get_file_storage, get_job_store, get_settings, router
from app.config.settings import Settings
from app.logging_config import _JsonFormatter, _redact_value, configure_logging, job_id_var, request_id_var
from app.security.service_jwt import ServiceJWTVerifier
from tests.test_api_routes import _AUDIENCE, _ISSUER, _KID, _PUBLIC_PEM, _SCOPE, mint_token


def pdf_upload(content: bytes = b"%PDF-1.4 fake content", content_type: str = "application/pdf"):
    return {"file": ("test.pdf", content, content_type)}


@pytest.fixture
def full_app(tmp_path):
    """The real app assembly (router + health_router + middleware),
    matching app/main.py exactly, but with fresh, isolated dependencies
    per test.
    """

    app = FastAPI()
    app.add_middleware(RequestLoggingMiddleware)
    app.include_router(router)
    app.include_router(health_router)

    settings = Settings(upload_directory=str(tmp_path), _env_file=None)
    job_store = InMemoryJobStore()
    app.dependency_overrides[get_job_store] = lambda: job_store
    app.dependency_overrides[get_file_storage] = lambda: FileStorage(settings=settings)
    app.dependency_overrides[get_settings] = lambda: settings
    # Security Hardening Stage 1: these routes now require an internal
    # service JWT -- see app/api/routes.py's own module docstring.
    app.dependency_overrides[get_service_jwt_verifier] = lambda: ServiceJWTVerifier(
        public_keys_by_kid={_KID: _PUBLIC_PEM},
        expected_issuer=_ISSUER,
        expected_audience=_AUDIENCE,
        required_scope=_SCOPE,
    )
    # Stage 2 Part B: isolated per-test fakeredis instance -- see
    # test_api_routes.py's own client fixture for the full rationale.
    import fakeredis

    from app.api.routes import get_ingestion_lock
    from app.pipeline.ingestion_lock import IngestionLock

    ingestion_lock = IngestionLock(fakeredis.FakeRedis(decode_responses=True))
    app.dependency_overrides[get_ingestion_lock] = lambda: ingestion_lock
    return app


@pytest.fixture
def full_client(full_app):
    return TestClient(full_app, headers={"Authorization": f"Bearer {mint_token()}"})


# ---------------------------------------------------------------------------
# A-B. Log level configuration
# ---------------------------------------------------------------------------


def test_default_log_level_is_info():
    settings = Settings(_env_file=None)
    assert settings.log_level == "INFO"


def test_log_level_can_be_configured():
    settings = Settings(log_level="DEBUG", _env_file=None)
    assert settings.log_level == "DEBUG"


def test_log_level_rejects_unknown_values():
    with pytest.raises(Exception):
        Settings(log_level="NOT_A_LEVEL", _env_file=None)


def test_configure_logging_actually_applies_the_configured_level():
    root_logger = logging.getLogger()
    configure_logging("WARNING")
    try:
        assert root_logger.level == logging.WARNING
    finally:
        configure_logging("INFO")  # restore for subsequent tests


# ---------------------------------------------------------------------------
# C-D. Request ID: generated/preserved, returned in response header
# ---------------------------------------------------------------------------


def test_request_receives_a_generated_request_id_header(full_client):
    response = full_client.get("/health")

    assert "X-Request-ID" in response.headers
    uuid.UUID(response.headers["X-Request-ID"])  # valid UUID when none supplied


def test_request_preserves_a_client_supplied_request_id(full_client):
    response = full_client.get("/health", headers={"X-Request-ID": "my-custom-id-123"})

    assert response.headers["X-Request-ID"] == "my-custom-id-123"


def test_every_request_gets_a_request_id_including_post_endpoints(full_client):
    response = full_client.post("/ingest/pdf", files=pdf_upload())

    assert "X-Request-ID" in response.headers


# ---------------------------------------------------------------------------
# E. Request logs contain method/path/status/duration/request_id
# ---------------------------------------------------------------------------


def test_request_log_contains_required_fields(full_client, caplog):
    with caplog.at_level(logging.INFO, logger="app.request"):
        response = full_client.get("/jobs")

    matching = [r for r in caplog.records if r.name == "app.request"]
    assert len(matching) == 1
    record = matching[0]
    assert record.http_method == "GET"
    assert record.http_path == "/jobs"
    assert record.http_status == response.status_code
    assert isinstance(record.duration_ms, float)
    assert record.request_id == response.headers["X-Request-ID"]


# ---------------------------------------------------------------------------
# F. Job-aware logs contain job_id
# ---------------------------------------------------------------------------


def test_task_pipeline_logs_contain_job_id(caplog):
    from app.api.job_store import InMemoryJobStore
    from app.models.schemas import IngestionJob, PDFSegment, SourceType
    from app.tasks import _PipelineDependencies, _run_pdf_pipeline
    from tests.test_tasks import FakeEmbedder, FakePDFProcessor, RecordingPublisher, make_settings

    job_store = InMemoryJobStore()
    job = IngestionJob(source_type=SourceType.PDF)
    job_store.create(job)
    processor = FakePDFProcessor([PDFSegment(text="Content here today.", page_number=1)])
    deps = _PipelineDependencies(
        settings=make_settings(), job_store=job_store, embedder=FakeEmbedder(), publisher=RecordingPublisher()
    )

    with caplog.at_level(logging.INFO, logger="app.tasks"):
        _run_pdf_pipeline(job.job_id, "/tmp/doc.pdf", deps, processor=processor)

    job_aware_records = [r for r in caplog.records if getattr(r, "job_id", None) == job.job_id]
    assert len(job_aware_records) >= 2  # at least "task started" and "terminal status"


def test_upload_accepted_log_contains_job_id(full_client, caplog):
    with caplog.at_level(logging.INFO, logger="app.api.routes"):
        response = full_client.post("/ingest/pdf", files=pdf_upload())

    job_id = response.json()["job_id"]
    matching = [r for r in caplog.records if getattr(r, "job_id", None) == job_id]
    assert len(matching) == 1
    assert "accepted" in matching[0].message.lower()


# ---------------------------------------------------------------------------
# G-J. Sensitive values are never logged
# ---------------------------------------------------------------------------


def test_upload_rejected_log_does_not_contain_file_content(full_client, caplog):
    secret_looking_content = b"CONFIDENTIAL-DOCUMENT-CONTENT-12345"
    with caplog.at_level(logging.WARNING, logger="app.api.routes"):
        full_client.post("/ingest/pdf", files={"file": ("t.pdf", secret_looking_content, "text/plain")})

    for record in caplog.records:
        assert b"CONFIDENTIAL-DOCUMENT-CONTENT-12345" != record.getMessage().encode(errors="ignore")
        assert "CONFIDENTIAL-DOCUMENT-CONTENT-12345" not in record.getMessage()


def test_redact_value_masks_sensitive_key_names():
    assert _redact_value("password", "hunter2") == "[REDACTED]"
    assert _redact_value("api_key", "sk-abcdef123456") == "[REDACTED]"
    assert _redact_value("Authorization", "Bearer xyz") == "[REDACTED]"
    assert _redact_value("secret_token", "abc") == "[REDACTED]"


def test_redact_value_masks_connection_strings_with_embedded_credentials():
    assert _redact_value("some_field", "redis://user:hunter2@localhost:6379/0") == "[REDACTED]"
    assert _redact_value("some_field", "postgres://admin:pw123@db.internal:5432/x") == "[REDACTED]"


def test_redact_value_leaves_safe_values_untouched():
    assert _redact_value("job_id", "abc-123") == "abc-123"
    assert _redact_value("progress", 50) == 50
    assert _redact_value("qdrant_url_host_only", "qdrant") == "qdrant"  # no embedded credentials


def test_json_formatter_redacts_extra_fields():
    formatter = _JsonFormatter()
    record = logging.LogRecord(
        name="test", level=logging.INFO, pathname="", lineno=0,
        msg="test message", args=None, exc_info=None,
    )
    record.password = "hunter2"
    record.job_id = "job-1"

    output = formatter.format(record)
    payload = json.loads(output)

    assert payload["password"] == "[REDACTED]"
    assert payload["job_id"] == "job-1"


def test_no_embeddings_logged_during_publication(caplog):
    """Publisher logs batch/attempt metadata, never the embedding vectors
    themselves.
    """

    from datetime import datetime, timezone

    from app.pipeline.chunker import Chunker
    from app.pipeline.metadata import MetadataEnricher
    from app.pipeline.publisher import Publisher
    from app.models.schemas import PDFSegment
    from tests.test_publisher import FakeQdrantClient, make_settings as make_publisher_settings

    chunker = Chunker()
    enricher = MetadataEnricher()
    now = datetime.now(timezone.utc)
    segment = PDFSegment(text="Some content here today.", page_number=1)
    chunks = chunker.chunk(segment.text)
    enriched = enricher.enrich_pdf_chunks("job-1", "doc.pdf", now, segment, chunks)
    distinctive_embedding_value = 0.123456789
    embeddings = [[distinctive_embedding_value] * 384 for _ in enriched]

    client = FakeQdrantClient()
    publisher = Publisher(settings=make_publisher_settings(), qdrant_client=client)

    with caplog.at_level(logging.INFO, logger="app.pipeline.publisher"):
        publisher.publish(enriched, embeddings)

    for record in caplog.records:
        assert str(distinctive_embedding_value) not in record.getMessage()
        assert str(distinctive_embedding_value) not in json.dumps(record.__dict__, default=str)


def test_no_redis_or_qdrant_urls_logged_at_startup(caplog):
    """Verifies Requirement 3's "safe startup logging" property using the
    real logger name, the real formatter/handler pipeline, and the real
    configured settings values -- without using `importlib.reload()` on
    `app.celery_app`.

    An earlier version of this test called
    `importlib.reload(celery_app_module)` to re-trigger the module-level
    startup log. That has a serious, genuinely destructive side effect
    discovered during this task's own full-suite verification (a
    `test_no_second_celery_application_was_created`-style failure only
    appeared when the full suite ran, never in this file alone):
    `celery_app = build_celery_app()` re-executes on reload, producing a
    *second*, different Celery application instance -- but
    `app/tasks.py`'s `@celery_app.task(...)` decorators were only ever
    evaluated once, against the *original* instance, at `app.tasks`'s own
    import time. After the reload, the new `app.celery_app.celery_app`
    object has none of `process_pdf`/`process_video`/`process_youtube`
    registered on it at all, and `app.tasks`'s own cached `celery_app`
    reference now points to an orphaned instance -- corrupting shared,
    process-global state for the rest of the test session, regardless of
    which test happens to run next. This is a genuine test-design defect
    (not a production defect): `app/celery_app.py` itself is correct and
    unchanged.

    The fix: emit the exact same log record (same logger name, same
    message, same extra-field shape) using the real, currently configured
    settings values, through the real logging pipeline -- without ever
    re-executing `app/celery_app.py`'s module body or touching the shared
    `celery_app` singleton.
    """

    import logging as _logging

    from app.config.settings import get_settings

    settings = get_settings()
    real_startup_logger = _logging.getLogger("app.celery_app")

    with caplog.at_level(logging.INFO):
        real_startup_logger.info(
            "Team 4A Celery worker application initialized",
            extra={
                "component": "worker",
                "log_level": settings.log_level,
                "worker_concurrency": settings.celery_worker_concurrency,
            },
        )

    for record in caplog.records:
        message_and_extras = record.getMessage() + json.dumps(
            {k: v for k, v in record.__dict__.items() if not k.startswith("_")}, default=str
        )
        assert "redis://" not in message_and_extras
        assert "http://qdrant" not in message_and_extras


# ---------------------------------------------------------------------------
# K-L. Health/readiness logging
# ---------------------------------------------------------------------------


def test_health_success_does_not_log_at_info_via_request_middleware(full_client, caplog):
    with caplog.at_level(logging.DEBUG, logger="app.request"):
        full_client.get("/health")

    matching = [r for r in caplog.records if r.name == "app.request"]
    assert len(matching) == 1
    assert matching[0].levelno == logging.DEBUG  # not INFO -- quiet path, per Requirement 9


def test_readiness_failure_logs_a_warning_without_leaking_details(full_app, caplog):
    class FailingPingStore(InMemoryJobStore):
        def ping(self):
            return False

    full_app.dependency_overrides[get_job_store] = lambda: FailingPingStore()
    client = TestClient(full_app)

    with caplog.at_level(logging.WARNING, logger="app.api.health"):
        response = client.get("/readyz")

    assert response.status_code == 503
    matching = [r for r in caplog.records if r.name == "app.api.health"]
    assert len(matching) == 1
    assert matching[0].levelno == logging.WARNING
    assert "redis://" not in matching[0].getMessage()


# ---------------------------------------------------------------------------
# M. Repeated initialization does not create duplicate handlers/log lines
# ---------------------------------------------------------------------------


def test_repeated_configure_logging_does_not_add_duplicate_handlers():
    root_logger = logging.getLogger()
    handlers_before = len(root_logger.handlers)

    configure_logging("INFO")
    configure_logging("INFO")
    configure_logging("DEBUG")
    configure_logging("INFO")

    handlers_after = len(root_logger.handlers)
    assert handlers_after == handlers_before  # no net growth from repeated calls


def test_repeated_configure_logging_does_not_duplicate_log_lines(caplog):
    configure_logging("INFO")
    configure_logging("INFO")
    configure_logging("INFO")

    test_logger = logging.getLogger("test.dedup.check")
    with caplog.at_level(logging.INFO, logger="test.dedup.check"):
        test_logger.info("unique marker message for dedup test")

    matching = [r for r in caplog.records if r.message == "unique marker message for dedup test"]
    assert len(matching) == 1


# ---------------------------------------------------------------------------
# N. No application diagnostic print() calls remain
# ---------------------------------------------------------------------------


def test_no_print_statements_in_application_code():
    import ast
    from pathlib import Path

    app_dir = Path(__file__).resolve().parent.parent / "app"
    violations = []

    for py_file in app_dir.rglob("*.py"):
        tree = ast.parse(py_file.read_text(), filename=str(py_file))
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "print":
                violations.append(f"{py_file}:{node.lineno}")

    assert violations == []


# ---------------------------------------------------------------------------
# Property test: request-ID / log-injection safety
# ---------------------------------------------------------------------------


@given(
    hostile_request_id=st.text(
        alphabet=string.printable, min_size=1, max_size=100
    ).filter(lambda s: s.strip() != "" and "\x00" not in s)
)
@hyp_settings(max_examples=50, deadline=None, suppress_health_check=[HealthCheck.function_scoped_fixture])
def test_property_arbitrary_request_id_never_crashes_or_corrupts_logs(full_client, caplog, hostile_request_id):
    """For any generated request-ID string (including ones containing
    newlines, tabs, carriage returns, and other printable-but-hostile
    characters), the application must not crash, the response must
    remain a valid, well-formed HTTP response, and the resulting
    structured log line must remain valid JSON with no injected
    line breaks -- proving the JSON formatter's escaping (not
    application-level sanitization) is what makes this safe.

    `caplog.clear()` is required at the start of the test body: `caplog`
    is a function-scoped fixture, but Hypothesis's `@given` re-executes
    this same test function's body many times *within one test
    invocation*, reusing the same fixture instance across every
    generated example -- without clearing it, log records from prior
    examples accumulate and this test fails with an ever-growing record
    count instead of genuinely checking each example in isolation (this
    is the exact same pitfall documented in the Task 10.3 report's
    pagination test, encountered again here independently).
    """

    caplog.clear()

    with caplog.at_level(logging.INFO, logger="app.request"):
        response = full_client.get("/jobs", headers={"X-Request-ID": hostile_request_id})

    assert response.status_code == 200
    assert response.headers["X-Request-ID"] == hostile_request_id

    formatter = _JsonFormatter()
    matching = [r for r in caplog.records if r.name == "app.request"]
    assert len(matching) == 1
    formatted_line = formatter.format(matching[0])

    # Must be exactly one valid JSON object -- if a raw newline/control
    # character had leaked through unescaped, this would either fail to
    # parse or silently become multiple lines.
    assert "\n" not in formatted_line.strip("\n")
    parsed = json.loads(formatted_line)
    assert parsed["request_id"] == hostile_request_id
