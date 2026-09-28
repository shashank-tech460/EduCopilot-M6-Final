"""Phase 1 -- the two Qdrant delete operations Rev.4.4 permits, and only those two.

Deliberately separate from `app/pipeline/publisher.py`: `Publisher` itself is
frozen, existing, tested code whose own contract (`upsert`-only, via
`QdrantClientProtocol`) is untouched by Phase 1. Delete is a new capability
this phase introduces, used exclusively by the canonical-ingestion
orchestrator (`canonical_ingestion.py`), never by the legacy Celery tasks.

Exactly two delete shapes exist, matching Rev.4.4 precisely -- no others:

  1. `delete_exact_points` -- delete a specific, known set of point IDs.
     Always safe by construction: a worker can only ever pass IDs it
     itself computed from its own chunk_ids, so this can never touch
     another attempt's data regardless of any filter logic.
     (Rev.4.4 §8.2.2.2 -- the completion-time-claim-failure self-heal.)

  2. `delete_older_generations` -- delete every point for one `document_id`
     whose `ingestion_generation` is strictly LESS THAN the caller's own,
     now-authoritative generation. This is the corrected, monotonic filter
     (`<`, never `!=`) -- a chunk at the caller's own generation or any
     higher generation can never match this filter, regardless of when it
     executes, because that is a static, arithmetic property of the filter
     expression itself, not a claim that depends on execution ordering.
     (Rev.4.4 §8.2.2.3 -- the confirmed winner's housekeeping cleanup.)
"""

from __future__ import annotations

import logging
from contextlib import contextmanager
from typing import Any, Iterator, Protocol, Sequence

logger = logging.getLogger(__name__)


@contextmanager
def _tolerate_missing_collection(collection_name: str) -> Iterator[None]:
    """STEP 1 REMEDIATION: a delete call against a collection that does
    not exist (yet) has nothing to delete -- Qdrant reports this as an
    HTTP 404 `UnexpectedResponse`, which previously propagated uncaught
    and crashed the caller (see `canonical_ingestion.py`'s self-heal
    path, called after a publish failure -- if the publish failed
    because the canonical collection didn't exist yet, the self-heal
    cleanup for the zero points that were ever actually published hit
    the SAME missing-collection 404, unhandled, masking the real
    publish failure behind a bare, undiagnosable 500).

    Only a 404 is swallowed -- any other status (auth failure, a
    genuine server error, a malformed request) still propagates
    unchanged, so a real problem is never silently hidden alongside
    this one, narrow, well-understood case.
    """

    from qdrant_client.http.exceptions import UnexpectedResponse

    try:
        yield
    except UnexpectedResponse as exc:
        if exc.status_code == 404:
            logger.info(
                "Delete against a not-yet-existing collection -- nothing to delete",
                extra={"collection": collection_name},
            )
            return
        raise


class QdrantMutationClientProtocol(Protocol):
    """The minimal interface these two operations need from a Qdrant client.

    A real implementation (`RealQdrantMutationClient`, below) and a fake,
    in-memory test double both satisfy this Protocol -- unit tests never
    require a live Qdrant server, matching the existing convention already
    used for `Publisher`/`QdrantClientProtocol`.
    """

    def delete_points_by_id(self, collection_name: str, point_ids: Sequence[str]) -> None: ...

    def delete_points_by_generation_filter(
        self, collection_name: str, document_id: str, less_than_generation: int
    ) -> None: ...


class RealQdrantMutationClient:
    """Real qdrant-client integration for the two delete shapes above.

    Same lazy-construction pattern as `Publisher.RealQdrantClient`: the
    `qdrant_client` package and connection are only touched inside the
    methods below, never at import time or at `__init__`.
    """

    def __init__(self, url: str, api_key: str | None) -> None:
        self._url = url
        self._api_key = api_key
        self._client: Any = None

    def _ensure_client(self) -> Any:
        if self._client is None:
            from qdrant_client import QdrantClient

            self._client = QdrantClient(url=self._url, api_key=self._api_key, check_compatibility=False)
        return self._client

    def delete_points_by_id(self, collection_name: str, point_ids: Sequence[str]) -> None:
        from qdrant_client.models import PointIdsList

        client = self._ensure_client()
        with _tolerate_missing_collection(collection_name):
            client.delete(collection_name=collection_name, points_selector=PointIdsList(points=list(point_ids)))

    def delete_points_by_generation_filter(
        self, collection_name: str, document_id: str, less_than_generation: int
    ) -> None:
        from qdrant_client.models import FieldCondition, Filter, FilterSelector, MatchValue, Range

        client = self._ensure_client()
        with _tolerate_missing_collection(collection_name):
            client.delete(
                collection_name=collection_name,
                points_selector=FilterSelector(
                    filter=Filter(
                        must=[
                            FieldCondition(key="document_id", match=MatchValue(value=document_id)),
                            # Strictly "<" only -- Range's `lt` param, never `ne`/"!=".
                            # This is the corrected, monotonic filter (Rev.4.4 §8.2.2.3):
                            # a point at `less_than_generation` or higher can never
                            # match `lt=less_than_generation`, as a static property of
                            # the comparison itself, regardless of execution timing.
                            FieldCondition(
                                key="ingestion_generation",
                                range=Range(lt=less_than_generation),
                            ),
                        ]
                    )
                ),
            )


def delete_exact_points(
    client: QdrantMutationClientProtocol, collection_name: str, point_ids: Sequence[str]
) -> None:
    """Self-heal path (Rev.4.4 §8.2.2.2): delete exactly the points a worker
    itself just published, after its completion-time Mongo claim failed.

    Never a filter, never a range -- exact IDs the caller already computed
    from its own chunk_ids via `app.pipeline.publisher.chunk_id_to_point_id`.
    """

    if not point_ids:
        return
    logger.warning(
        "Self-heal: deleting points from a lost-authority ingestion attempt",
        extra={"collection": collection_name, "point_count": len(point_ids)},
    )
    client.delete_points_by_id(collection_name, point_ids)


def delete_older_generations(
    client: QdrantMutationClientProtocol,
    collection_name: str,
    document_id: str,
    current_generation: int,
) -> None:
    """Housekeeping cleanup (Rev.4.4 §8.2.2.3): remove every chunk for
    `document_id` whose `ingestion_generation` is strictly less than
    `current_generation` -- the now-confirmed-authoritative generation.

    MUST be called only after the caller's own completion-time Mongo claim
    has already succeeded for `current_generation` (see
    `canonical_ingestion.py`) -- this function performs no authority check
    of its own, by design: it is pure physical housekeeping, not a
    correctness-critical step (Rev.4.4's governing principle: correctness
    is provided by 4B's retrieval-side Generation Authority Filter,
    independent of when, or whether, this cleanup ever runs).
    """

    logger.info(
        "Cleaning up superseded generations",
        extra={"collection": collection_name, "document_id": document_id, "current_generation": current_generation},
    )
    client.delete_points_by_generation_filter(collection_name, document_id, less_than_generation=current_generation)
