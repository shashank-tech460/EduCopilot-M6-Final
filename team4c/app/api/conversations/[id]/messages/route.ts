import { NextResponse } from "next/server";
import type { HydratedDocument } from "mongoose";

import { auth } from "@/lib/auth";
import { assertConversationOwnership } from "@/lib/conversationAuth";
import { connectToDatabase } from "@/lib/mongodb";
import { OwnershipError } from "@/lib/ownership";
import { FileModel } from "@/models/File";
import { MessageModel, type Message as MessageDoc } from "@/models/Message";
import type { SourceAttribution } from "@/store/appStore";

/**
 * Restores one persisted `Message.citations[]` entry (the narrow
 * `{fileId, type, pageNumber?, timestampSeconds?}` shape `app/api/chat/
 * route.ts` writes) back into the UI-facing `SourceAttribution` shape
 * `components/chat/SourceAttribution.tsx` already renders — the exact
 * same type the live chat stream's `data-citations` part already sends,
 * so a restored conversation needs no new rendering path.
 *
 * Re-applies the SAME "is this file actually in this workspace right
 * now" check `lib/workspaceFilter.ts`'s `filterWorkspaceReferences`
 * already enforces at write time — a citation whose file was deleted, or
 * has since moved to a different workspace, is returned `disabled: true`
 * with no `fileUrl` (the file's real URL is never exposed for something
 * that just failed an authorization/existence check), matching exactly
 * how `SourceAttribution.tsx` already renders a disabled attribution
 * (it only ever reads `sourceFile`/`location` in that branch).
 */
function restoreCitation(
  citation: NonNullable<MessageDoc["citations"]>[number],
  workspaceFiles: Map<string, { originalName: string; storageUrl: string }>
): SourceAttribution {
  const fileId = citation.fileId.toString();
  const isPdf = citation.type === "pdf";
  const location = isPdf ? citation.pageNumber ?? 0 : citation.timestampSeconds ?? 0;
  const file = workspaceFiles.get(fileId);

  if (!file) {
    return {
      type: isPdf ? "pdf_page" : "video_timestamp",
      sourceFile: "Unavailable source",
      fileId,
      location,
      label: "Unavailable source",
      disabled: true,
    };
  }

  return {
    type: isPdf ? "pdf_page" : "video_timestamp",
    sourceFile: file.originalName,
    fileId,
    location,
    label: isPdf ? `${file.originalName}, page ${location}` : `${file.originalName} at ${location}s`,
    fileUrl: file.storageUrl,
    disabled: false,
  };
}

function serializeMessage(
  message: HydratedDocument<MessageDoc>,
  workspaceFiles: Map<string, { originalName: string; storageUrl: string }>
) {
  const citations = message.citations?.map((citation) => restoreCitation(citation, workspaceFiles));

  return {
    id: message._id.toString(),
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
    ...(citations && citations.length > 0 ? { citations } : {}),
  };
}

/**
 * GET /api/conversations/[id]/messages?workspaceId=... — MVP: persistent
 * chat history, Step 4.
 *
 * Same authorization chain as `POST /api/chat` (`app/api/chat/route.ts`):
 * `workspaceId` arrives as a query parameter (this route's URL only
 * carries `conversationId`, matching the sibling `GET/PATCH
 * /api/conversations/[id]/scope`'s two-part authorization need), and
 * `assertConversationOwnership` is reused exactly, not reimplemented —
 * a nonexistent conversation, one belonging to a different workspace, and
 * one belonging to a different user's workspace are all rejected with
 * the same indistinguishable 404, for the same reason documented on
 * `assertConversationOwnership` itself.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const { id: conversationId } = await params;
  const workspaceId = new URL(request.url).searchParams.get("workspaceId") ?? "";

  await connectToDatabase();

  try {
    await assertConversationOwnership(conversationId, workspaceId, session.user.id);
  } catch (error) {
    if (error instanceof OwnershipError) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    throw error;
  }

  const messages = (await MessageModel.find({ conversationId }).sort({
    createdAt: 1,
  })) as HydratedDocument<MessageDoc>[];

  // One query for every file in the workspace, reused across all messages
  // — matching `app/api/chat/route.ts`'s own "fetch workspace files once"
  // pattern, rather than a per-citation lookup.
  const files = await FileModel.find({ workspaceId });
  const workspaceFiles = new Map(
    files.map((file) => [file._id.toString(), { originalName: file.originalName, storageUrl: file.storageUrl }])
  );

  return NextResponse.json({
    conversationId,
    messages: messages.map((message) => serializeMessage(message, workspaceFiles)),
  });
}
