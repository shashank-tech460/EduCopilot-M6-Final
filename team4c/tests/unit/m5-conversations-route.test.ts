import { describe, expect, it, vi, beforeEach } from "vitest";
import { Types } from "mongoose";

/**
 * MVP M5 — POST /api/workspaces/[id]/conversations.
 * Mirrors the established mocking convention (tests/unit/files-api.test.ts,
 * tests/unit/chat-api.test.ts): real `auth`/`assertOwnership` logic runs,
 * `WorkspaceModel`/`ConversationModel` are mocked at the data-access layer.
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
  ConversationModel: { create: vi.fn(), find: vi.fn() },
}));

vi.mock("@/models/Message", () => ({
  MessageModel: { distinct: vi.fn() },
}));

import { auth } from "@/lib/auth";
import { WorkspaceModel } from "@/models/Workspace";
import { ConversationModel } from "@/models/Conversation";
import { MessageModel } from "@/models/Message";
import { GET, POST } from "@/app/api/workspaces/[id]/conversations/route";

type SimpleAuthFn = () => Promise<{
  user: { id: string; name?: string | null; email?: string | null };
  expires: string;
} | null>;

const mockedAuth = vi.mocked(auth) as unknown as ReturnType<typeof vi.fn<SimpleAuthFn>>;
const mockedWorkspaceFindById = vi.mocked(WorkspaceModel.findById);
const mockedConversationCreate = vi.mocked(ConversationModel.create);
const mockedConversationFind = vi.mocked(ConversationModel.find);
const mockedMessageDistinct = vi.mocked(MessageModel.distinct);

function fakeSession(userId: string) {
  return { user: { id: userId, name: "Sample Student", email: "sample.student@example.com" }, expires: "2099-01-01" } as never;
}

function ownedWorkspace(id: string, ownerId: string) {
  return { _id: new Types.ObjectId(id), userId: new Types.ObjectId(ownerId), name: "DBMS" } as never;
}

function conversationRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/workspaces/ws/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function routeParams(workspaceId: string) {
  return { params: Promise.resolve({ id: workspaceId }) };
}

function conversationListRequest(query = "") {
  return new Request(`http://localhost/api/workspaces/ws/conversations${query}`);
}

function fakeConversation(overrides: {
  id?: Types.ObjectId;
  title?: string;
  createdAt?: Date;
  updatedAt?: Date;
}) {
  return {
    _id: overrides.id ?? new Types.ObjectId(),
    title: overrides.title ?? "New conversation",
    createdAt: overrides.createdAt ?? new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: overrides.updatedAt ?? new Date("2026-01-01T00:00:00.000Z"),
  } as never;
}

/**
 * Matches the established `.find().sort()` chain-mocking convention from
 * tests/unit/workspaces-api.test.ts and tests/unit/files-api.test.ts, with
 * one extra `.limit()` level since this route paginates (those don't).
 */
function mockFindChain(docs: unknown[]) {
  const limitMock = vi.fn().mockResolvedValue(docs);
  const sortMock = vi.fn().mockReturnValue({ limit: limitMock });
  mockedConversationFind.mockReturnValue({ sort: sortMock } as never);
  return { sortMock, limitMock };
}

beforeEach(() => {
  vi.clearAllMocks();
  // STEP 4 REMEDIATION default: no conversation has messages yet, unless
  // a specific test overrides this -- preserves every pre-existing test's
  // original assumptions.
  mockedMessageDistinct.mockResolvedValue([]);
});

describe("POST /api/workspaces/[id]/conversations", () => {
  it("1: a new conversation is created with a server-generated ragSessionId", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    mockedConversationCreate.mockImplementation(
      (async (doc: any) => ({ _id: new Types.ObjectId(), ...doc })) as never
    );

    const response = await POST(conversationRequest({ title: "My chat" }), routeParams(workspaceId));

    expect(response.status).toBe(201);
    expect(mockedConversationCreate).toHaveBeenCalledTimes(1);
    const createdDoc = mockedConversationCreate.mock.calls[0][0] as { ragSessionId: string };
    expect(typeof createdDoc.ragSessionId).toBe("string");
    expect(createdDoc.ragSessionId.length).toBeGreaterThan(10);
  });

  it("5: the browser cannot choose ragSessionId — a body-supplied value is ignored", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    mockedConversationCreate.mockImplementation(
      (async (doc: any) => ({ _id: new Types.ObjectId(), ...doc })) as never
    );

    await POST(conversationRequest({ title: "My chat", ragSessionId: "attacker-chosen-id" }), routeParams(workspaceId));

    const createdDoc = mockedConversationCreate.mock.calls[0][0] as { ragSessionId: string };
    expect(createdDoc.ragSessionId).not.toBe("attacker-chosen-id");
  });

  it("rejects creation for a workspace the user does not own", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(null as never);

    const response = await POST(conversationRequest({ title: "My chat" }), routeParams(workspaceId));

    expect(response.status).toBe(404);
    expect(mockedConversationCreate).not.toHaveBeenCalled();
  });

  it("returns 401 when unauthenticated", async () => {
    mockedAuth.mockResolvedValue(null);

    const response = await POST(conversationRequest({ title: "My chat" }), routeParams(new Types.ObjectId().toString()));

    expect(response.status).toBe(401);
    expect(mockedConversationCreate).not.toHaveBeenCalled();
  });

  it("two separate creation calls produce two different ragSessionIds", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    mockedConversationCreate.mockImplementation(
      (async (doc: any) => ({ _id: new Types.ObjectId(), ...doc })) as never
    );

    await POST(conversationRequest({ title: "Chat A" }), routeParams(workspaceId));
    await POST(conversationRequest({ title: "Chat B" }), routeParams(workspaceId));

    const first = (mockedConversationCreate.mock.calls[0][0] as { ragSessionId: string }).ragSessionId;
    const second = (mockedConversationCreate.mock.calls[1][0] as { ragSessionId: string }).ragSessionId;
    expect(first).not.toBe(second);
  });
});

