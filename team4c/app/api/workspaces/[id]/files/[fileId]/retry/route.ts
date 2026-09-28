import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { auth } from "@/lib/auth";
import { connectToDatabase } from "@/lib/mongodb";
import { assertOwnership, OwnershipError } from "@/lib/ownership";
import { handOffToTeamA, serializeFile } from "@/lib/ingestion";
import { FileModel } from "@/models/File";

/**
 * POST /api/workspaces/[id]/files/[fileId]/retry — Stage 9.
 *
 * Retries Team A ingestion for an EXISTING File whose ingestion attempt
 * previously failed, reusing its already-stored bytes/storageUrl —
 * never re-uploads, never creates a second File document, and always
 * submits the SAME `document_id` (this File's own `_id`), so Team A's
 * own ingestion lock/generation mechanism (team4a/app/pipeline/
 * ingestion_lock.py, mongo_authority.py) sees this as exactly what it
 * is: a fresh attempt at the same document, safely superseding any
 * earlier generation — never a second, competing document. This route
 * does not reimplement, and never weakens, that lock (Requirement 4);
 * it simply calls `handOffToTeamA` again, exactly as the original
 * upload did.
 *
 * This is the retry affordance for a failure the upload-tracker UI never
 * saw at all — e.g. the user closed the upload dialog, or reloaded the
 * page, after an upload byte-transfer that itself succeeded but whose
 * Team A ingestion attempt failed (see components/shared/MaterialCard.tsx's
 * "Retry" button, shown only for `status === "failed"`).
 *
 * Same two-step ownership chain as every other file route in this
 * project: the workspace (`assertOwnership`), then the file itself
 * (`file.workspaceId === workspaceId`) — both failure modes return the
 * same indistinguishable 404.
 *
 * Only allowed when the file's CURRENT status is "failed" — retrying a
 * "ready" file would be pointless, and retrying an "uploading"/
 * "processing" one would risk racing an ingestion attempt that may
 * already be in flight (Team A's own lock would reject a genuinely
 * concurrent second attempt with 409 regardless, but this check avoids
 * even attempting that in the common case, and prevents a rapid
 * double-click on this same button from doing anything the second time —
 * Requirement 5).
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string; fileId: string }> }
) {
  const session = await auth();

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const { id: workspaceId, fileId } = await params;

  await connectToDatabase();

  try {
    await assertOwnership(workspaceId, session.user.id);
  } catch (error) {
    if (error instanceof OwnershipError) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    throw error;
  }

  if (!Types.ObjectId.isValid(fileId)) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const file = await FileModel.findById(fileId);

  if (!file || file.workspaceId.toString() !== workspaceId) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  if (file.status !== "failed") {
    return NextResponse.json(
      { error: "This file isn't in a failed state, so there's nothing to retry." },
      { status: 409 }
    );
  }

  const retried = await handOffToTeamA(file, session.user.id);
  return NextResponse.json(serializeFile(retried));
}
