import { NextResponse } from "next/server";
import { Types, type HydratedDocument } from "mongoose";

import { auth } from "@/lib/auth";
import { connectToDatabase } from "@/lib/mongodb";
import { assertOwnership, OwnershipError } from "@/lib/ownership";
import { generateRagSessionId } from "@/lib/ragSession";
import { ConversationModel, type Conversation as ConversationDoc } from "@/models/Conversation";
import { MessageModel } from "@/models/Message";

/**
 * POST /api/workspaces/[id]/conversations — MVP M5.
 *
 * Creates a new, durable Team 4C Conversation with a fresh,
 * server-generated `ragSessionId` already attached at creation time.
 * There is no race condition to guard against HERE specifically (a
 * single `ConversationModel.create()` call either succeeds once or
 * fails; there is nothing else to race with for a brand-new document) —
 * the race this task is concerned with (a legacy conversation being
 * lazily backfilled by two concurrent requests) is handled separately,
 * in `lib/ragSession.ts`'s `getOrCreateRagSessionId()`, used by the
 * chat route for EXISTING conversations.
 *
 * `title` is accepted from the request body as a simple, user-supplied
 * label (matching the existing `Conversation.title` field's own
 * documented purpose — "auto-generated from the first message... and
 * user-editable") — it carries no security significance and is never
 * used to derive `ragSessionId` (Requirement: "Do not derive
 * ragSessionId from... conversation title").
 */
function serializeConversation(conversation: HydratedDocument<ConversationDoc>) {
  return {
    id: conversation._id.toString(),
    workspaceId: conversation.workspaceId.toString(),
    title: conversation.title,
  };
}

/**
 * Summary shape for GET's list response. Deliberately narrower than
 * `serializeConversation` above — no `workspaceId` (redundant, it's the
 * route param) and no `ragSessionId` (internal Team 4B linkage; never
 * exposed to the browser, matching how `serializeConversation` already
 * omits it from the POST response).
 *
 * STEP 4 REMEDIATION: `hasMessages` is additive — computed from a single
 * batched `Message.distinct()` call across the whole page (see GET below),
 * never one query per conversation. Consumed by
 * `hooks/useActiveConversation.ts` to decide whether an existing, still-
 * unused conversation can be adopted instead of creating a new one.
 */
function serializeConversationSummary(
  conversation: HydratedDocument<ConversationDoc>,
  conversationIdsWithMessages: Set<string>
) {
  return {
    id: conversation._id.toString(),
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    hasMessages: conversationIdsWithMessages.has(conversation._id.toString()),
  };
}

const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 50;

/**
 * Cursor is a plain, self-describing `<updatedAt-ISO>_<_id-hex>` pair, not
 * an opaque/obscured token — it carries no information the caller couldn't
 * already see in the previous page's last item, so there is nothing to
 * hide. Tie-broken on `_id` because two conversations can share the same
 * `updatedAt` millisecond, which would otherwise let a page boundary skip
 * or repeat an item.
 */
function parseCursor(raw: string | null): { updatedAt: Date; id: string } | null {
  if (!raw) return null;
  const separatorIndex = raw.lastIndexOf("_");
  if (separatorIndex <= 0) return null;

  const updatedAtPart = raw.slice(0, separatorIndex);
  const idPart = raw.slice(separatorIndex + 1);
  const updatedAt = new Date(updatedAtPart);

  if (Number.isNaN(updatedAt.getTime()) || !Types.ObjectId.isValid(idPart)) {
    return null;
  }

  return { updatedAt, id: idPart };
}

function encodeCursor(updatedAt: Date, id: Types.ObjectId): string {
  return `${updatedAt.toISOString()}_${id.toString()}`;
}

/**
 * GET /api/workspaces/[id]/conversations — list conversations for a
 * workspace, most recently updated first.
 *
 * Same auth/ownership chain as POST below. Returns only conversations
 * belonging to this workspace; an invalid/unowned workspace id produces
 * the same 404 `assertOwnership` already gives every other route, so this
 * endpoint introduces no new way to probe workspace existence.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
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

  const url = new URL(request.url);

  const requestedLimit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
  const limit =
    Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, MAX_PAGE_SIZE)
      : DEFAULT_PAGE_SIZE;

  const cursor = parseCursor(url.searchParams.get("cursor"));

  const query: Record<string, unknown> = { workspaceId };
  if (cursor) {
    query.$or = [
      { updatedAt: { $lt: cursor.updatedAt } },
      { updatedAt: cursor.updatedAt, _id: { $lt: new Types.ObjectId(cursor.id) } },
    ];
  }

  // Fetch one extra document to detect whether a next page exists without
  // a separate count query.
  const conversations = (await ConversationModel.find(query)
    .sort({ updatedAt: -1, _id: -1 })
    .limit(limit + 1)) as HydratedDocument<ConversationDoc>[];

  const hasMore = conversations.length > limit;
  const page = hasMore ? conversations.slice(0, limit) : conversations;
  const last = page[page.length - 1];

  // STEP 4 REMEDIATION: one batched query for the whole page (never N+1)
  // — which of these conversations has at least one persisted message.
  const conversationIdsWithMessages = new Set(
    (await MessageModel.distinct("conversationId", { conversationId: { $in: page.map((c) => c._id) } })).map((id) =>
      id.toString()
    )
  );

  return NextResponse.json({
    conversations: page.map((conversation) => serializeConversationSummary(conversation, conversationIdsWithMessages)),
    nextCursor: hasMore && last ? encodeCursor(last.updatedAt, last._id) : null,
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
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

  const body = await request.json().catch(() => ({}));
  const title = typeof body?.title === "string" && body.title.trim() ? body.title.trim() : "New conversation";

  const conversation = await ConversationModel.create({
    workspaceId,
    title,
    // Server-generated ONLY — never read from `body`, never supplied by
    // the browser. A brand-new document has no prior ragSessionId to
    // race against, so a plain, direct assignment at creation time is
    // sufficient here (unlike the lazy-backfill path).
    ragSessionId: generateRagSessionId(),
  });

  return NextResponse.json(serializeConversation(conversation), { status: 201 });
}
