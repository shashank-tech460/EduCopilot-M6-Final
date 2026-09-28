"""Security Hardening Stage 1 -- the shared internal-service-JWT FastAPI
dependency, extracted from `app.api.canonical_ingest` (Phase 2C) so it can
also gate the legacy `/ingest/pdf`, `/ingest/video`, `/ingest/youtube`, and
`/jobs/*` routes in `app.api.routes` (previously entirely unauthenticated
-- see that module's own docstring for why).

Pure extraction, no behavior change: `get_service_jwt_verifier` and
`require_ingest_identity` are byte-for-byte the same functions
`canonical_ingest.py` already defined and every existing test already
exercises (that module now imports them from here instead of defining
them inline, so `app.api.canonical_ingest.get_service_jwt_verifier`
still resolves to this exact function object -- existing tests using
`app.dependency_overrides[get_service_jwt_verifier]` via that import
path are unaffected). Mirrors Team 4B's own `app/api/auth_dependency.py`
naming/shape for the same concept, kept deliberately separate per-service
(different audience/scope space, no shared verifier instance).
"""

from __future__ import annotations

import logging

from fastapi import Depends, HTTPException, Request, status

from app.config.settings import Settings, get_settings
from app.security.service_jwt import (
    ServiceIdentity,
    ServiceJWTVerifier,
    ServiceTokenError,
    load_public_keys_json,
)

logger = logging.getLogger(__name__)

_BEARER_PREFIX = "Bearer "
_AUTH_FAILURE_DETAIL = "Invalid or missing authentication."


def get_service_jwt_verifier(settings: Settings = Depends(get_settings)) -> ServiceJWTVerifier:
    public_keys = load_public_keys_json(settings.service_jwt_public_keys_json)
    return ServiceJWTVerifier(
        public_keys_by_kid=public_keys,
        expected_issuer=settings.service_jwt_expected_issuer,
        expected_audience=settings.service_jwt_expected_audience,
        required_scope=settings.service_jwt_required_scope,
        clock_skew_seconds=settings.service_jwt_clock_skew_seconds,
    )


def require_ingest_identity(
    request: Request,
    verifier: ServiceJWTVerifier = Depends(get_service_jwt_verifier),
) -> ServiceIdentity:
    auth_header = request.headers.get("authorization")
    if not auth_header or not auth_header.startswith(_BEARER_PREFIX):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=_AUTH_FAILURE_DETAIL)

    token = auth_header[len(_BEARER_PREFIX) :].strip()
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=_AUTH_FAILURE_DETAIL)

    try:
        return verifier.verify(token)
    except ServiceTokenError as exc:
        logger.warning(
            "Internal service JWT verification failed",
            extra={"failure_category": "service_jwt_verification", "path": request.url.path},
        )
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=_AUTH_FAILURE_DETAIL) from exc
