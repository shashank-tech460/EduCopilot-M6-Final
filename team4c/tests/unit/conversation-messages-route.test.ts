import { describe, expect, it, vi, beforeEach } from "vitest";
import { Types } from "mongoose";

/**
 * GET /api/conversations/[id]/messages — persistent chat history, Step 4.
 *
 * Mirrors the established mocking convention (tests/unit/chat-api.test.ts,
 * tests/unit/m5-conversations-route.test.ts): real `assertConversationOwnership`
 * logic runs (it is NOT mocked); only its data-access dependencies
 * (`WorkspaceModel.findById`, `ConversationModel.findById`) and this
 * route's own (`MessageModel.find`, `FileModel.find`) are mocked.
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
  ConversationModel: { findById: vi.fn() },
}));

vi.mock("@/models/Message", () => ({
  MessageModel: { find: vi.fn() },
}));

vi.mock("@/models/File", () => ({
  FileModel: { find: vi.fn() },
}));

import { auth } from "@/lib/auth";
import { WorkspaceModel } from "@/models/Workspace";
import { ConversationModel } from "@/models/Conversation";
import { MessageModel } from "@/models/Message";
import { FileModel } from "@/models/File";
import { GET } from "@/app/api/conversations/[id]/messages/route";

type SimpleAuthFn = () => Promise<{
  user: { id: string; name?: string | null; email?: string | null };
  expires: string;
} | null>;

const mockedAuth = vi.mocked(auth) as unknown as ReturnType<typeof vi.fn<SimpleAuthFn>>;
const mockedWorkspaceFindById = vi.mocked(WorkspaceModel.findById);
const mockedConversationFindById = vi.mocked(ConversationModel.findById);
const mockedMessageFind = vi.mocked(MessageModel.find);
const mockedFileFind = vi.mocked(FileModel.find);

function fakeSession(userId: string) {
  return { user: { id: userId, name: "Sample Student", email: "sample.student@example.com" }, expires: "2099-01-01" } as never;
}

function ownedWorkspace(id: string, ownerId: string) {
  return { _id: new Types.ObjectId(id), userId: new Types.ObjectId(ownerId), name: "DBMS" } as never;
}

function ownedConversation(id: string, workspaceId: string) {
  return { _id: new Types.ObjectId(id), workspaceId: new Types.ObjectId(workspaceId) } as never;
}

function messagesRequest(workspaceId?: string) {
  const url = workspaceId
    ? `http://localhost/api/conversations/conv/messages?workspaceId=${workspaceId}`
    : "http://localhost/api/conversations/conv/messages";
  return new Request(url);
}

function routeParams(conversationId: string) {
  return { params: Promise.resolve({ id: conversationId }) };
}

/** `MessageModel.find(...).sort(...)` — matches the established
 * `.find().sort()` chain-mocking convention (tests/unit/workspaces-api.test.ts,
 * tests/unit/m5-conversations-route.test.ts). */
function mockMessageFindChain(docs: unknown[]) {
  const sortMock = vi.fn().mockResolvedValue(docs);
  mockedMessageFind.mockReturnValue({ sort: sortMock } as never);
  return { sortMock };
}

function fakeMessage(overrides: {
  id?: Types.ObjectId;
  role?: "user" | "assistant";
  content?: string;
  createdAt?: Date;
  citations?: unknown[];
}) {
  return {
    _id: overrides.id ?? new Types.ObjectId(),
    role: overrides.role ?? "user",
    content: overrides.content ?? "Hello",
    createdAt: overrides.createdAt ?? new Date("2026-01-01T00:00:00.000Z"),
    citations: overrides.citations,
  } as never;
}

