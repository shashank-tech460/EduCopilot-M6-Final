import { describe, expect, it, vi, beforeEach } from "vitest";
import { Types } from "mongoose";

/**
 * DELETE /api/conversations/[id] — Step 5 (individual conversation
 * deletion).
 *
 * Mirrors the established mocking convention (tests/unit/conversation-
 * messages-route.test.ts, tests/unit/chat-api.test.ts): real
 * `assertConversationOwnership` logic runs (never mocked); only its
 * data-access dependencies and this route's own model calls
 * (`MessageModel.deleteMany`, `ConversationModel.findByIdAndDelete`) and
 * `getTeamBService` are mocked.
 */

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("@/lib/mongodb", () => ({
  connectToDatabase: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/models/Workspace", () => ({
  WorkspaceModel: { findById: vi.fn() },
}));

vi.mock("@/models/Conversation", () => ({
  ConversationModel: { findById: vi.fn(), findByIdAndDelete: vi.fn() },
}));

vi.mock("@/models/Message", () => ({
  MessageModel: { deleteMany: vi.fn() },
}));

vi.mock("@/services/teamB", () => ({
  getTeamBService: vi.fn(),
}));

import { auth } from "@/lib/auth";
import { WorkspaceModel } from "@/models/Workspace";
import { ConversationModel } from "@/models/Conversation";
import { MessageModel } from "@/models/Message";
import { getTeamBService } from "@/services/teamB";
import { DELETE } from "@/app/api/conversations/[id]/route";

type SimpleAuthFn = () => Promise<{
  user: { id: string; name?: string | null; email?: string | null };
  expires: string;
} | null>;

const mockedAuth = vi.mocked(auth) as unknown as ReturnType<typeof vi.fn<SimpleAuthFn>>;
const mockedWorkspaceFindById = vi.mocked(WorkspaceModel.findById);
const mockedConversationFindById = vi.mocked(ConversationModel.findById);
const mockedConversationFindByIdAndDelete = vi.mocked(ConversationModel.findByIdAndDelete);
const mockedMessageDeleteMany = vi.mocked(MessageModel.deleteMany);
const mockedGetTeamBService = vi.mocked(getTeamBService);

function fakeSession(userId: string) {
  return { user: { id: userId, name: "Sample Student", email: "sample.student@example.com" }, expires: "2099-01-01" } as never;
}

function ownedWorkspace(id: string, ownerId: string) {
  return { _id: new Types.ObjectId(id), userId: new Types.ObjectId(ownerId), name: "DBMS" } as never;
}

function ownedConversation(id: string, workspaceId: string, ragSessionId: string | undefined = "session-abc") {
  return { _id: new Types.ObjectId(id), workspaceId: new Types.ObjectId(workspaceId), ragSessionId } as never;
}

function deleteRequest(workspaceId?: string) {
  const url = workspaceId
    ? `http://localhost/api/conversations/conv/?workspaceId=${workspaceId}`
    : "http://localhost/api/conversations/conv/";
  return new Request(url, { method: "DELETE" });
}

