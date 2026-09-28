import type { HydratedDocument } from "mongoose";

import { FileModel, type File as FileDoc } from "@/models/File";
import { mintLocalStorageRetrievalUrl } from "@/services/storage";
import { getTeamAService } from "@/services/teamA";
import { TeamASubmitError } from "@/services/teamA/client";
import { toCanonicalFileType } from "@/types/teamA";

/**
 * Stage 9 (Upload Reliability, Retry Safety, User-Friendly Errors).
 *
 * Extracted from app/api/workspaces/[id]/files/route.ts so the retry route
 * (app/api/workspaces/[id]/files/[fileId]/retry/route.ts) can reuse the
 * exact same hand-off logic rather than duplicating it — a retry IS just
 * another hand-off attempt for the same File, not a separate code path.
 */

export function serializeFile(file: HydratedDocument<FileDoc>) {
  return {
    id: file._id.toString(),
    originalName: file.originalName,
    type: file.type,
    status: file.status,
    processingError: file.processingError ?? null,
    storageUrl: file.storageUrl,
    createdAt: file.createdAt,
    sizeBytes: file.sizeBytes ?? null,
  };
}

/**
 * Maps an ingestion-hand-off failure to a single, fixed, actionable
 * message safe to show a user — NEVER the raw `error.message` (which,
 * for a `TeamASubmitError`, is only ever a bare HTTP status number today,
 * but is not a contract this function should depend on staying that way),
 * a stack trace, or any other backend-internal detail. Every branch here
 * is a hardcoded string; nothing from `error` is ever interpolated into
 * the returned message.
 *
 * Status codes matched to team4a/app/api/canonical_ingest.py's own
 * documented response contract: 409 (DocumentAlreadyLockedError — an
 * ingestion attempt is already in progress for this document), 404
 * (ABORTED_MISSING_FILE), 422 (untrusted/invalid file_url), 401/403 (the
 * internal service JWT was rejected — a configuration problem, not
 * something the end user caused or can fix by retrying differently), 502
 * (the source file/video could not be retrieved). Anything else
 * (unexpected status, a network-level failure with no status at all, a
 * non-`TeamASubmitError` exception) gets the same single generic fallback
 * — deliberately not enumerated further, since inventing a distinct
 * message per unknown case would risk leaking implementation detail
 * through word choice alone.
 */
export function describeIngestionFailure(error: unknown): string {
  if (error instanceof TeamASubmitError) {
    switch (error.status) {
      case 409:
        return "This file is already being processed. Please wait a moment, then refresh and try again.";
      case 404:
        return "We couldn't find your uploaded file to process it. Please try uploading it again.";
      case 422:
        return "This file's source could not be validated. Please check it and try again.";
      case 401:
      case 403:
        return "We couldn't authorize this upload right now. Please try again shortly.";
      case 502:
        return "We couldn't retrieve or process your file right now. Please try again in a few minutes.";
      default:
        return "Something went wrong while processing your file. Please try again.";
    }
  }
  return "Something went wrong while processing your file. Please try again.";
}

/**
 * Drives a File through the Team A hand-off (docs/decisions.md §6/§9):
 * submit → store ingestionId → check status → store the result. Uses
 * whichever implementation getTeamAService() currently resolves to (mock
 * by default) — this function has no idea, and doesn't need to, whether
 * it's talking to the mock or a real service.
 *
 * Runs synchronously within the calling request — the REAL canonical
 * `/v1/ingest` is itself synchronous (it runs the full pipeline to
 * completion before responding).
 *
 * Stage 9: also the RETRY mechanism — calling this again on a File whose
 * previous attempt failed re-mints a fresh retrieval URL and re-submits
 * with the SAME `document_id` (this File's own `_id`), never re-storing
 * bytes or creating a new File. Team A's own ingestion lock/generation
 * mechanism (team4a/app/pipeline/ingestion_lock.py) is what makes this
 * safe against duplicate ingestion — this function neither reimplements
 * nor weakens that; it just calls `/v1/ingest` again, exactly as a first
 * attempt would.
 *
 * CANONICAL CONTRACT (Phase 2A freeze, unchanged): `document_id` is this
 * File's own `_id`. `workspace_id`/`user_id` are NEVER part of the wire
 * body sent to `/v1/ingest` — they're wired in as the SEPARATE `context`
 * argument to `teamA.submit()`, used only to mint the internal service
 * JWT, never to populate the request body. `userId` here is the
 * authenticated session's own id; `file.workspaceId` must already have
 * been confirmed by the caller's own `assertOwnership()` call before this
 * function is ever invoked (Requirement 5).
 */
