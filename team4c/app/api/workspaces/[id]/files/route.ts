import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { connectToDatabase } from "@/lib/mongodb";
import { assertOwnership, OwnershipError } from "@/lib/ownership";
import { handOffToTeamA, resolveUploadedFile, serializeFile } from "@/lib/ingestion";
import { FileModel } from "@/models/File";
import { validateUploadedFile, validateYoutubeUrl } from "@/lib/validation";
import { storeFile, referenceYoutubeUrl } from "@/services/storage";

/** A blank/whitespace-only value is treated the same as "not sent" — the
 * upload UI always sends a real crypto.randomUUID(), so this only ever
 * matters for a malformed/manual request. */
function readIdempotencyKey(formData: FormData): string | undefined {
  const value = formData.get("uploadIdempotencyKey");
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * GET /api/workspaces/[id]/files — materials belonging to this workspace,
 * only if the requester owns it.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const { id: workspaceId } = await params;

  await connectToDatabase();

  try {
    await assertOwnership(workspaceId, session.user.id);
  } catch (error) {
    if (error instanceof OwnershipError) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    throw error;
  }

  const files = await FileModel.find({ workspaceId }).sort({ createdAt: -1 });

  return NextResponse.json(files.map(serializeFile));
}

/**
 * POST /api/workspaces/[id]/files — upload a PDF/MP4, or register a
 * YouTube URL, into this workspace.
 *
 * Accepts multipart/form-data with a `type` field ("pdf" | "video" |
 * "youtube_url") plus either a `file` field (pdf/video) or a `youtubeUrl`
 * field. A single uniform request shape for all three material types keeps
 * the client and this route simple, rather than branching on Content-Type.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const { id: workspaceId } = await params;

  await connectToDatabase();

  try {
    await assertOwnership(workspaceId, session.user.id);
  } catch (error) {
    if (error instanceof OwnershipError) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    throw error;
  }

  const formData = await request.formData().catch(() => null);
  if (!formData) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const materialType = formData.get("type");
  const idempotencyKey = readIdempotencyKey(formData);

  if (materialType === "youtube_url") {
    const url = formData.get("youtubeUrl");
    const { valid, error } = validateYoutubeUrl(url);

    if (!valid || typeof url !== "string") {
      return NextResponse.json({ error }, { status: 400 });
    }

    // Stage 9: `storeFile`/`referenceYoutubeUrl` only ever run INSIDE this
    // closure, which `resolveUploadedFile` only calls when no existing
    // attempt for this exact `uploadIdempotencyKey` was found — a retry
    // of an ambiguous-outcome request never re-registers/re-stores.
    const resolved = await resolveUploadedFile(workspaceId, idempotencyKey, async () => {
      const stored = referenceYoutubeUrl(url.trim());
      return FileModel.create({
        workspaceId,
        userId: session.user.id,
        originalName: url.trim(),
        type: "youtube_url",
        storageUrl: stored.storageUrl,
        storageProvider: stored.storageProvider,
        status: "uploading",
        uploadIdempotencyKey: idempotencyKey,
      });
    });

    if (resolved.conflict) {
      return NextResponse.json(
        { error: "This upload is already in progress. Please wait a moment before trying again." },
        { status: 409 }
      );
    }

    const finished = resolved.alreadyReady ? resolved.file : await handOffToTeamA(resolved.file, session.user.id);
    return NextResponse.json(serializeFile(finished), { status: resolved.reused ? 200 : 201 });
  }

  if (materialType === "pdf" || materialType === "video") {
    const uploaded = formData.get("file");
    const { valid, error } = validateUploadedFile(uploaded, materialType);

    if (!valid || !(uploaded instanceof globalThis.File)) {
      return NextResponse.json({ error }, { status: 400 });
    }

    // Stage 9: `storeFile()` (the actual byte-storage write) only ever
    // runs INSIDE this closure, which `resolveUploadedFile` only invokes
    // when no existing File already matches this `uploadIdempotencyKey`
    // — a retry whose earlier response the client never received (e.g.
    // a dropped connection AFTER the server had already stored the bytes
    // and created the File) is recognized by key and reused instead of
    // storing a second copy of the same content under a second File
    // document (Requirement 3).
    const resolved = await resolveUploadedFile(workspaceId, idempotencyKey, async () => {
      const stored = await storeFile(uploaded, workspaceId);
      return FileModel.create({
        workspaceId,
        userId: session.user.id,
        originalName: uploaded.name,
        type: materialType,
        storageUrl: stored.storageUrl,
        storageProvider: stored.storageProvider,
        publicId: stored.publicId,
        status: "uploading",
        sizeBytes: uploaded.size,
        uploadIdempotencyKey: idempotencyKey,
      });
    });

    if (resolved.conflict) {
      return NextResponse.json(
        { error: "This upload is already in progress. Please wait a moment before trying again." },
        { status: 409 }
      );
    }

    const finished = resolved.alreadyReady ? resolved.file : await handOffToTeamA(resolved.file, session.user.id);
    return NextResponse.json(serializeFile(finished), { status: resolved.reused ? 200 : 201 });
  }

  return NextResponse.json({ error: "Unsupported material type." }, { status: 400 });
}