function fakeFile(id: Types.ObjectId, originalName: string, storageUrl: string) {
  return { _id: id, originalName, storageUrl } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/conversations/[id]/messages", () => {
  it("returns 401 when unauthenticated", async () => {
    mockedAuth.mockResolvedValue(null);

    const response = await GET(messagesRequest("ws1"), routeParams("conv1"));

    expect(response.status).toBe(401);
    expect(mockedMessageFind).not.toHaveBeenCalled();
  });

  it("returns 404 for a nonexistent conversation", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    mockedConversationFindById.mockResolvedValue(null as never);

    const response = await GET(messagesRequest(workspaceId), routeParams(new Types.ObjectId().toString()));

    expect(response.status).toBe(404);
    expect(mockedMessageFind).not.toHaveBeenCalled();
  });

  it("returns 404 when the workspace is not owned by the caller", async () => {
    const userId = new Types.ObjectId().toString();
    const otherUserId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, otherUserId));

    const response = await GET(messagesRequest(workspaceId), routeParams(new Types.ObjectId().toString()));

    expect(response.status).toBe(404);
    expect(mockedMessageFind).not.toHaveBeenCalled();
  });

  it("returns 404 when the conversation belongs to a different workspace (cross-workspace isolation)", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    const otherWorkspaceId = new Types.ObjectId().toString();
    const conversationId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    // The conversation is real, but belongs to a workspace other than the
    // one the caller asserted ownership of.
    mockedConversationFindById.mockResolvedValue(ownedConversation(conversationId, otherWorkspaceId));

    const response = await GET(messagesRequest(workspaceId), routeParams(conversationId));

    expect(response.status).toBe(404);
    expect(mockedMessageFind).not.toHaveBeenCalled();
  });

  it("returns 404 when workspaceId is omitted (never falls back to trusting an implicit workspace)", async () => {
    const userId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));

    const response = await GET(messagesRequest(undefined), routeParams(new Types.ObjectId().toString()));

    expect(response.status).toBe(404);
    expect(mockedMessageFind).not.toHaveBeenCalled();
  });

  it("returns an empty message list for a conversation with no messages", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    const conversationId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    mockedConversationFindById.mockResolvedValue(ownedConversation(conversationId, workspaceId));
    mockMessageFindChain([]);
    mockedFileFind.mockResolvedValue([]);

    const response = await GET(messagesRequest(workspaceId), routeParams(conversationId));
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({ conversationId, messages: [] });
  });

  it("returns messages in chronological order (oldest first) via the query itself", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    const conversationId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    mockedConversationFindById.mockResolvedValue(ownedConversation(conversationId, workspaceId));
    const { sortMock } = mockMessageFindChain([]);
    mockedFileFind.mockResolvedValue([]);

    await GET(messagesRequest(workspaceId), routeParams(conversationId));

    expect(mockedMessageFind).toHaveBeenCalledWith({ conversationId });
    expect(sortMock).toHaveBeenCalledWith({ createdAt: 1 });
  });

  it("returns id, role, content, createdAt for a plain message with no citations", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    const conversationId = new Types.ObjectId().toString();
    const messageId = new Types.ObjectId();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    mockedConversationFindById.mockResolvedValue(ownedConversation(conversationId, workspaceId));
    mockMessageFindChain([
      fakeMessage({ id: messageId, role: "user", content: "What is a deadlock?", createdAt: new Date("2026-01-01T00:00:00.000Z") }),
    ]);
    mockedFileFind.mockResolvedValue([]);

    const response = await GET(messagesRequest(workspaceId), routeParams(conversationId));
    const data = await response.json();

    expect(data.messages).toEqual([
      { id: messageId.toString(), role: "user", content: "What is a deadlock?", createdAt: "2026-01-01T00:00:00.000Z" },
    ]);
    expect(data.messages[0]).not.toHaveProperty("citations");
  });

  it("restores a valid citation with the real file's name and URL, matching the live chat SourceAttribution shape", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    const conversationId = new Types.ObjectId().toString();
    const fileId = new Types.ObjectId();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    mockedConversationFindById.mockResolvedValue(ownedConversation(conversationId, workspaceId));
    mockMessageFindChain([
      fakeMessage({
        role: "assistant",
        content: "A deadlock is described on page 12.",
        citations: [{ fileId, type: "pdf", pageNumber: 12 }],
      }),
    ]);
    mockedFileFind.mockResolvedValue([fakeFile(fileId, "os-notes.pdf", "https://storage.example/os-notes.pdf")]);

    const response = await GET(messagesRequest(workspaceId), routeParams(conversationId));
    const data = await response.json();

    expect(data.messages[0].citations).toEqual([
      {
        type: "pdf_page",
        sourceFile: "os-notes.pdf",
        fileId: fileId.toString(),
        location: 12,
        label: "os-notes.pdf, page 12",
        fileUrl: "https://storage.example/os-notes.pdf",
        disabled: false,
      },
    ]);
  });

  it("restores a video citation the same way (timestampSeconds -> location, video_timestamp type)", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    const conversationId = new Types.ObjectId().toString();
    const fileId = new Types.ObjectId();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    mockedConversationFindById.mockResolvedValue(ownedConversation(conversationId, workspaceId));
    mockMessageFindChain([
      fakeMessage({
        role: "assistant",
        content: "Explained at 1:30.",
        citations: [{ fileId, type: "video", timestampSeconds: 90 }],
      }),
    ]);
    mockedFileFind.mockResolvedValue([fakeFile(fileId, "lecture.mp4", "https://storage.example/lecture.mp4")]);

    const response = await GET(messagesRequest(workspaceId), routeParams(conversationId));
    const data = await response.json();

    expect(data.messages[0].citations[0]).toEqual({
      type: "video_timestamp",
      sourceFile: "lecture.mp4",
      fileId: fileId.toString(),
      location: 90,
      label: "lecture.mp4 at 90s",
      fileUrl: "https://storage.example/lecture.mp4",
      disabled: false,
    });
  });

  it("disables a citation whose file no longer exists in this workspace, and never exposes a fileUrl for it", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    const conversationId = new Types.ObjectId().toString();
    const deletedFileId = new Types.ObjectId();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    mockedConversationFindById.mockResolvedValue(ownedConversation(conversationId, workspaceId));
    mockMessageFindChain([
      fakeMessage({
        role: "assistant",
        content: "Referenced a file that's gone now.",
        citations: [{ fileId: deletedFileId, type: "pdf", pageNumber: 4 }],
      }),
    ]);
    // The file is NOT in the current workspace file list — deleted, or
    // moved to a different workspace since the message was sent.
    mockedFileFind.mockResolvedValue([]);

    const response = await GET(messagesRequest(workspaceId), routeParams(conversationId));
    const data = await response.json();

    expect(data.messages[0].citations[0]).toMatchObject({ disabled: true, fileId: deletedFileId.toString() });
    expect(data.messages[0].citations[0]).not.toHaveProperty("fileUrl");
  });

  it("never returns messages from another workspace's file set as valid citations (cross-workspace citation isolation)", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    const conversationId = new Types.ObjectId().toString();
    const otherWorkspaceFileId = new Types.ObjectId();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    mockedConversationFindById.mockResolvedValue(ownedConversation(conversationId, workspaceId));
    mockMessageFindChain([
      fakeMessage({
        role: "assistant",
        content: "...",
        citations: [{ fileId: otherWorkspaceFileId, type: "pdf", pageNumber: 1 }],
      }),
    ]);
    // FileModel.find is scoped to `workspaceId` by the route itself; a file
    // that only exists in a different workspace is correctly absent here.
    mockedFileFind.mockResolvedValue([]);

    const response = await GET(messagesRequest(workspaceId), routeParams(conversationId));
    const data = await response.json();

    expect(data.messages[0].citations[0].disabled).toBe(true);
    expect(mockedFileFind).toHaveBeenCalledWith({ workspaceId });
  });

  it("queries FileModel scoped to the conversation's own workspace, not a client-suppliable value", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    const conversationId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    mockedConversationFindById.mockResolvedValue(ownedConversation(conversationId, workspaceId));
    mockMessageFindChain([]);
    mockedFileFind.mockResolvedValue([]);

    await GET(messagesRequest(workspaceId), routeParams(conversationId));

    expect(mockedFileFind).toHaveBeenCalledWith({ workspaceId });
  });
});