export async function handOffToTeamA(file: HydratedDocument<FileDoc>, userId: string): Promise<HydratedDocument<FileDoc>> {
  const teamA = getTeamAService();

  try {
    // MVP M6 correction (round 2): the URL sent to Team 4A is minted
    // fresh here, for THIS ingestion attempt only -- see
    // services/storage.ts's `mintLocalStorageRetrievalUrl` for why this
    // must be separate from `file.storageUrl` itself (which is
    // permanent, capability-free, and browser-session-protected for
    // citation clicks).
    const fileUrlForIngestion = await mintLocalStorageRetrievalUrl({
      storageUrl: file.storageUrl,
      storageProvider: file.storageProvider,
      publicId: file.publicId,
      workspaceId: file.workspaceId.toString(),
    });

    const { ingestionId } = await teamA.submit(
      {
        document_id: file._id.toString(),
        file_type: toCanonicalFileType(file.type),
        file_url: fileUrlForIngestion,
      },
      { sub: userId, workspace_id: file.workspaceId.toString() }
    );

    file.ingestionId = ingestionId;
    file.status = "processing";
    await file.save();

    const statusResult = await teamA.checkStatus(ingestionId);
    file.status = statusResult.status;
    // Stage 9: a "failed" outcome from checkStatus() gets the same safe,
    // fixed message as the catch block below, never `statusResult.error`
    // forwarded verbatim -- defense in depth, even though neither the
    // real nor the mock Team A client populates that field with anything
    // today.
    file.processingError = statusResult.status === "failed" ? describeIngestionFailure(undefined) : null;
    await file.save();
  } catch (error) {
    file.status = "failed";
    file.processingError = describeIngestionFailure(error);
    await file.save();
  }

  return file;
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === 11000;
}

export type ResolvedUploadedFile =
  | { conflict: true }
  | {
      conflict: false;
      file: HydratedDocument<FileDoc>;
      alreadyReady: boolean;
      /** True whenever an EXISTING File was found and reused (whether
       * already "ready" or "failed" and retried) — false only for a
       * genuinely new File. Callers use this to pick the HTTP status:
       * 200 for a reuse, 201 only for an actual creation. */
      reused: boolean;
    };

/**
 * Stage 9 — resolves the File a single upload request should hand off to
 * Team A: reuses an existing attempt (by `uploadIdempotencyKey`, the
 * SAME key across every retry of one logical upload — see File.ts's own
 * doc comment) when one is found, or creates a brand-new File via
 * `createFile()` otherwise.
 *
 * This is the actual duplicate-prevention mechanism (Requirement 3): a
 * retry whose earlier response the client never received (a network
 * failure with a genuinely ambiguous outcome) sends the SAME
 * `uploadIdempotencyKey` again, and this function tells the caller
 * exactly what already happened, instead of blindly creating a second
 * File + re-storing a second copy of the same bytes:
 *   - existing "ready"      -> already fully succeeded; reuse as-is.
 *   - existing "failed"     -> reuse the SAME File for a fresh
 *     handOffToTeamA() attempt (never re-stores bytes, never creates a
 *     second File).
 *   - existing "uploading"/"processing" -> `{conflict: true}` — a
 *     genuinely concurrent duplicate submission (Requirement 5); the
 *     caller returns 409 without touching anything.
 *   - no existing match     -> calls `createFile()`; if that itself
 *     races another request with the same key (the unique+sparse index
 *     rejects the second insert with a MongoDB duplicate-key error),
 *     re-reads and treats it exactly like an "existing" match instead of
 *     surfacing a raw 500.
 *
 * When `uploadIdempotencyKey` is omitted entirely (never sent — should
 * not happen from this project's own, updated upload UI, but this
 * function makes no assumption about every caller), this is a pure
 * pass-through to `createFile()` — the exact pre-Stage-9 behavior.
 */
export async function resolveUploadedFile(
  workspaceId: string,
  uploadIdempotencyKey: string | undefined,
  createFile: () => Promise<HydratedDocument<FileDoc>>
): Promise<ResolvedUploadedFile> {
  if (uploadIdempotencyKey) {
    const existing = await FileModel.findOne({ workspaceId, uploadIdempotencyKey });
    if (existing) {
      return resolveExistingAttempt(existing);
    }
  }

  try {
    const file = await createFile();
    return { conflict: false, file, alreadyReady: false, reused: false };
  } catch (error) {
    if (uploadIdempotencyKey && isDuplicateKeyError(error)) {
      const existing = await FileModel.findOne({ workspaceId, uploadIdempotencyKey });
      if (existing) {
        return resolveExistingAttempt(existing);
      }
    }
    throw error;
  }
}

function resolveExistingAttempt(existing: HydratedDocument<FileDoc>): ResolvedUploadedFile {
  if (existing.status === "uploading" || existing.status === "processing") {
    return { conflict: true };
  }
  // "ready" -> alreadyReady: true (caller returns it as-is, no re-hand-off).
  // "failed" -> alreadyReady: false (caller re-runs handOffToTeamA on it).
  return { conflict: false, file: existing, alreadyReady: existing.status === "ready", reused: true };
}
