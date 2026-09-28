import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { assertConversationOwnership } from "@/lib/conversationAuth";
import { connectToDatabase } from "@/lib/mongodb";
import { OwnershipError } from "@/lib/ownership";
import { ConversationModel } from "@/models/Conversation";
import { MessageModel } from "@/models/Message";
import { getTeamBService } from "@/services/teamB";

/**
 * DELETE /api/conversations/[id]?workspaceId=... — Step 5.
 *
 * Same two-step ownership chain as `GET /api/conversations/[id]/messages`
 * (`assertConversationOwnership`, reused verbatim, never duplicated) —
 * an unauthorized/cross-workspace/nonexistent conversation id all get the
 * same indistinguishable 404, matching every other ownership check in
 * this project.
 *
 * ORDERING (children first, parent last — same rationale as the existing
 * workspace-delete route, `app/api/workspaces/[id]/route.ts`): deleting
 * `Message` documents before the `Conversation` document itself means a
 * failure partway through leaves the conversation still visible/reachable
 * (so a retry can complete it) rather than silently orphaning messages
 * with no parent to reach them through.
 *
 * Team 4B's Redis session cleanup runs LAST and is explicitly best-effort
 * — its failure is logged and swallowed, never allowed to block or
 * revert the authoritative Mongo deletion above it. Per Step 5's own
 * requirement, this is not actually load-bearing for correctness: once
 * the Conversation document is gone, its `ragSessionId` is unreachable
 * through any Team 4C API (the exact chain `assertConversationOwnership`
 * enforces), so a resumed conversation can never be restored or continue
 * using stale context regardless of whether the Team 4B-side cleanup
 * itself succeeds.
 */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const { id: conversationId } = await params;
  const url = new URL(request.url);
  const workspaceId = url.searchParams.get("workspaceId");

  if (!workspaceId) {
    return NextResponse.json({ error: "workspaceId is required." }, { status: 400 });
  }

  await connectToDatabase();

  let conversation;
  try {
    conversation = await assertConversationOwnership(conversationId, workspaceId, session.user.id);
  } catch (error) {
    if (error instanceof OwnershipError) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    throw error;
  }

  await MessageModel.deleteMany({ conversationId });
  await ConversationModel.findByIdAndDelete(conversationId);

  if (conversation.ragSessionId) {
    const teamB = getTeamBService();
    if (teamB.deleteSession) {
      try {
        await teamB.deleteSession(conversation.ragSessionId, {
          sub: session.user.id,
          workspace_id: workspaceId,
        });
      } catch (error) {
        console.warn(
          `[conversations] Failed to delete Team B session for conversation ${conversationId} (best-effort, non-fatal):`,
          error instanceof Error ? error.message : "Unknown error"
        );
      }
    }
  }

  return NextResponse.json({ success: true });
}