describe("GET /api/workspaces/[id]/conversations", () => {
  it("returns 401 when unauthenticated", async () => {
    mockedAuth.mockResolvedValue(null);

    const response = await GET(conversationListRequest(), routeParams(new Types.ObjectId().toString()));

    expect(response.status).toBe(401);
    expect(mockedConversationFind).not.toHaveBeenCalled();
  });

  it("returns 404 for a workspace the user does not own", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(null as never);

    const response = await GET(conversationListRequest(), routeParams(workspaceId));

    expect(response.status).toBe(404);
    expect(mockedConversationFind).not.toHaveBeenCalled();
  });

  it("returns 404 for a workspace owned by a different user (never leaks another user's conversations)", async () => {
    const userId = new Types.ObjectId().toString();
    const otherUserId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, otherUserId));

    const response = await GET(conversationListRequest(), routeParams(workspaceId));

    expect(response.status).toBe(404);
    expect(mockedConversationFind).not.toHaveBeenCalled();
  });

  it("queries only the requested, owned workspace's conversations", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    mockFindChain([]);

    await GET(conversationListRequest(), routeParams(workspaceId));

    expect(mockedConversationFind).toHaveBeenCalledTimes(1);
    const queryArg = mockedConversationFind.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(queryArg.workspaceId).toBe(workspaceId);
  });

  it("returns an empty list for a workspace with no conversations", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    mockFindChain([]);

    const response = await GET(conversationListRequest(), routeParams(workspaceId));
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({ conversations: [], nextCursor: null });
  });

  it("sorts by updatedAt descending (most recently updated first)", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    const { sortMock } = mockFindChain([]);

    await GET(conversationListRequest(), routeParams(workspaceId));

    expect(sortMock).toHaveBeenCalledWith({ updatedAt: -1, _id: -1 });
  });

  it("returns id, title, createdAt, updatedAt — and never ragSessionId or workspaceId", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    const conversationId = new Types.ObjectId();
    mockFindChain([
      {
        _id: conversationId,
        title: "Chapter 3 questions",
        createdAt: new Date("2026-02-01T00:00:00.000Z"),
        updatedAt: new Date("2026-02-02T00:00:00.000Z"),
        // Present on the real document, must never be echoed back.
        ragSessionId: "internal-session-id",
        workspaceId: new Types.ObjectId(workspaceId),
      },
    ]);

    const response = await GET(conversationListRequest(), routeParams(workspaceId));
    const data = await response.json();

    expect(data.conversations).toEqual([
      {
        id: conversationId.toString(),
        title: "Chapter 3 questions",
        createdAt: "2026-02-01T00:00:00.000Z",
        updatedAt: "2026-02-02T00:00:00.000Z",
        hasMessages: false,
      },
    ]);
    expect(data.conversations[0]).not.toHaveProperty("ragSessionId");
    expect(data.conversations[0]).not.toHaveProperty("workspaceId");
  });

  it("paginates: requests one extra document and returns a nextCursor when more remain", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));

    // Default page size is 30 — return 31 documents to simulate "more exist".
    const docs = Array.from({ length: 31 }, (_, i) =>
      fakeConversation({
        title: `Chat ${i}`,
        updatedAt: new Date(2026, 0, 31 - i),
      })
    );
    const { limitMock } = mockFindChain(docs);

    const response = await GET(conversationListRequest(), routeParams(workspaceId));
    const data = await response.json();

    expect(limitMock).toHaveBeenCalledWith(31); // requested limit (30) + 1
    expect(data.conversations).toHaveLength(30);
    expect(typeof data.nextCursor).toBe("string");
  });

  it("returns nextCursor: null when exactly the page fits with nothing left over", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    mockFindChain([fakeConversation({ title: "Only one" })]);

    const response = await GET(conversationListRequest("?limit=5"), routeParams(workspaceId));
    const data = await response.json();

    expect(data.conversations).toHaveLength(1);
    expect(data.nextCursor).toBeNull();
  });

  it("honors a client-supplied limit, capped at the maximum page size", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    const { limitMock } = mockFindChain([]);

    await GET(conversationListRequest("?limit=500"), routeParams(workspaceId));

    // Capped at MAX_PAGE_SIZE (50) + 1, not the requested 500.
    expect(limitMock).toHaveBeenCalledWith(51);
  });

  it("applies a cursor as an updatedAt/_id boundary, scoped to the same workspace", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    mockFindChain([]);

    const cursorId = new Types.ObjectId().toString();
    const cursor = `2026-02-01T00:00:00.000Z_${cursorId}`;

    await GET(conversationListRequest(`?cursor=${cursor}`), routeParams(workspaceId));

    const queryArg = mockedConversationFind.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(queryArg.workspaceId).toBe(workspaceId);
    expect(queryArg.$or).toBeDefined();
  });

  it("ignores a malformed cursor rather than erroring", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    mockFindChain([]);

    const response = await GET(conversationListRequest("?cursor=not-a-real-cursor"), routeParams(workspaceId));

    expect(response.status).toBe(200);
    const queryArg = mockedConversationFind.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(queryArg.$or).toBeUndefined();
  });

  it("never returns conversations from a different workspace (query is always scoped)", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    const otherWorkspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    mockFindChain([]);

    await GET(conversationListRequest(), routeParams(workspaceId));

    const queryArg = mockedConversationFind.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(queryArg.workspaceId).not.toBe(otherWorkspaceId);
    expect(queryArg.workspaceId).toBe(workspaceId);
  });

  // -------------------------------------------------------------------
  // STEP 4 REMEDIATION -- hasMessages (empty-conversation reuse support)
  // -------------------------------------------------------------------

  describe("hasMessages", () => {
    it("is false for a conversation with no persisted messages", async () => {
      const userId = new Types.ObjectId().toString();
      const workspaceId = new Types.ObjectId().toString();
      mockedAuth.mockResolvedValue(fakeSession(userId));
      mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
      const conversationId = new Types.ObjectId();
      mockFindChain([fakeConversation({ id: conversationId })]);
      mockedMessageDistinct.mockResolvedValue([]);

      const response = await GET(conversationListRequest(), routeParams(workspaceId));
      const data = await response.json();

      expect(data.conversations[0].hasMessages).toBe(false);
    });

    it("is true for a conversation that has at least one message", async () => {
      const userId = new Types.ObjectId().toString();
      const workspaceId = new Types.ObjectId().toString();
      mockedAuth.mockResolvedValue(fakeSession(userId));
      mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
      const conversationId = new Types.ObjectId();
      mockFindChain([fakeConversation({ id: conversationId })]);
      mockedMessageDistinct.mockResolvedValue([conversationId]);

      const response = await GET(conversationListRequest(), routeParams(workspaceId));
      const data = await response.json();

      expect(data.conversations[0].hasMessages).toBe(true);
    });

    it("correctly distinguishes hasMessages per-conversation across a mixed page (never mixes them up)", async () => {
      const userId = new Types.ObjectId().toString();
      const workspaceId = new Types.ObjectId().toString();
      mockedAuth.mockResolvedValue(fakeSession(userId));
      mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
      const usedId = new Types.ObjectId();
      const emptyId = new Types.ObjectId();
      mockFindChain([
        fakeConversation({ id: usedId, title: "Used" }),
        fakeConversation({ id: emptyId, title: "Empty" }),
      ]);
      mockedMessageDistinct.mockResolvedValue([usedId]);

      const response = await GET(conversationListRequest(), routeParams(workspaceId));
      const data = await response.json();

      const used = data.conversations.find((c: { id: string }) => c.id === usedId.toString());
      const empty = data.conversations.find((c: { id: string }) => c.id === emptyId.toString());
      expect(used.hasMessages).toBe(true);
      expect(empty.hasMessages).toBe(false);
    });

    it("queries message existence in ONE batched call for the whole page, never one call per conversation", async () => {
      const userId = new Types.ObjectId().toString();
      const workspaceId = new Types.ObjectId().toString();
      mockedAuth.mockResolvedValue(fakeSession(userId));
      mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
      mockFindChain([fakeConversation({}), fakeConversation({}), fakeConversation({})]);
      mockedMessageDistinct.mockResolvedValue([]);

      await GET(conversationListRequest(), routeParams(workspaceId));

      expect(mockedMessageDistinct).toHaveBeenCalledTimes(1);
    });

    it("never queries message existence for an empty conversation list at all", async () => {
      const userId = new Types.ObjectId().toString();
      const workspaceId = new Types.ObjectId().toString();
      mockedAuth.mockResolvedValue(fakeSession(userId));
      mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
      mockFindChain([]);

      const response = await GET(conversationListRequest(), routeParams(workspaceId));
      const data = await response.json();

      expect(data.conversations).toEqual([]);
      expect(mockedMessageDistinct).toHaveBeenCalledWith("conversationId", { conversationId: { $in: [] } });
    });
  });
});