function routeParams(conversationId: string) {
  return { params: Promise.resolve({ id: conversationId }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedMessageDeleteMany.mockResolvedValue({ acknowledged: true, deletedCount: 0 } as never);
  mockedConversationFindByIdAndDelete.mockResolvedValue({} as never);
  mockedGetTeamBService.mockReturnValue({ query: vi.fn() });
});

describe("DELETE /api/conversations/[id]", () => {
  it("returns 401 when unauthenticated", async () => {
    mockedAuth.mockResolvedValue(null);

    const response = await DELETE(deleteRequest("ws-1"), routeParams("conv-1"));

    expect(response.status).toBe(401);
    expect(mockedConversationFindByIdAndDelete).not.toHaveBeenCalled();
  });

  it("returns 400 when workspaceId is missing", async () => {
    const userId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));

    const response = await DELETE(deleteRequest(), routeParams("conv-1"));

    expect(response.status).toBe(400);
    expect(mockedConversationFindByIdAndDelete).not.toHaveBeenCalled();
  });

  it("returns 404 for a workspace the user does not own", async () => {
    const userId = new Types.ObjectId().toString();
    const otherUserId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, otherUserId));

    const response = await DELETE(deleteRequest(workspaceId), routeParams(new Types.ObjectId().toString()));

    expect(response.status).toBe(404);
    expect(mockedConversationFindByIdAndDelete).not.toHaveBeenCalled();
  });

  it("returns 404 for a nonexistent conversation", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    mockedConversationFindById.mockResolvedValue(null);

    const response = await DELETE(deleteRequest(workspaceId), routeParams(new Types.ObjectId().toString()));

    expect(response.status).toBe(404);
    expect(mockedConversationFindByIdAndDelete).not.toHaveBeenCalled();
  });

  it("returns 404 for a conversation belonging to a DIFFERENT workspace (never deletes cross-workspace)", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    const otherWorkspaceId = new Types.ObjectId().toString();
    const conversationId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    mockedConversationFindById.mockResolvedValue(ownedConversation(conversationId, otherWorkspaceId));

    const response = await DELETE(deleteRequest(workspaceId), routeParams(conversationId));

    expect(response.status).toBe(404);
    expect(mockedConversationFindByIdAndDelete).not.toHaveBeenCalled();
    expect(mockedMessageDeleteMany).not.toHaveBeenCalled();
  });

  it("deletes the conversation's messages BEFORE the conversation itself (children first, parent last)", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    const conversationId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    mockedConversationFindById.mockResolvedValue(ownedConversation(conversationId, workspaceId));

    const callOrder: string[] = [];
    mockedMessageDeleteMany.mockImplementation((async () => {
      callOrder.push("messages");
      return { acknowledged: true, deletedCount: 3 };
    }) as never);
    mockedConversationFindByIdAndDelete.mockImplementation((async () => {
      callOrder.push("conversation");
      return {};
    }) as never);

    const response = await DELETE(deleteRequest(workspaceId), routeParams(conversationId));

    expect(response.status).toBe(200);
    expect(callOrder).toEqual(["messages", "conversation"]);
    expect(mockedMessageDeleteMany).toHaveBeenCalledWith({ conversationId });
    expect(mockedConversationFindByIdAndDelete).toHaveBeenCalledWith(conversationId);
  });

  it("attempts best-effort Team B session cleanup using the conversation's own ragSessionId", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    const conversationId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    mockedConversationFindById.mockResolvedValue(ownedConversation(conversationId, workspaceId, "the-real-session-id"));
    const deleteSessionMock = vi.fn().mockResolvedValue(true);
    mockedGetTeamBService.mockReturnValue({ query: vi.fn(), deleteSession: deleteSessionMock });

    await DELETE(deleteRequest(workspaceId), routeParams(conversationId));

    expect(deleteSessionMock).toHaveBeenCalledWith("the-real-session-id", { sub: userId, workspace_id: workspaceId });
  });

  it("succeeds even when the Team B cleanup fails (best-effort, never fatal)", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    const conversationId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    mockedConversationFindById.mockResolvedValue(ownedConversation(conversationId, workspaceId));
    mockedGetTeamBService.mockReturnValue({
      query: vi.fn(),
      deleteSession: vi.fn().mockRejectedValue(new Error("Team B unreachable")),
    });

    const response = await DELETE(deleteRequest(workspaceId), routeParams(conversationId));

    expect(response.status).toBe(200);
    // The authoritative Mongo deletion still ran despite Team B failing.
    expect(mockedConversationFindByIdAndDelete).toHaveBeenCalledWith(conversationId);
  });

  it("does not attempt Team B cleanup for a conversation with no ragSessionId", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    const conversationId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    mockedConversationFindById.mockResolvedValue({
      _id: new Types.ObjectId(conversationId),
      workspaceId: new Types.ObjectId(workspaceId),
      // Deliberately no ragSessionId property at all (a pre-M5 legacy
      // conversation that was never backfilled) -- distinct from passing
      // `undefined` explicitly, which JS default parameters would quietly
      // replace with "session-abc" in the `ownedConversation()` helper.
    } as never);
    const deleteSessionMock = vi.fn();
    mockedGetTeamBService.mockReturnValue({ query: vi.fn(), deleteSession: deleteSessionMock });

    const response = await DELETE(deleteRequest(workspaceId), routeParams(conversationId));

    expect(response.status).toBe(200);
    expect(deleteSessionMock).not.toHaveBeenCalled();
  });

  it("does not attempt Team B cleanup when the active TeamBService doesn't support it (e.g. the mock)", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    const conversationId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    mockedConversationFindById.mockResolvedValue(ownedConversation(conversationId, workspaceId));
    mockedGetTeamBService.mockReturnValue({ query: vi.fn() }); // no deleteSession

    const response = await DELETE(deleteRequest(workspaceId), routeParams(conversationId));

    expect(response.status).toBe(200); // must not throw
  });

  it("returns success: true on a clean deletion", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    const conversationId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    mockedConversationFindById.mockResolvedValue(ownedConversation(conversationId, workspaceId));

    const response = await DELETE(deleteRequest(workspaceId), routeParams(conversationId));
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({ success: true });
  });
});
