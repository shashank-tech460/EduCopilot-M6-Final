import { describe, expect, it, vi, beforeEach } from "vitest";
import { Types } from "mongoose";

/**
 * Tests the /api/chat route directly (real Request, real streaming
 * response body consumed and decoded), with `auth`, `connectToDatabase`,
 * `WorkspaceModel` (used internally by the real, un-mocked
 * assertOwnership()), and `services/teamB` mocked. No live MongoDB
 * connection, no live network call. Mirrors the approach already
 * established in tests/unit/files-api.test.ts and workspaces-api.test.ts.
 *
 * The streaming response itself is NOT mocked — this exercises the real
 * `createUIMessageStream`/`createUIMessageStreamResponse` primitives from
 * the installed `ai` package, so these tests prove actual SSE streaming
 * happens, not just that the right functions were called.
 */

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("@/lib/mongodb", () => ({
  connectToDatabase: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/models/Workspace", () => ({
  WorkspaceModel: {
    findById: vi.fn(),
  },
}));

vi.mock("@/models/Conversation", () => ({
  ConversationModel: {
    findById: vi.fn(),
    findOneAndUpdate: vi.fn(),
  },
}));

vi.mock("@/models/Message", () => ({
  MessageModel: {
    create: vi.fn(),
    find: vi.fn(),
  },
}));

vi.mock("@/models/File", () => ({
  FileModel: {
    find: vi.fn(),
  },
}));

vi.mock("@/services/teamB", () => ({
  getTeamBService: vi.fn(),
}));

import { auth } from "@/lib/auth";
import { WorkspaceModel } from "@/models/Workspace";
import { ConversationModel } from "@/models/Conversation";
import { MessageModel } from "@/models/Message";
import { FileModel } from "@/models/File";
import { getTeamBService } from "@/services/teamB";
import { POST } from "@/app/api/chat/route";
import { TeamBQueryError } from "@/services/teamB/client";

type SimpleAuthFn = () => Promise<{
  user: { id: string; name?: string | null; email?: string | null };
  expires: string;
} | null>;

const mockedAuth = vi.mocked(auth) as unknown as ReturnType<typeof vi.fn<SimpleAuthFn>>;
const mockedWorkspaceFindById = vi.mocked(WorkspaceModel.findById);
const mockedConversationFindById = vi.mocked(ConversationModel.findById);
const mockedConversationFindOneAndUpdate = vi.mocked(ConversationModel.findOneAndUpdate);
const mockedMessageCreate = vi.mocked(MessageModel.create);
const mockedMessageFind = vi.mocked(MessageModel.find);
const mockedFileFind = vi.mocked(FileModel.find);

function messageFindResult(messages: unknown[]) {
  const query = {
    sort: () => query,
    limit: () => query,
    select: () => Promise.resolve(messages),
  };
  return query;
}

/** MVP M5: a fixed, well-known, valid-ObjectId conversation id shared by
 * every test that doesn't specifically exercise conversation
 * authorization/backfill itself -- paired with `ownedConversation()` and
 * `authorizeDefaultConversation()` below to keep the majority of
 * pre-existing (pre-M5) tests unchanged in intent. */
const DEFAULT_CONVERSATION_ID = "6aa1c4d537e42519bd73e1cc";

function ownedConversation(id: string, workspaceId: string, ragSessionId: string | undefined = "existing-session-1") {
  return { _id: new Types.ObjectId(id), workspaceId: new Types.ObjectId(workspaceId), ragSessionId } as never;
}

/** Configures both Conversation mocks so `assertConversationOwnership`
 * + `getOrCreateRagSessionId` succeed for `DEFAULT_CONVERSATION_ID`
 * against `workspaceId`, already carrying a ragSessionId (the common,
 * "not the first message" case) -- call this after setting up
 * `mockedWorkspaceFindById` in any test using the default conversation. */
function authorizeDefaultConversation(workspaceId: string, ragSessionId = "existing-session-1") {
  mockedConversationFindById.mockResolvedValue(ownedConversation(DEFAULT_CONVERSATION_ID, workspaceId, ragSessionId));
}
const mockedGetTeamBService = vi.mocked(getTeamBService);

function fakeSession(userId: string) {
  return {
    user: { id: userId, name: "Sample Student", email: "sample.student@example.com" },
    expires: "2099-01-01",
  } as never;
}

function ownedWorkspace(id: string, ownerId: string) {
  return { _id: new Types.ObjectId(id), userId: new Types.ObjectId(ownerId), name: "DBMS" } as never;
}

function chatRequest(body: Record<string, unknown>) {
  // MVP M5: every existing call site predates `conversationId` -- default
  // it to the shared, well-known test conversation id unless a test
  // explicitly passes its own (e.g. to test authorization/backfill).
  const bodyWithConversation = { conversationId: DEFAULT_CONVERSATION_ID, ...body };
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(bodyWithConversation),
  });
}

function userMessage(text: string) {
  return {
    id: "m1",
    role: "user",
    parts: [{ type: "text", text }],
  };
}

async function readSseText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let raw = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    raw += decoder.decode(value, { stream: true });
  }
  // Extract every text-delta chunk's `delta` field from the raw SSE body
  // and concatenate them, mirroring what the real client-side useChat
  // would reconstruct from the stream.
  const deltas = [...raw.matchAll(/"type":"text-delta"[^}]*"delta":"([^"]*)"/g)].map((m) => m[1]);
  return deltas.join("");
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedGetTeamBService.mockReturnValue({
    query: vi.fn().mockResolvedValue({ answer: "Normalization reduces redundancy.", session_id: "s", source_attributions: [], retrieval_metadata: {} }),
  });
  mockedFileFind.mockResolvedValue([]);
  mockedMessageCreate.mockResolvedValue({} as never);
  mockedMessageFind.mockReturnValue(messageFindResult([]) as never);
  // MVP M5 default: findOneAndUpdate (the atomic backfill path) matches
  // nothing by default -- i.e. "this conversation already has a
  // ragSessionId", which is what `mockedConversationFindById`'s default
  // configuration (set per-test via `authorizeDefaultConversation`)
  // then supplies via the plain-read fallback in `getOrCreateRagSessionId`.
  mockedConversationFindOneAndUpdate.mockResolvedValue(null);
});

describe("POST /api/chat", () => {
  it("returns 401 when unauthenticated — no Team B call, no stream started", async () => {
    mockedAuth.mockResolvedValue(null);

    const response = await POST(
      chatRequest({ messages: [userMessage("hi")], workspaceId: "ws-1", videoTimestamp: null })
    );

    expect(response.status).toBe(401);
    expect(mockedGetTeamBService).not.toHaveBeenCalled();
  });

  it("returns a safe 404 when the workspace belongs to another user — item: workspace isolation", async () => {
    const ownerId = new Types.ObjectId().toString();
    const attackerId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(attackerId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, ownerId));
    authorizeDefaultConversation(workspaceId);

    const response = await POST(
      chatRequest({ messages: [userMessage("hi")], workspaceId, videoTimestamp: null })
    );

    expect(response.status).toBe(404);
    expect(mockedGetTeamBService).not.toHaveBeenCalled();
  });

  it("does not trust a client-supplied workspaceId without verifying ownership — malformed id is safely rejected", async () => {
    mockedAuth.mockResolvedValue(fakeSession(new Types.ObjectId().toString()));

    const response = await POST(
      chatRequest({ messages: [userMessage("hi")], workspaceId: "not-a-real-id", videoTimestamp: null })
    );

    expect(response.status).toBe(404);
    expect(mockedWorkspaceFindById).not.toHaveBeenCalled();
  });

  it("streams the mock Team B answer back as real incremental SSE text-delta chunks — Property 1/2", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    authorizeDefaultConversation(workspaceId);

    const response = await POST(
      chatRequest({
        messages: [userMessage("What is normalization?")],
        workspaceId,
        videoTimestamp: null,
      })
    );

    expect(response.status).toBe(200);
    const text = await readSseText(response);
    expect(text.trim()).toBe("Normalization reduces redundancy.");
  });

  it("passes query, workspaceId, and videoTimestamp through to Team B — Property 1 (payload completeness)", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    authorizeDefaultConversation(workspaceId);
    const queryMock = vi.fn().mockResolvedValue({ answer: "answer" });
    mockedGetTeamBService.mockReturnValue({ query: queryMock });

    await POST(
      chatRequest({
        messages: [userMessage("What is normalization?")],
        workspaceId,
        videoTimestamp: 1935,
      })
    );

    expect(queryMock).toHaveBeenCalledWith({
      query: "What is normalization?",
      session_id: "existing-session-1",
      retrieval_config: null,
      workspaceId,
      videoTimestamp: 1935,
      sub: userId,
      workspace_id: workspaceId,
    });
  });

  it("passes null videoTimestamp through unchanged when no video is active — Property 1", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    authorizeDefaultConversation(workspaceId);
    const queryMock = vi.fn().mockResolvedValue({ answer: "answer" });
    mockedGetTeamBService.mockReturnValue({ query: queryMock });

    await POST(
      chatRequest({ messages: [userMessage("hi")], workspaceId, videoTimestamp: null })
    );

    expect(queryMock).toHaveBeenCalledWith(
      expect.objectContaining({ videoTimestamp: null })
    );
  });

  it("extracts only the most recent user message's text when history has multiple turns", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    authorizeDefaultConversation(workspaceId);
    const queryMock = vi.fn().mockResolvedValue({ answer: "answer" });
    mockedGetTeamBService.mockReturnValue({ query: queryMock });

    await POST(
      chatRequest({
        messages: [
          userMessage("first question"),
          { id: "m2", role: "assistant", parts: [{ type: "text", text: "first answer" }] },
          userMessage("second question"),
        ],
        workspaceId,
        videoTimestamp: null,
      })
    );

    expect(queryMock).toHaveBeenCalledWith(
      expect.objectContaining({ query: "second question" })
    );
  });
});

/**
 * Requirement 3 (Source Attribution) — verifies the actual server-side
 * enforcement: citations are matched against REAL workspace files fetched
 * from MongoDB (mocked here), not trusted as-is from Team B. This is the
 * genuine security-relevant behavior lib/workspaceFilter.ts + this route
 * are responsible for — not merely that a citations array round-trips.
 */
describe("POST /api/chat — Source Attribution (Requirement 3)", () => {
  it("marks a citation enabled when its fileId matches a real file in the active workspace", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    const realFileId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    authorizeDefaultConversation(workspaceId);
    mockedFileFind.mockResolvedValue([
      { _id: new Types.ObjectId(realFileId), storageUrl: "https://example.test/lecture.mp4" },
    ] as never);
    mockedGetTeamBService.mockReturnValue({
      query: vi.fn().mockResolvedValue({
        answer: "See the lecture.",
        session_id: "sess-1",
        source_attributions: [
          { document_id: realFileId, document_title: "Lecture.mp4", chunk_id: "c1", relevance_score: 0.9, start_timestamp: 90 },
        ],
        retrieval_metadata: {},
      }),
    });

    const response = await POST(
      chatRequest({ messages: [userMessage("hi")], workspaceId, videoTimestamp: null })
    );
    const raw = await response.text();
    const dataMatch = raw.match(/"type":"data-citations","data":(\[.*?\])\}/);
    const citations = JSON.parse(dataMatch?.[1] ?? "[]");

    expect(citations[0].disabled).toBeFalsy();
    expect(citations[0].fileUrl).toBe("https://example.test/lecture.mp4");
  });

  it("marks a citation disabled when its fileId does NOT match any real file in the active workspace — Property 7", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    authorizeDefaultConversation(workspaceId);
    // The active workspace has no files at all — the citation's fileId
    // cannot possibly belong to it.
    mockedFileFind.mockResolvedValue([]);
    mockedGetTeamBService.mockReturnValue({
      query: vi.fn().mockResolvedValue({
        answer: "See the lecture.",
        session_id: "sess-1",
        source_attributions: [
          {
            document_id: new Types.ObjectId().toString(),
            document_title: "SomeoneElses.mp4",
            chunk_id: "c1",
            relevance_score: 0.9,
            start_timestamp: 90,
          },
        ],
        retrieval_metadata: {},
      }),
    });

    const response = await POST(
      chatRequest({ messages: [userMessage("hi")], workspaceId, videoTimestamp: null })
    );
    const raw = await response.text();
    const dataMatch = raw.match(/"type":"data-citations","data":(\[.*?\])\}/);
    const citations = JSON.parse(dataMatch?.[1] ?? "[]");

    expect(citations[0].disabled).toBe(true);
  });

  it("logs a server-side security warning when a citation referencing a file outside the workspace is filtered — Property 13", async () => {
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    authorizeDefaultConversation(workspaceId);
    mockedFileFind.mockResolvedValue([]);
    mockedGetTeamBService.mockReturnValue({
      query: vi.fn().mockResolvedValue({
        answer: "See the lecture.",
        session_id: "sess-1",
        source_attributions: [
          {
            document_id: new Types.ObjectId().toString(),
            document_title: "SomeoneElses.mp4",
            chunk_id: "c1",
            relevance_score: 0.9,
            timestampSeconds: 90,
          },
        ],
      }),
    });

    await POST(chatRequest({ messages: [userMessage("hi")], workspaceId, videoTimestamp: null }));

    // The log is server-side only — verified here, but never sent to the
    // client in the response body (the client only ever sees the already-
    // safe `disabled: true` citation, confirmed by the test above).
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining(`outside workspace ${workspaceId}`)
    );

    consoleWarnSpy.mockRestore();
  });

  it("does NOT log a security warning when every citation belongs to the active workspace", async () => {
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    const realFileId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    authorizeDefaultConversation(workspaceId);
    mockedFileFind.mockResolvedValue([
      { _id: new Types.ObjectId(realFileId), storageUrl: "https://example.test/lecture.mp4" },
    ] as never);
    mockedGetTeamBService.mockReturnValue({
      query: vi.fn().mockResolvedValue({
        answer: "See the lecture.",
        session_id: "sess-1",
        source_attributions: [
          { document_id: realFileId, document_title: "Lecture.mp4", chunk_id: "c1", relevance_score: 0.9, start_timestamp: 90 },
        ],
        retrieval_metadata: {},
      }),
    });

    await POST(chatRequest({ messages: [userMessage("hi")], workspaceId, videoTimestamp: null }));

    expect(consoleWarnSpy).not.toHaveBeenCalled();
    consoleWarnSpy.mockRestore();
  });

  it("omits the citations data part entirely when Team B returns no citations", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    authorizeDefaultConversation(workspaceId);
    mockedGetTeamBService.mockReturnValue({
      query: vi.fn().mockResolvedValue({ answer: "Just an answer, no sources." }),
    });

    const response = await POST(
      chatRequest({ messages: [userMessage("hi")], workspaceId, videoTimestamp: null })
    );
    const raw = await response.text();

    expect(raw).not.toContain("data-citations");
  });
});

describe("POST /api/chat — Property 11 (workspace data isolation, two real workspaces)", () => {
  it("scopes the file lookup to only the requesting workspace, even when the user owns a second workspace with different files", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceAId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    // The same user owns BOTH workspaces — this specifically proves
    // isolation isn't just "different owners are blocked" (already covered
    // elsewhere), but that even the same user's own second workspace's
    // files are never implicitly available to the first.
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceAId, userId));
    authorizeDefaultConversation(workspaceAId);
    mockedFileFind.mockResolvedValue([]); // Workspace A has no files.

    const workspaceBFileId = new Types.ObjectId().toString();
    mockedGetTeamBService.mockReturnValue({
      query: vi.fn().mockResolvedValue({
        answer: "See the lecture.",
        // Simulates Team B (or a bug) returning a citation for a file
        // that genuinely exists — just in the user's OTHER workspace.
        session_id: "sess-1",
        source_attributions: [
          { document_id: workspaceBFileId, document_title: "OtherWorkspaceLecture.mp4", chunk_id: "c1", relevance_score: 0.9, start_timestamp: 10 },
        ],
        retrieval_metadata: {},
      }),
    });

    const response = await POST(
      chatRequest({ messages: [userMessage("hi")], workspaceId: workspaceAId, videoTimestamp: null })
    );

    // FileModel.find was called scoped to workspace A specifically, never
    // workspace B or "all of this user's files" — this is the actual
    // isolation mechanism, not just a plausible-looking result.
    expect(mockedFileFind).toHaveBeenCalledWith({ workspaceId: workspaceAId });

    const raw = await response.text();
    const dataMatch = raw.match(/"type":"data-citations","data":(\[.*?\])\}/);
    const citations = JSON.parse(dataMatch?.[1] ?? "[]");

    // Workspace B's file is NOT usable from within workspace A's session,
    // even though the user legitimately owns it elsewhere.
    expect(citations[0].disabled).toBe(true);
  });

  it("a workspace ID for a workspace the user does not own at all cannot be used to reach any file data", async () => {
    const ownerId = new Types.ObjectId().toString();
    const attackerId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(attackerId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, ownerId));
    authorizeDefaultConversation(workspaceId);

    const response = await POST(
      chatRequest({ messages: [userMessage("hi")], workspaceId, videoTimestamp: null })
    );

    expect(response.status).toBe(404);
    // Ownership fails before the file lookup ever runs — no partial data
    // access on the way to the rejection.
    expect(mockedFileFind).not.toHaveBeenCalled();
  });
});

// ============================================================
// Phase 2E CORRECTION — real Team 4B response-contract mapping
// (app/models/query.py's actual QueryResponse/SourceAttribution shape,
// not the earlier, incorrect internal "citations" representation)
// ============================================================

describe("POST /api/chat — Team 4B response-contract adapter (Phase 2E correction)", () => {
  it("A/B: an actual 4B-shaped response (source_attributions, session_id, retrieval_metadata) parses and answer is preserved", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    const realFileId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    authorizeDefaultConversation(workspaceId);
    mockedFileFind.mockResolvedValue([
      { _id: new Types.ObjectId(realFileId), storageUrl: "https://example.test/notes.pdf" },
    ] as never);
    mockedGetTeamBService.mockReturnValue({
      query: vi.fn().mockResolvedValue({
        answer: "Normalization reduces redundancy.",
        session_id: "real-session-abc",
        source_attributions: [
          {
            document_id: realFileId,
            document_title: "Notes.pdf",
            chunk_id: "chunk-42",
            relevance_score: 0.87,
            page_number: 3,
            section_heading: "Normal Forms",
          },
        ],
        retrieval_metadata: { chunks_retrieved: 5, search_mode: "hybrid" },
      }),
    });

    const response = await POST(chatRequest({ messages: [userMessage("hi")], workspaceId, videoTimestamp: null }));
    const text = await readSseText(response);

    expect(response.status).toBe(200);
    expect(text).toContain("Normalization reduces redundancy.");
  });

  it("C/D/E: multiple document attributions are converted to 4C citations with all fields mapped correctly", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    const fileId1 = new Types.ObjectId().toString();
    const fileId2 = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    authorizeDefaultConversation(workspaceId);
    mockedFileFind.mockResolvedValue([
      { _id: new Types.ObjectId(fileId1), storageUrl: "https://example.test/a.pdf" },
      { _id: new Types.ObjectId(fileId2), storageUrl: "https://example.test/b.pdf" },
    ] as never);
    mockedGetTeamBService.mockReturnValue({
      query: vi.fn().mockResolvedValue({
        answer: "See both sources.",
        session_id: "sess-multi",
        source_attributions: [
          {
            document_id: fileId1,
            document_title: "A.pdf",
            chunk_id: "chunk-a1",
            relevance_score: 0.91,
            page_number: 1,
            section_heading: "Intro",
          },
          {
            document_id: fileId2,
            document_title: "B.pdf",
            chunk_id: "chunk-b1",
            relevance_score: 0.82,
            page_number: 7,
            section_heading: null,
          },
        ],
        retrieval_metadata: {},
      }),
    });

    const response = await POST(chatRequest({ messages: [userMessage("hi")], workspaceId, videoTimestamp: null }));
    const raw = await response.text();
    const dataMatch = raw.match(/"type":"data-citations","data":(\[.*?\])\}/);
    const citations = JSON.parse(dataMatch?.[1] ?? "[]");

    expect(citations).toHaveLength(2);
    expect(citations[0]).toMatchObject({
      type: "pdf_page",
      fileId: fileId1,
      sourceFile: "A.pdf",
      location: 1,
      chunkId: "chunk-a1",
      relevanceScore: 0.91,
      sectionHeading: "Intro",
    });
    expect(citations[1]).toMatchObject({
      type: "pdf_page",
      fileId: fileId2,
      sourceFile: "B.pdf",
      location: 7,
      chunkId: "chunk-b1",
      relevanceScore: 0.82,
    });
  });

  it("F: video timestamp attribution fields (start_timestamp/end_timestamp) map correctly", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    const fileId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    authorizeDefaultConversation(workspaceId);
    mockedFileFind.mockResolvedValue([
      { _id: new Types.ObjectId(fileId), storageUrl: "https://example.test/lecture.mp4" },
    ] as never);
    mockedGetTeamBService.mockReturnValue({
      query: vi.fn().mockResolvedValue({
        answer: "Explained at that point in the video.",
        session_id: "sess-video",
        source_attributions: [
          {
            document_id: fileId,
            document_title: "Lecture.mp4",
            chunk_id: "chunk-v1",
            relevance_score: 0.76,
            start_timestamp: 125.5,
            end_timestamp: 140.0,
          },
        ],
        retrieval_metadata: {},
      }),
    });

    const response = await POST(chatRequest({ messages: [userMessage("hi")], workspaceId, videoTimestamp: null }));
    const raw = await response.text();
    const dataMatch = raw.match(/"type":"data-citations","data":(\[.*?\])\}/);
    const citations = JSON.parse(dataMatch?.[1] ?? "[]");

    expect(citations[0]).toMatchObject({
      type: "video_timestamp",
      fileId,
      sourceFile: "Lecture.mp4",
      location: 125.5,
      chunkId: "chunk-v1",
      relevanceScore: 0.76,
    });
  });

  it("G: null optional fields (page_number, section_heading, start_timestamp, end_timestamp all null) do not break mapping", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    const fileId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    authorizeDefaultConversation(workspaceId);
    mockedFileFind.mockResolvedValue([
      { _id: new Types.ObjectId(fileId), storageUrl: "https://example.test/f.pdf" },
    ] as never);
    mockedGetTeamBService.mockReturnValue({
      query: vi.fn().mockResolvedValue({
        answer: "An answer with a minimal attribution.",
        session_id: "sess-minimal",
        source_attributions: [
          {
            document_id: fileId,
            document_title: "F.pdf",
            chunk_id: "chunk-min",
            relevance_score: 0.5,
            page_number: null,
            section_heading: null,
            start_timestamp: null,
            end_timestamp: null,
          },
        ],
        retrieval_metadata: {},
      }),
    });

    const response = await POST(chatRequest({ messages: [userMessage("hi")], workspaceId, videoTimestamp: null }));
    const rawForCitations = await response.clone().text();
    const text = await readSseText(response);
    expect(response.status).toBe(200);
    expect(text).toContain("An answer with a minimal attribution.");
    // Falls through to the "video_timestamp" branch (location 0) rather
    // than throwing -- neither field pair being populated must not crash
    // the adapter.
    const dataMatch = rawForCitations.match(/"type":"data-citations","data":(\[.*?\])\}/);
    const citations = JSON.parse(dataMatch?.[1] ?? "[]");
    expect(citations[0].location).toBe(0);
  });

  it("H: existing workspace citation filtering still applies to real 4B-shaped attributions", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    authorizeDefaultConversation(workspaceId);
    mockedFileFind.mockResolvedValue([]); // no files in this workspace at all
    mockedGetTeamBService.mockReturnValue({
      query: vi.fn().mockResolvedValue({
        answer: "See the source.",
        session_id: "sess-filter",
        source_attributions: [
          {
            document_id: new Types.ObjectId().toString(), // belongs to no file in this workspace
            document_title: "NotMine.pdf",
            chunk_id: "chunk-x",
            relevance_score: 0.6,
            page_number: 1,
          },
        ],
        retrieval_metadata: {},
      }),
    });

    const response = await POST(chatRequest({ messages: [userMessage("hi")], workspaceId, videoTimestamp: null }));
    const raw = await response.text();
    const dataMatch = raw.match(/"type":"data-citations","data":(\[.*?\])\}/);
    const citations = JSON.parse(dataMatch?.[1] ?? "[]");

    expect(citations[0].disabled).toBe(true);
  });
});

describe("POST /api/chat — session_id / retrieval_metadata preservation at the integration boundary (I/J)", () => {
  it("I: session_id from the real 4B response is destructured and available at the integration boundary, without crashing when unused further", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    authorizeDefaultConversation(workspaceId);
    mockedFileFind.mockResolvedValue([]);
    const queryMock = vi.fn().mockResolvedValue({
      answer: "An answer.",
      session_id: "a-real-4b-issued-session-id",
      source_attributions: [],
      retrieval_metadata: {},
    });
    mockedGetTeamBService.mockReturnValue({ query: queryMock });

    const response = await POST(chatRequest({ messages: [userMessage("hi")], workspaceId, videoTimestamp: null }));

    // The route does not yet persist/forward session_id anywhere further
    // (Phase 2A's ragSessionId gap remains unresolved, unchanged by this
    // correction) -- this test proves the value is genuinely read from
    // the real response (destructured without error) rather than the
    // route crashing or ignoring the field's presence entirely.
    expect(response.status).toBe(200);
    expect(queryMock).toHaveBeenCalled();
  });

  it("J: retrieval_metadata from the real 4B response is destructured without crashing; not currently surfaced further (documented, not a bug)", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    authorizeDefaultConversation(workspaceId);
    mockedFileFind.mockResolvedValue([]);
    mockedGetTeamBService.mockReturnValue({
      query: vi.fn().mockResolvedValue({
        answer: "An answer.",
        session_id: "sess-1",
        source_attributions: [],
        // A realistically-shaped, open retrieval_metadata dict -- 4B's
        // own schema leaves this intentionally open (app/models/query.py),
        // so this test uses an example shape, not an assumed fixed one.
        retrieval_metadata: { chunks_retrieved: 3, search_mode: "hybrid", latency_ms: 42 },
      }),
    });

    const response = await POST(chatRequest({ messages: [userMessage("hi")], workspaceId, videoTimestamp: null }));

    // Response-level (not per-citation) data -- current 4C integration
    // type (TeamBQueryResponse) exposes it (types/teamB.ts), and
    // app/api/chat/route.ts destructures it at the boundary, but does
    // not currently forward it into the chat response body -- there is
    // no per-citation or per-message slot for response-level retrieval
    // metadata in the existing UI contract. Documented here explicitly,
    // per this correction's own Requirement J, rather than silently
    // dropped without explanation.
    expect(response.status).toBe(200);
  });
});


// ---------------------------------------------------------------------------
// MVP M5 — conversation / RAG session integration
// ---------------------------------------------------------------------------

describe("POST /api/chat — MVP M5: conversation session integration", () => {
  it("13/multi-turn: a follow-up question in the same conversation sends the same session_id both times", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    const conversationId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    authorizeDefaultConversation(workspaceId); // uses DEFAULT_CONVERSATION_ID by default; override below
    mockedConversationFindById.mockResolvedValue(ownedConversation(conversationId, workspaceId, "stable-session-xyz"));
    const queryMock = vi.fn().mockResolvedValue({ answer: "answer", session_id: "s", source_attributions: [], retrieval_metadata: {} });
    mockedGetTeamBService.mockReturnValue({ query: queryMock });

    await POST(chatRequest({ messages: [userMessage("What is a process?")], workspaceId, conversationId, videoTimestamp: null }));
    await POST(
      chatRequest({ messages: [userMessage("Explain the second point in more detail.")], workspaceId, conversationId, videoTimestamp: null })
    );

    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(queryMock.mock.calls[0][0].session_id).toBe("stable-session-xyz");
    expect(queryMock.mock.calls[1][0].session_id).toBe("stable-session-xyz");
  });

  it("12/different conversations: two different conversations in the same workspace receive different session_id values", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    const conversationId1 = new Types.ObjectId().toString();
    const conversationId2 = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    mockedConversationFindById.mockImplementation((async (id: unknown) => {
      if (String(id) === conversationId1) return ownedConversation(conversationId1, workspaceId, "session-one");
      if (String(id) === conversationId2) return ownedConversation(conversationId2, workspaceId, "session-two");
      return null as never;
    }) as never);
    const queryMock = vi.fn().mockResolvedValue({ answer: "answer", session_id: "s", source_attributions: [], retrieval_metadata: {} });
    mockedGetTeamBService.mockReturnValue({ query: queryMock });

    await POST(chatRequest({ messages: [userMessage("q1")], workspaceId, conversationId: conversationId1, videoTimestamp: null }));
    await POST(chatRequest({ messages: [userMessage("q2")], workspaceId, conversationId: conversationId2, videoTimestamp: null }));

    expect(queryMock.mock.calls[0][0].session_id).toBe("session-one");
    expect(queryMock.mock.calls[1][0].session_id).toBe("session-two");
    expect(queryMock.mock.calls[0][0].session_id).not.toBe(queryMock.mock.calls[1][0].session_id);
  });

  it("5/6/15: the browser cannot choose ragSessionId/session_id — a body-supplied value is completely ignored", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    authorizeDefaultConversation(workspaceId, "the-real-server-side-session");
    const queryMock = vi.fn().mockResolvedValue({ answer: "answer", session_id: "s", source_attributions: [], retrieval_metadata: {} });
    mockedGetTeamBService.mockReturnValue({ query: queryMock });

    await POST(
      chatRequest({
        messages: [userMessage("hi")],
        workspaceId,
        videoTimestamp: null,
        // Attacker-supplied fields the browser has no business sending —
        // the route only ever reads `conversationId` from the body, and
        // resolves session_id/ragSessionId itself, server-side.
        session_id: "attacker-chosen-session",
        ragSessionId: "attacker-chosen-session",
      })
    );

    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(queryMock.mock.calls[0][0].session_id).toBe("the-real-server-side-session");
    expect(queryMock.mock.calls[0][0].session_id).not.toBe("attacker-chosen-session");
  });

  it("7/8/9/10: a conversationId belonging to a DIFFERENT workspace is rejected before Team B is ever called", async () => {
    const userId = new Types.ObjectId().toString();
    const authorizedWorkspaceId = new Types.ObjectId().toString();
    const otherWorkspaceId = new Types.ObjectId().toString();
    const otherWorkspacesConversationId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(authorizedWorkspaceId, userId));
    // The conversation genuinely exists, but belongs to a DIFFERENT workspace.
    mockedConversationFindById.mockResolvedValue(
      ownedConversation(otherWorkspacesConversationId, otherWorkspaceId, "session-belongs-to-other-workspace")
    );
    const queryMock = vi.fn();
    mockedGetTeamBService.mockReturnValue({ query: queryMock });

    const response = await POST(
      chatRequest({
        messages: [userMessage("hi")],
        workspaceId: authorizedWorkspaceId,
        conversationId: otherWorkspacesConversationId,
        videoTimestamp: null,
      })
    );

    expect(response.status).toBe(404);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("14: the real 4B request body remains exactly the canonical shape even with conversation/session integration active", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    authorizeDefaultConversation(workspaceId, "session-abc");
    const queryMock = vi.fn().mockResolvedValue({ answer: "answer", session_id: "s", source_attributions: [], retrieval_metadata: {} });
    mockedGetTeamBService.mockReturnValue({ query: queryMock });

    await POST(chatRequest({ messages: [userMessage("hi")], workspaceId, videoTimestamp: null }));

    const calledWith = queryMock.mock.calls[0][0];
    // Only the canonical three fields, plus the auth-context fields the
    // REAL client (services/teamB/client.ts) already strips before the
    // wire body is ever constructed (verified separately in
    // contract-freeze.test.ts) -- this call site itself must not
    // introduce a new forbidden field either.
    expect(Object.keys(calledWith).sort()).toEqual(
      ["query", "session_id", "retrieval_config", "workspaceId", "videoTimestamp", "sub", "workspace_id"].sort()
    );
    expect(calledWith).not.toHaveProperty("conversationId");
    expect(calledWith).not.toHaveProperty("ragSessionId");
  });

  it("stores both the user message and the assistant message in Mongo after a successful response", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    authorizeDefaultConversation(workspaceId);
    mockedGetTeamBService.mockReturnValue({
      query: vi.fn().mockResolvedValue({ answer: "The final answer.", session_id: "s", source_attributions: [], retrieval_metadata: {} }),
    });

    await POST(chatRequest({ messages: [userMessage("What is a process?")], workspaceId, videoTimestamp: null }));

    expect(mockedMessageCreate).toHaveBeenCalledTimes(2);
    expect(mockedMessageCreate).toHaveBeenCalledWith(
      expect.objectContaining({ role: "user", content: "What is a process?" })
    );
    expect(mockedMessageCreate).toHaveBeenCalledWith(
      expect.objectContaining({ role: "assistant", content: "The final answer." })
    );
  });

  it("existing conversations without a ragSessionId are safely backfilled (findOneAndUpdate path) rather than rejected", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    // Simulates a pre-M5 conversation: findById used for AUTHORIZATION
    // returns a doc with no ragSessionId yet; the backfill path
    // (findOneAndUpdate) then succeeds and supplies a fresh one.
    mockedConversationFindById.mockResolvedValue(ownedConversation(DEFAULT_CONVERSATION_ID, workspaceId, undefined));
    mockedConversationFindOneAndUpdate.mockResolvedValue(
      ownedConversation(DEFAULT_CONVERSATION_ID, workspaceId, "freshly-backfilled-session")
    );
    const queryMock = vi.fn().mockResolvedValue({ answer: "answer", session_id: "s", source_attributions: [], retrieval_metadata: {} });
    mockedGetTeamBService.mockReturnValue({ query: queryMock });

    const response = await POST(chatRequest({ messages: [userMessage("hi")], workspaceId, videoTimestamp: null }));

    expect(response.status).toBe(200);
    expect(queryMock.mock.calls[0][0].session_id).toBe("freshly-backfilled-session");
  });
});


describe("POST /api/chat — M6 correction: first-attempt reliability / no duplicate messages on retry", () => {
  it("a failed first attempt (Team B 503) persists ZERO messages; the actual retry request then persists exactly one user+assistant pair", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    authorizeDefaultConversation(workspaceId, "stable-session-for-retry-test");

    const queryMock = vi
      .fn()
      .mockRejectedValueOnce(new TeamBQueryError(503))
      .mockResolvedValueOnce({ answer: "The real answer.", session_id: "s", source_attributions: [], retrieval_metadata: {} });
    mockedGetTeamBService.mockReturnValue({ query: queryMock });

    const firstResponse = await POST(
      chatRequest({ messages: [userMessage("What is a process?")], workspaceId, videoTimestamp: null })
    );
    expect(firstResponse.status).toBe(502);
    expect(mockedMessageCreate).not.toHaveBeenCalled();

    const secondResponse = await POST(
      chatRequest({ messages: [userMessage("What is a process?")], workspaceId, videoTimestamp: null })
    );
    expect(secondResponse.status).toBe(200);

    expect(mockedMessageCreate).toHaveBeenCalledTimes(2); // exactly one user + one assistant, never more
    expect(mockedMessageCreate).toHaveBeenCalledWith(expect.objectContaining({ role: "user", content: "What is a process?" }));
    expect(mockedMessageCreate).toHaveBeenCalledWith(expect.objectContaining({ role: "assistant", content: "The real answer." }));

    // Both attempts used the SAME stable session -- a failed-then-retried
    // attempt never mints a new ragSessionId.
    expect(queryMock.mock.calls[0][0].session_id).toBe("stable-session-for-retry-test");
    expect(queryMock.mock.calls[1][0].session_id).toBe("stable-session-for-retry-test");
  });

  it("a generic network/timeout-shaped error from Team B is also handled cleanly, with zero messages persisted", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    authorizeDefaultConversation(workspaceId);

    mockedGetTeamBService.mockReturnValue({
      query: vi.fn().mockRejectedValue(new Error("fetch failed")),
    });

    const response = await POST(chatRequest({ messages: [userMessage("hi")], workspaceId, videoTimestamp: null }));

    expect(response.status).toBe(502);
    expect(mockedMessageCreate).not.toHaveBeenCalled();
  });
});



function fileFindResult(files: unknown[]) {
  return {
    then: (resolve: (v: unknown[]) => void) => resolve(files),
    select: () => Promise.resolve(files),
  };
}

describe("POST /api/chat — MVP M6: server-authoritative source scope", () => {
  it("no persisted scope (sourceScopeDocumentIds undefined/null) sends retrieval_config: null (workspace-wide)", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    authorizeDefaultConversation(workspaceId); // no sourceScopeDocumentIds set -> undefined
    const queryMock = vi.fn().mockResolvedValue({ answer: "answer", session_id: "s", source_attributions: [], retrieval_metadata: {} });
    mockedGetTeamBService.mockReturnValue({ query: queryMock });

    await POST(chatRequest({ messages: [userMessage("hi")], workspaceId, videoTimestamp: null }));

    expect(queryMock.mock.calls[0][0].retrieval_config).toBeNull();
  });

  it("a persisted, still-valid scope reaches Team B as retrieval_config.document_ids", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    const docA = new Types.ObjectId();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    mockedConversationFindById.mockResolvedValue({
      _id: new Types.ObjectId(DEFAULT_CONVERSATION_ID),
      workspaceId: new Types.ObjectId(workspaceId),
      ragSessionId: "session-1",
      sourceScopeDocumentIds: [docA.toString()],
    } as never);
    mockedFileFind.mockImplementation((query: unknown) => {
      const q = query as { _id?: { $in: string[] } };
      return fileFindResult(q._id ? [{ _id: docA }] : []) as never;
    });
    const queryMock = vi.fn().mockResolvedValue({ answer: "answer", session_id: "s", source_attributions: [], retrieval_metadata: {} });
    mockedGetTeamBService.mockReturnValue({ query: queryMock });

    await POST(chatRequest({ messages: [userMessage("hi")], workspaceId, videoTimestamp: null }));

    expect(queryMock.mock.calls[0][0].retrieval_config).toEqual({ document_ids: [docA.toString()] });
  });

  it("13/follow-up: the same persisted scope is used across two consecutive requests in the same conversation", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    const docA = new Types.ObjectId();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    mockedConversationFindById.mockResolvedValue({
      _id: new Types.ObjectId(DEFAULT_CONVERSATION_ID),
      workspaceId: new Types.ObjectId(workspaceId),
      ragSessionId: "session-1",
      sourceScopeDocumentIds: [docA.toString()],
    } as never);
    mockedFileFind.mockImplementation((query: unknown) => {
      const q = query as { _id?: { $in: string[] } };
      return fileFindResult(q._id ? [{ _id: docA }] : []) as never;
    });
    const queryMock = vi.fn().mockResolvedValue({ answer: "answer", session_id: "s", source_attributions: [], retrieval_metadata: {} });
    mockedGetTeamBService.mockReturnValue({ query: queryMock });

    await POST(chatRequest({ messages: [userMessage("What is a process?")], workspaceId, videoTimestamp: null }));
    await POST(chatRequest({ messages: [userMessage("How is it different from a thread?")], workspaceId, videoTimestamp: null }));

    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(queryMock.mock.calls[0][0].retrieval_config).toEqual({ document_ids: [docA.toString()] });
    expect(queryMock.mock.calls[1][0].retrieval_config).toEqual({ document_ids: [docA.toString()] });
  });

  it("17/21/31: a persisted scope whose document has since been deleted/failed is NEVER widened to workspace-wide", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    const deletedDocId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    mockedConversationFindById.mockResolvedValue({
      _id: new Types.ObjectId(DEFAULT_CONVERSATION_ID),
      workspaceId: new Types.ObjectId(workspaceId),
      ragSessionId: "session-1",
      sourceScopeDocumentIds: [deletedDocId],
    } as never);
    // Re-validation finds NOTHING -- the document is gone/not ready.
    mockedFileFind.mockReturnValue(fileFindResult([]) as never);
    const queryMock = vi.fn().mockResolvedValue({ answer: "answer", session_id: "s", source_attributions: [], retrieval_metadata: {} });
    mockedGetTeamBService.mockReturnValue({ query: queryMock });

    await POST(chatRequest({ messages: [userMessage("hi")], workspaceId, videoTimestamp: null }));

    // MUST be an empty list (zero eligible sources), never null (workspace-wide).
    expect(queryMock.mock.calls[0][0].retrieval_config).toEqual({ document_ids: [] });
    expect(queryMock.mock.calls[0][0].retrieval_config.document_ids).not.toBeNull();
  });

  it("7/8: a scope containing a document from ANOTHER workspace never reaches Team B", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    const otherWorkspaceDocId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    mockedConversationFindById.mockResolvedValue({
      _id: new Types.ObjectId(DEFAULT_CONVERSATION_ID),
      workspaceId: new Types.ObjectId(workspaceId),
      ragSessionId: "session-1",
      // Simulates a stale/tampered persisted value referencing a
      // document that (per the real Mongo query, scoped to THIS
      // workspace) doesn't actually belong here.
      sourceScopeDocumentIds: [otherWorkspaceDocId],
    } as never);
    mockedFileFind.mockReturnValue(fileFindResult([]) as never); // the real, workspace-scoped query finds nothing
    const queryMock = vi.fn().mockResolvedValue({ answer: "answer", session_id: "s", source_attributions: [], retrieval_metadata: {} });
    mockedGetTeamBService.mockReturnValue({ query: queryMock });

    await POST(chatRequest({ messages: [userMessage("hi")], workspaceId, videoTimestamp: null }));

    const sentDocumentIds = queryMock.mock.calls[0][0].retrieval_config.document_ids;
    expect(sentDocumentIds).not.toContain(otherWorkspaceDocId);
  });
});

describe("POST /api/chat — MVP M6: retry preserves source scope", () => {
  it("21/24: a failed first attempt followed by a successful retry uses the SAME persisted source scope both times", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    const docA = new Types.ObjectId();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    mockedConversationFindById.mockResolvedValue({
      _id: new Types.ObjectId(DEFAULT_CONVERSATION_ID),
      workspaceId: new Types.ObjectId(workspaceId),
      ragSessionId: "stable-session",
      sourceScopeDocumentIds: [docA.toString()],
    } as never);
    mockedFileFind.mockImplementation((query: unknown) => {
      const q = query as { _id?: { $in: string[] } };
      return fileFindResult(q._id ? [{ _id: docA }] : []) as never;
    });
    const queryMock = vi
      .fn()
      .mockRejectedValueOnce(new TeamBQueryError(503))
      .mockResolvedValueOnce({ answer: "answer", session_id: "s", source_attributions: [], retrieval_metadata: {} });
    mockedGetTeamBService.mockReturnValue({ query: queryMock });

    const first = await POST(chatRequest({ messages: [userMessage("hi")], workspaceId, videoTimestamp: null }));
    expect(first.status).toBe(502);
    const second = await POST(chatRequest({ messages: [userMessage("hi")], workspaceId, videoTimestamp: null }));
    expect(second.status).toBe(200);

    expect(queryMock.mock.calls[0][0].retrieval_config).toEqual({ document_ids: [docA.toString()] });
    expect(queryMock.mock.calls[1][0].retrieval_config).toEqual({ document_ids: [docA.toString()] });
    expect(queryMock.mock.calls[0][0].session_id).toBe("stable-session");
    expect(queryMock.mock.calls[1][0].session_id).toBe("stable-session");
  });
});

// ---------------------------------------------------------------------------
// Step 7 — session restoration wiring (lib/restoreSession.ts's own
// correctness is covered in isolation by tests/unit/restoreSession.test.ts;
// these tests prove /api/chat actually calls it, in the right order,
// without breaking any existing behavior).
// ---------------------------------------------------------------------------

describe("POST /api/chat — Step 7: Team B session restoration", () => {
  it("does nothing extra when the active TeamBService has no restoration support (e.g. the mock) — pre-existing behavior unchanged", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    authorizeDefaultConversation(workspaceId);
    const queryMock = vi.fn().mockResolvedValue({ answer: "answer", session_id: "s", source_attributions: [], retrieval_metadata: {} });
    mockedGetTeamBService.mockReturnValue({ query: queryMock }); // no hasSession/seedSession, like the real mock

    const response = await POST(chatRequest({ messages: [userMessage("hi")], workspaceId, videoTimestamp: null }));

    expect(response.status).toBe(200);
    expect(mockedMessageFind).not.toHaveBeenCalled();
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("checks hasSession before querying, and skips restoration when the session is still alive", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    authorizeDefaultConversation(workspaceId, "live-session");
    mockedMessageFind.mockReturnValue(messageFindResult([{ role: "user", content: "earlier", createdAt: new Date() }]) as never);
    const hasSessionMock = vi.fn().mockResolvedValue(true);
    const seedSessionMock = vi.fn();
    const queryMock = vi.fn().mockResolvedValue({ answer: "answer", session_id: "s", source_attributions: [], retrieval_metadata: {} });
    mockedGetTeamBService.mockReturnValue({ query: queryMock, hasSession: hasSessionMock, seedSession: seedSessionMock });

    await POST(chatRequest({ messages: [userMessage("hi")], workspaceId, videoTimestamp: null }));

    expect(hasSessionMock).toHaveBeenCalledWith("live-session", { sub: userId, workspace_id: workspaceId });
    expect(seedSessionMock).not.toHaveBeenCalled();
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("STEP 8: a Team B hiccup never blocks a brand-new conversation with nothing to restore — hasSession is never even called", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    authorizeDefaultConversation(workspaceId);
    mockedMessageFind.mockReturnValue(messageFindResult([]) as never); // no history at all
    const hasSessionMock = vi.fn().mockRejectedValue(new Error("would fail if called"));
    const queryMock = vi.fn().mockResolvedValue({ answer: "answer", session_id: "s", source_attributions: [], retrieval_metadata: {} });
    mockedGetTeamBService.mockReturnValue({ query: queryMock, hasSession: hasSessionMock, seedSession: vi.fn() });

    const response = await POST(chatRequest({ messages: [userMessage("hi")], workspaceId, videoTimestamp: null }));

    expect(response.status).toBe(200);
    expect(hasSessionMock).not.toHaveBeenCalled();
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("restores from Mongo history and seeds Team B BEFORE calling query() when the session is missing", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    authorizeDefaultConversation(workspaceId, "expired-session");
    mockedMessageFind.mockReturnValue(
      messageFindResult([{ role: "user", content: "earlier question", createdAt: new Date("2026-01-01T00:00:00.000Z") }]) as never
    );
    const callOrder: string[] = [];
    const hasSessionMock = vi.fn().mockImplementation(async () => {
      callOrder.push("hasSession");
      return false;
    });
    const seedSessionMock = vi.fn().mockImplementation(async () => {
      callOrder.push("seedSession");
      return { session_id: "expired-session", seeded: true, turn_count: 1 };
    });
    const queryMock = vi.fn().mockImplementation(async () => {
      callOrder.push("query");
      return { answer: "answer", session_id: "s", source_attributions: [], retrieval_metadata: {} };
    });
    mockedGetTeamBService.mockReturnValue({ query: queryMock, hasSession: hasSessionMock, seedSession: seedSessionMock });

    const response = await POST(chatRequest({ messages: [userMessage("new question")], workspaceId, videoTimestamp: null }));

    expect(response.status).toBe(200);
    expect(callOrder).toEqual(["hasSession", "seedSession", "query"]);
    expect(seedSessionMock).toHaveBeenCalledWith(
      "expired-session",
      [expect.objectContaining({ role: "user", content: "earlier question" })],
      { sub: userId, workspace_id: workspaceId }
    );
    // The CURRENT in-flight message ("new question") was never persisted
    // yet at restoration time, so it is never part of the restored turns.
    const restoredTurns = seedSessionMock.mock.calls[0][1];
    expect(restoredTurns.map((t: { content: string }) => t.content)).not.toContain("new question");
  });

  it("restoration is scoped to the conversation's OWN ragSessionId — never a different conversation's session", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    const conversationId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    mockedConversationFindById.mockResolvedValue(ownedConversation(conversationId, workspaceId, "this-conversations-session"));
    mockedMessageFind.mockReturnValue(messageFindResult([{ role: "user", content: "earlier", createdAt: new Date() }]) as never);
    const hasSessionMock = vi.fn().mockResolvedValue(false);
    const seedSessionMock = vi.fn().mockResolvedValue({ session_id: "s", seeded: true, turn_count: 1 });
    mockedGetTeamBService.mockReturnValue({
      query: vi.fn().mockResolvedValue({ answer: "answer", session_id: "s", source_attributions: [], retrieval_metadata: {} }),
      hasSession: hasSessionMock,
      seedSession: seedSessionMock,
    });

    await POST(chatRequest({ messages: [userMessage("hi")], workspaceId, conversationId, videoTimestamp: null }));

    expect(hasSessionMock).toHaveBeenCalledWith("this-conversations-session", { sub: userId, workspace_id: workspaceId });
    expect(mockedMessageFind).toHaveBeenCalledWith({ conversationId });
  });
});

// ---------------------------------------------------------------------------
// Step 8 — explicit restoration-failure handling: a follow-up query must
// never silently proceed without context it genuinely needed but
// couldn't get. lib/restoreSession.ts's own outcome logic is covered in
// isolation by tests/unit/restoreSession.test.ts; these prove the ROUTE
// actually branches on the outcome instead of always continuing.
// ---------------------------------------------------------------------------

describe("POST /api/chat — Step 8: explicit restoration-failure handling", () => {
  it("returns 502 and never calls query() when restoration was necessary but Team B is unreachable", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    authorizeDefaultConversation(workspaceId, "expired-session");
    mockedMessageFind.mockReturnValue(
      messageFindResult([{ role: "user", content: "earlier question", createdAt: new Date() }]) as never
    );
    const queryMock = vi.fn().mockResolvedValue({ answer: "answer", session_id: "s", source_attributions: [], retrieval_metadata: {} });
    mockedGetTeamBService.mockReturnValue({
      query: queryMock,
      hasSession: vi.fn().mockRejectedValue(new Error("Team B unreachable")),
      seedSession: vi.fn(),
    });

    const response = await POST(chatRequest({ messages: [userMessage("hi")], workspaceId, videoTimestamp: null }));
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body.error).toBe("The query service is temporarily unavailable.");
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("returns 502 when hasSession succeeds but seedSession itself fails", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    authorizeDefaultConversation(workspaceId, "expired-session");
    mockedMessageFind.mockReturnValue(
      messageFindResult([{ role: "user", content: "earlier question", createdAt: new Date() }]) as never
    );
    const queryMock = vi.fn();
    mockedGetTeamBService.mockReturnValue({
      query: queryMock,
      hasSession: vi.fn().mockResolvedValue(false),
      seedSession: vi.fn().mockRejectedValue(new Error("seed failed")),
    });

    const response = await POST(chatRequest({ messages: [userMessage("hi")], workspaceId, videoTimestamp: null }));

    expect(response.status).toBe(502);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("returns 500 (distinct from Team B's 502) when this app's OWN Mongo history read fails", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    authorizeDefaultConversation(workspaceId, "expired-session");
    mockedMessageFind.mockImplementation(() => {
      throw new Error("Mongo unavailable");
    });
    const queryMock = vi.fn();
    mockedGetTeamBService.mockReturnValue({
      query: queryMock,
      hasSession: vi.fn(),
      seedSession: vi.fn(),
    });

    const response = await POST(chatRequest({ messages: [userMessage("hi")], workspaceId, videoTimestamp: null }));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe("An unexpected error occurred.");
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("a restoration failure persists ZERO messages — no duplicate/stray user or assistant message", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    authorizeDefaultConversation(workspaceId, "expired-session");
    mockedMessageFind.mockReturnValue(
      messageFindResult([{ role: "user", content: "earlier question", createdAt: new Date() }]) as never
    );
    mockedGetTeamBService.mockReturnValue({
      query: vi.fn(),
      hasSession: vi.fn().mockRejectedValue(new Error("Team B unreachable")),
      seedSession: vi.fn(),
    });

    await POST(chatRequest({ messages: [userMessage("hi")], workspaceId, videoTimestamp: null }));

    expect(mockedMessageCreate).not.toHaveBeenCalled();
  });

  it("a subsequent retry after Team B recovers succeeds normally (the same reliability guarantee as an ordinary query failure)", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    authorizeDefaultConversation(workspaceId, "expired-session");
    mockedMessageFind.mockReturnValue(
      messageFindResult([{ role: "user", content: "earlier question", createdAt: new Date() }]) as never
    );
    const hasSessionMock = vi.fn().mockRejectedValueOnce(new Error("transient")).mockResolvedValueOnce(false);
    const seedSessionMock = vi.fn().mockResolvedValue({ session_id: "s", seeded: true, turn_count: 1 });
    const queryMock = vi.fn().mockResolvedValue({ answer: "The real answer.", session_id: "s", source_attributions: [], retrieval_metadata: {} });
    mockedGetTeamBService.mockReturnValue({ query: queryMock, hasSession: hasSessionMock, seedSession: seedSessionMock });

    const first = await POST(chatRequest({ messages: [userMessage("hi")], workspaceId, videoTimestamp: null }));
    expect(first.status).toBe(502);

    const second = await POST(chatRequest({ messages: [userMessage("hi")], workspaceId, videoTimestamp: null }));
    expect(second.status).toBe(200);

    expect(queryMock).toHaveBeenCalledTimes(1); // only the successful retry ever reached query()
    expect(mockedMessageCreate).toHaveBeenCalledTimes(2); // exactly one user + one assistant, from the retry only
  });
});

// ---------------------------------------------------------------------------
// Stage 6 — conversation title auto-generation + sidebar invalidation.
// The sidebar-refresh half (hooks/useChatStream.ts's onFinish invalidating
// ["conversations", workspaceId]) is covered separately in
// tests/unit/useChatStream-*.test.tsx; these tests cover only this route's
// own title-write behavior.
// ---------------------------------------------------------------------------

describe("POST /api/chat — Stage 6: conversation title auto-generation", () => {
  function conversationWithTitle(id: string, workspaceId: string, title: string, ragSessionId = "session-1") {
    return {
      _id: new Types.ObjectId(id),
      workspaceId: new Types.ObjectId(workspaceId),
      ragSessionId,
      title,
    } as never;
  }

  function titleUpdateCalls() {
    return mockedConversationFindOneAndUpdate.mock.calls.filter((call) => "title" in (call[0] as object));
  }

  it("generates a title from the first user message when the conversation still has the default title", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    mockedConversationFindById.mockResolvedValue(
      conversationWithTitle(DEFAULT_CONVERSATION_ID, workspaceId, "New conversation")
    );
    mockedGetTeamBService.mockReturnValue({
      query: vi.fn().mockResolvedValue({ answer: "answer", session_id: "s", source_attributions: [], retrieval_metadata: {} }),
    });

    await POST(chatRequest({ messages: [userMessage("What is normalization?")], workspaceId, videoTimestamp: null }));

    const calls = titleUpdateCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toEqual({ _id: DEFAULT_CONVERSATION_ID, title: "New conversation" });
    expect(calls[0][1]).toEqual({ $set: { title: "What is normalization?" } });
  });

  it("truncates a first message longer than 60 characters, appending an ellipsis", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    const longMessage = "Could you explain, in as much detail as possible, how database normalization actually works?";
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    mockedConversationFindById.mockResolvedValue(
      conversationWithTitle(DEFAULT_CONVERSATION_ID, workspaceId, "New conversation")
    );
    mockedGetTeamBService.mockReturnValue({
      query: vi.fn().mockResolvedValue({ answer: "answer", session_id: "s", source_attributions: [], retrieval_metadata: {} }),
    });

    await POST(chatRequest({ messages: [userMessage(longMessage)], workspaceId, videoTimestamp: null }));

    const generatedTitle = (titleUpdateCalls()[0][1] as { $set: { title: string } }).$set.title;
    expect(generatedTitle.endsWith("…")).toBe(true);
    expect(generatedTitle).toBe(`${longMessage.slice(0, 60)}…`);
    expect(generatedTitle.length).toBe(61);
  });

  it("does NOT truncate a first message exactly 60 characters long", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    const exactlySixty = "A".repeat(60);
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    mockedConversationFindById.mockResolvedValue(
      conversationWithTitle(DEFAULT_CONVERSATION_ID, workspaceId, "New conversation")
    );
    mockedGetTeamBService.mockReturnValue({
      query: vi.fn().mockResolvedValue({ answer: "answer", session_id: "s", source_attributions: [], retrieval_metadata: {} }),
    });

    await POST(chatRequest({ messages: [userMessage(exactlySixty)], workspaceId, videoTimestamp: null }));

    const generatedTitle = (titleUpdateCalls()[0][1] as { $set: { title: string } }).$set.title;
    expect(generatedTitle).toBe(exactlySixty);
  });

  it("never overwrites a title the user (or a prior message) has already customized", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    mockedConversationFindById.mockResolvedValue(
      conversationWithTitle(DEFAULT_CONVERSATION_ID, workspaceId, "My Custom Title")
    );
    mockedGetTeamBService.mockReturnValue({
      query: vi.fn().mockResolvedValue({ answer: "answer", session_id: "s", source_attributions: [], retrieval_metadata: {} }),
    });

    await POST(chatRequest({ messages: [userMessage("Some new question")], workspaceId, videoTimestamp: null }));

    expect(titleUpdateCalls()).toHaveLength(0);
  });

  it("does not generate a title from an empty/whitespace-only message", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    mockedConversationFindById.mockResolvedValue(
      conversationWithTitle(DEFAULT_CONVERSATION_ID, workspaceId, "New conversation")
    );
    mockedGetTeamBService.mockReturnValue({
      query: vi.fn().mockResolvedValue({ answer: "answer", session_id: "s", source_attributions: [], retrieval_metadata: {} }),
    });

    await POST(chatRequest({ messages: [userMessage("   ")], workspaceId, videoTimestamp: null }));

    expect(titleUpdateCalls()).toHaveLength(0);
  });

  it("does not re-title on a second message once the first message already produced a real title", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    // Two findById calls happen per POST (the ownership check, then the
    // ragSessionId re-read fallback) -- both return the SAME title within
    // one request, and the second POST's pair reflects the title the
    // first POST would actually have persisted, simulating the real
    // Mongo state across two separate requests.
    mockedConversationFindById
      .mockResolvedValueOnce(conversationWithTitle(DEFAULT_CONVERSATION_ID, workspaceId, "New conversation"))
      .mockResolvedValueOnce(conversationWithTitle(DEFAULT_CONVERSATION_ID, workspaceId, "New conversation"))
      .mockResolvedValueOnce(conversationWithTitle(DEFAULT_CONVERSATION_ID, workspaceId, "What is normalization?"))
      .mockResolvedValueOnce(conversationWithTitle(DEFAULT_CONVERSATION_ID, workspaceId, "What is normalization?"));
    mockedGetTeamBService.mockReturnValue({
      query: vi.fn().mockResolvedValue({ answer: "answer", session_id: "s", source_attributions: [], retrieval_metadata: {} }),
    });

    await POST(chatRequest({ messages: [userMessage("What is normalization?")], workspaceId, videoTimestamp: null }));
    await POST(chatRequest({ messages: [userMessage("Follow-up question.")], workspaceId, videoTimestamp: null }));

    const calls = titleUpdateCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toEqual({ $set: { title: "What is normalization?" } });
  });

  it("a title-write failure is best-effort: swallowed, logged, and never blocks message persistence or the response", async () => {
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    mockedConversationFindById.mockResolvedValue(
      conversationWithTitle(DEFAULT_CONVERSATION_ID, workspaceId, "New conversation")
    );
    // The ragSessionId backfill's own findOneAndUpdate call must keep
    // behaving exactly as before (resolves null -> falls back to the
    // plain re-read); only the TITLE write is made to fail here.
    mockedConversationFindOneAndUpdate.mockImplementation((async (filter: unknown) => {
      if (filter && typeof filter === "object" && "title" in filter) {
        throw new Error("Mongo write failed");
      }
      return null;
    }) as never);
    mockedGetTeamBService.mockReturnValue({
      query: vi.fn().mockResolvedValue({ answer: "The real answer.", session_id: "s", source_attributions: [], retrieval_metadata: {} }),
    });

    const response = await POST(
      chatRequest({ messages: [userMessage("What is normalization?")], workspaceId, videoTimestamp: null })
    );

    expect(response.status).toBe(200);
    expect(mockedMessageCreate).toHaveBeenCalledTimes(2);
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to auto-generate title"),
      expect.anything()
    );

    consoleWarnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Stage 7 — readable citation filenames + zero-retrieval citation
// suppression.
// ---------------------------------------------------------------------------

function extractCitations(raw: string): Array<Record<string, unknown>> {
  const dataMatch = raw.match(/"type":"data-citations","data":(\[.*?\])\}/);
  return JSON.parse(dataMatch?.[1] ?? "[]");
}

describe("POST /api/chat — Stage 7: readable citation filenames", () => {
  it("resolves the citation's display name from the workspace's own File.originalName, never Team B's raw document_title", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    const realFileId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    authorizeDefaultConversation(workspaceId);
    mockedFileFind.mockResolvedValue([
      {
        _id: new Types.ObjectId(realFileId),
        storageUrl: "https://example.test/839acd8ee30b41ed8d92293da7bda1d0.pdf",
        originalName: "Operating Systems Notes.pdf",
      },
    ] as never);
    mockedGetTeamBService.mockReturnValue({
      query: vi.fn().mockResolvedValue({
        answer: "See the notes.",
        session_id: "sess-1",
        source_attributions: [
          {
            // Team B's real, ingestion-pipeline-assigned value -- a
            // hash-like storage identifier, confirmed by live
            // verification, never the name the user actually uploaded.
            document_id: realFileId,
            document_title: "839acd8ee30b41ed8d92293da7bda1d0.pdf",
            chunk_id: "c1",
            relevance_score: 0.9,
            page_number: 15,
          },
        ],
        retrieval_metadata: { chunks_retrieved: 1 },
      }),
    });

    const response = await POST(chatRequest({ messages: [userMessage("hi")], workspaceId, videoTimestamp: null }));
    const raw = await response.text();
    const citations = extractCitations(raw);

    expect(citations[0].sourceFile).toBe("Operating Systems Notes.pdf");
    expect(citations[0].label).toBe("Operating Systems Notes.pdf, page 15");
    expect(citations[0].sourceFile).not.toBe("839acd8ee30b41ed8d92293da7bda1d0.pdf");
    // The actual citation LINK/identity is completely unchanged.
    expect(citations[0].fileId).toBe(realFileId);
    expect(citations[0].fileUrl).toBe("https://example.test/839acd8ee30b41ed8d92293da7bda1d0.pdf");
    expect(citations[0].chunkId).toBe("c1");
  });

  it("falls back to Team B's document_title when no matching File document exists for the citation (missing document metadata)", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    authorizeDefaultConversation(workspaceId);
    // The workspace genuinely has no files matching this citation's
    // document_id (e.g. deleted after ingestion, or a data inconsistency).
    mockedFileFind.mockResolvedValue([]);
    mockedGetTeamBService.mockReturnValue({
      query: vi.fn().mockResolvedValue({
        answer: "See the source.",
        session_id: "sess-1",
        source_attributions: [
          {
            document_id: new Types.ObjectId().toString(),
            document_title: "SomeDocument.pdf",
            chunk_id: "c1",
            relevance_score: 0.6,
            page_number: 1,
          },
        ],
        retrieval_metadata: { chunks_retrieved: 1 },
      }),
    });

    const response = await POST(chatRequest({ messages: [userMessage("hi")], workspaceId, videoTimestamp: null }));
    const raw = await response.text();
    const citations = extractCitations(raw);

    // No matching File -> falls back to Team B's own document_title rather
    // than crashing or showing a blank name -- and per the pre-existing
    // Requirement 3.5 workspace check, still correctly disabled.
    expect(citations[0].sourceFile).toBe("SomeDocument.pdf");
    expect(citations[0].disabled).toBe(true);
  });

  it("workspace isolation: never resolves a citation's filename from a DIFFERENT workspace's File, even if that file genuinely exists there", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceAId = new Types.ObjectId().toString();
    const workspaceBFileId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceAId, userId));
    authorizeDefaultConversation(workspaceAId);
    // Workspace A's own file lookup finds NOTHING -- workspaceBFileId
    // belongs to a different workspace and is never returned here.
    mockedFileFind.mockResolvedValue([]);
    mockedGetTeamBService.mockReturnValue({
      query: vi.fn().mockResolvedValue({
        answer: "See the lecture.",
        session_id: "sess-1",
        source_attributions: [
          {
            document_id: workspaceBFileId,
            document_title: "OtherWorkspaceLecture.mp4",
            chunk_id: "c1",
            relevance_score: 0.9,
            start_timestamp: 10,
          },
        ],
        retrieval_metadata: { chunks_retrieved: 1 },
      }),
    });

    const response = await POST(
      chatRequest({ messages: [userMessage("hi")], workspaceId: workspaceAId, videoTimestamp: null })
    );

    // FileModel.find was scoped to workspace A only -- workspace B's own
    // File.originalName (whatever it may be) was never fetched or
    // consulted at all.
    expect(mockedFileFind).toHaveBeenCalledWith({ workspaceId: workspaceAId });
    const raw = await response.text();
    const citations = extractCitations(raw);
    expect(citations[0].sourceFile).toBe("OtherWorkspaceLecture.mp4"); // the fallback, not a cross-workspace lookup
    expect(citations[0].disabled).toBe(true);
  });
});

describe("POST /api/chat — Stage 7: zero-retrieval citation suppression", () => {
  it("shows no citations when Team B returns zero source_attributions and chunks_retrieved: 0 (the ordinary zero-retrieval case)", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    authorizeDefaultConversation(workspaceId);
    mockedGetTeamBService.mockReturnValue({
      query: vi.fn().mockResolvedValue({
        answer: "I don't have enough indexed content to answer that.",
        session_id: "sess-1",
        source_attributions: [],
        retrieval_metadata: { chunks_retrieved: 0, search_mode: "hybrid" },
      }),
    });

    const response = await POST(chatRequest({ messages: [userMessage("something unrelated")], workspaceId, videoTimestamp: null }));
    const raw = await response.text();

    expect(raw).not.toContain("data-citations");
  });

  it("suppresses citations when chunks_retrieved: 0 even though Team B returned a non-empty source_attributions array (anomaly defense, backend-signal-driven)", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    const realFileId = new Types.ObjectId().toString();
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    authorizeDefaultConversation(workspaceId);
    mockedFileFind.mockResolvedValue([
      { _id: new Types.ObjectId(realFileId), storageUrl: "https://example.test/f.pdf", originalName: "F.pdf" },
    ] as never);
    mockedGetTeamBService.mockReturnValue({
      query: vi.fn().mockResolvedValue({
        answer: "A general answer, not actually grounded in retrieval.",
        session_id: "sess-1",
        // Anomalous/inconsistent backend response: a real, otherwise-valid
        // citation despite the metadata explicitly reporting zero
        // retrieved chunks -- must never be displayed as if it were a
        // genuine, grounded source.
        source_attributions: [
          { document_id: realFileId, document_title: "F.pdf", chunk_id: "c1", relevance_score: 0.9, page_number: 1 },
        ],
        retrieval_metadata: { chunks_retrieved: 0 },
      }),
    });

    const response = await POST(chatRequest({ messages: [userMessage("hi")], workspaceId, videoTimestamp: null }));
    const raw = await response.text();

    expect(raw).not.toContain("data-citations");
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining("chunks_retrieved: 0 but returned 1 source_attribution")
    );
    consoleWarnSpy.mockRestore();
  });

  it("does NOT suppress citations when chunks_retrieved is a positive number and attributions exist (regression: grounded answers keep their citations)", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    const realFileId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    authorizeDefaultConversation(workspaceId);
    mockedFileFind.mockResolvedValue([
      { _id: new Types.ObjectId(realFileId), storageUrl: "https://example.test/f.pdf", originalName: "F.pdf" },
    ] as never);
    mockedGetTeamBService.mockReturnValue({
      query: vi.fn().mockResolvedValue({
        answer: "A grounded answer.",
        session_id: "sess-1",
        source_attributions: [
          { document_id: realFileId, document_title: "F.pdf", chunk_id: "c1", relevance_score: 0.9, page_number: 1 },
        ],
        retrieval_metadata: { chunks_retrieved: 3, search_mode: "hybrid" },
      }),
    });

    const response = await POST(chatRequest({ messages: [userMessage("hi")], workspaceId, videoTimestamp: null }));
    const raw = await response.text();
    const citations = extractCitations(raw);

    expect(citations).toHaveLength(1);
    expect(citations[0].disabled).toBeFalsy();
  });

  it("treats a missing chunks_retrieved field as no signal, falling back to the existing array-based suppression (backend not sending the field is not a bug)", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    const realFileId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    authorizeDefaultConversation(workspaceId);
    mockedFileFind.mockResolvedValue([
      { _id: new Types.ObjectId(realFileId), storageUrl: "https://example.test/f.pdf", originalName: "F.pdf" },
    ] as never);
    mockedGetTeamBService.mockReturnValue({
      query: vi.fn().mockResolvedValue({
        answer: "A grounded answer.",
        session_id: "sess-1",
        source_attributions: [
          { document_id: realFileId, document_title: "F.pdf", chunk_id: "c1", relevance_score: 0.9, page_number: 1 },
        ],
        retrieval_metadata: {}, // no chunks_retrieved key at all
      }),
    });

    const response = await POST(chatRequest({ messages: [userMessage("hi")], workspaceId, videoTimestamp: null }));
    const raw = await response.text();
    const citations = extractCitations(raw);

    expect(citations).toHaveLength(1);
  });

  it("treats a non-numeric chunks_retrieved (malformed backend data) as no signal, never as a false zero", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    const realFileId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    authorizeDefaultConversation(workspaceId);
    mockedFileFind.mockResolvedValue([
      { _id: new Types.ObjectId(realFileId), storageUrl: "https://example.test/f.pdf", originalName: "F.pdf" },
    ] as never);
    mockedGetTeamBService.mockReturnValue({
      query: vi.fn().mockResolvedValue({
        answer: "A grounded answer.",
        session_id: "sess-1",
        source_attributions: [
          { document_id: realFileId, document_title: "F.pdf", chunk_id: "c1", relevance_score: 0.9, page_number: 1 },
        ],
        retrieval_metadata: { chunks_retrieved: "0" }, // malformed: a string, not a number
      }),
    });

    const response = await POST(chatRequest({ messages: [userMessage("hi")], workspaceId, videoTimestamp: null }));
    const raw = await response.text();
    const citations = extractCitations(raw);

    expect(citations).toHaveLength(1);
  });

  it("error handling: a response missing retrieval_metadata entirely never crashes the route", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    authorizeDefaultConversation(workspaceId);
    mockedGetTeamBService.mockReturnValue({
      query: vi.fn().mockResolvedValue({
        answer: "An answer with no retrieval_metadata field at all.",
        session_id: "sess-1",
        source_attributions: [],
      }),
    });

    const response = await POST(chatRequest({ messages: [userMessage("hi")], workspaceId, videoTimestamp: null }));

    expect(response.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Stage 8 — retrieved-but-refused grounding signal + citation suppression.
// `retrieval_metadata.grounded` (team4b's explicit, backend-computed
// signal -- see app/services/llm_generator.py's GenerationResult) is read
// the SAME defensive way Stage 7's chunks_retrieved already is: an
// explicit `false` narrows (suppresses); anything else (true, missing,
// non-boolean) never suppresses citations that would otherwise render.
// ---------------------------------------------------------------------------

describe("POST /api/chat — Stage 8: retrieved-but-refused grounding signal", () => {
  it("preserves citations for a genuinely grounded answer (grounded: true)", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    const realFileId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    authorizeDefaultConversation(workspaceId);
    mockedFileFind.mockResolvedValue([
      { _id: new Types.ObjectId(realFileId), storageUrl: "https://example.test/os.pdf", originalName: "OS Notes.pdf" },
    ] as never);
    mockedGetTeamBService.mockReturnValue({
      query: vi.fn().mockResolvedValue({
        answer: "A deadlock occurs when processes wait on each other indefinitely.",
        session_id: "sess-1",
        source_attributions: [
          { document_id: realFileId, document_title: "OS Notes.pdf", chunk_id: "c1", relevance_score: 0.9, page_number: 12 },
        ],
        retrieval_metadata: { chunks_retrieved: 1, search_mode: "hybrid", grounded: true },
      }),
    });

    const response = await POST(chatRequest({ messages: [userMessage("What is a deadlock?")], workspaceId, videoTimestamp: null }));
    const raw = await response.text();
    const citations = extractCitations(raw);

    expect(citations).toHaveLength(1);
    expect(citations[0].disabled).toBeFalsy();
  });

  it("suppresses citations for a retrieved-but-refused answer (chunks retrieved, grounded: false)", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    const realFileId = new Types.ObjectId().toString();
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    authorizeDefaultConversation(workspaceId);
    mockedFileFind.mockResolvedValue([
      { _id: new Types.ObjectId(realFileId), storageUrl: "https://example.test/os.pdf", originalName: "OS Notes.pdf" },
    ] as never);
    mockedGetTeamBService.mockReturnValue({
      query: vi.fn().mockResolvedValue({
        // Exactly the Stage 7 live-verification scenario: chunks WERE
        // retrieved (real, otherwise-valid citations) but the model
        // explicitly reported it could not answer the off-topic
        // question from them.
        answer: "The context does not contain information about the capital of France.",
        session_id: "sess-1",
        source_attributions: [
          { document_id: realFileId, document_title: "OS Notes.pdf", chunk_id: "c1", relevance_score: 0.4, page_number: 3 },
        ],
        retrieval_metadata: { chunks_retrieved: 1, search_mode: "hybrid", grounded: false },
      }),
    });

    const response = await POST(
      chatRequest({ messages: [userMessage("What is the capital of France?")], workspaceId, videoTimestamp: null })
    );
    const raw = await response.text();

    expect(raw).not.toContain("data-citations");
    expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining("retrieved-but-refused"));
    consoleWarnSpy.mockRestore();
  });

  it("zero-retrieval answers remain suppressed exactly as Stage 7 established (grounded key absent entirely)", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    authorizeDefaultConversation(workspaceId);
    mockedGetTeamBService.mockReturnValue({
      query: vi.fn().mockResolvedValue({
        answer: "Hi! How can I help with your course material today?",
        session_id: "sess-1",
        source_attributions: [],
        // Matches the real casual-message path (RAGService's
        // is_casual_message gate) -- no "grounded" key at all, since no
        // generation call with a grounding schema ever happened.
        retrieval_metadata: { chunks_retrieved: 0, casual_intent: true },
      }),
    });

    const response = await POST(chatRequest({ messages: [userMessage("hi")], workspaceId, videoTimestamp: null }));
    const raw = await response.text();

    expect(raw).not.toContain("data-citations");
  });

  it("missing grounding metadata (older/non-conforming backend) never suppresses citations that chunks_retrieved alone would show", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    const realFileId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    authorizeDefaultConversation(workspaceId);
    mockedFileFind.mockResolvedValue([
      { _id: new Types.ObjectId(realFileId), storageUrl: "https://example.test/f.pdf", originalName: "F.pdf" },
    ] as never);
    mockedGetTeamBService.mockReturnValue({
      query: vi.fn().mockResolvedValue({
        answer: "A grounded-looking answer from a backend that doesn't send Stage 8's signal yet.",
        session_id: "sess-1",
        source_attributions: [
          { document_id: realFileId, document_title: "F.pdf", chunk_id: "c1", relevance_score: 0.9, page_number: 1 },
        ],
        // No "grounded" key at all -- exactly Stage 7's own contract,
        // predating Stage 8.
        retrieval_metadata: { chunks_retrieved: 1, search_mode: "hybrid" },
      }),
    });

    const response = await POST(chatRequest({ messages: [userMessage("hi")], workspaceId, videoTimestamp: null }));
    const raw = await response.text();
    const citations = extractCitations(raw);

    expect(citations).toHaveLength(1);
  });

  it("a malformed grounded value (e.g. a string, not a boolean) is treated as no signal, never as a false", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    const realFileId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    authorizeDefaultConversation(workspaceId);
    mockedFileFind.mockResolvedValue([
      { _id: new Types.ObjectId(realFileId), storageUrl: "https://example.test/f.pdf", originalName: "F.pdf" },
    ] as never);
    mockedGetTeamBService.mockReturnValue({
      query: vi.fn().mockResolvedValue({
        answer: "An answer.",
        session_id: "sess-1",
        source_attributions: [
          { document_id: realFileId, document_title: "F.pdf", chunk_id: "c1", relevance_score: 0.9, page_number: 1 },
        ],
        retrieval_metadata: { chunks_retrieved: 1, grounded: "false" }, // malformed: a string, not a boolean
      }),
    });

    const response = await POST(chatRequest({ messages: [userMessage("hi")], workspaceId, videoTimestamp: null }));
    const raw = await response.text();
    const citations = extractCitations(raw);

    expect(citations).toHaveLength(1);
  });

  it("a model output that violates the expected grounding format degrades gracefully (Team 4B's own fallback) without breaking Team 4C's route", async () => {
    // Represents team4b/app/services/llm_generator.py's own documented
    // fallback for a real format violation: `grounded` is simply absent
    // (never fabricated) once Team B's own parsing degrades. Team 4C's
    // route must not crash or misbehave when that happens -- it already
    // doesn't, by construction (same "missing key" handling as any other
    // backend that predates Stage 8), but this is an explicit regression
    // test for that exact wire shape.
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    authorizeDefaultConversation(workspaceId);
    mockedFileFind.mockResolvedValue([]);
    mockedGetTeamBService.mockReturnValue({
      query: vi.fn().mockResolvedValue({
        // The model's raw, non-JSON-conforming text, passed through
        // verbatim by Team B's own degradation path.
        answer: "this is not the JSON format that was requested",
        session_id: "sess-1",
        source_attributions: [],
        retrieval_metadata: { chunks_retrieved: 1 },
      }),
    });

    const response = await POST(chatRequest({ messages: [userMessage("hi")], workspaceId, videoTimestamp: null }));

    expect(response.status).toBe(200);
    const text = await readSseText(response);
    expect(text).toContain("this is not the JSON format that was requested");
  });

  it("regression: existing citation rendering, disabling, and workspace filtering are unaffected when grounded is absent", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    authorizeDefaultConversation(workspaceId);
    mockedFileFind.mockResolvedValue([]); // no files in this workspace
    mockedGetTeamBService.mockReturnValue({
      query: vi.fn().mockResolvedValue({
        answer: "See the source.",
        session_id: "sess-1",
        source_attributions: [
          {
            document_id: new Types.ObjectId().toString(),
            document_title: "NotMine.pdf",
            chunk_id: "c1",
            relevance_score: 0.6,
            page_number: 1,
          },
        ],
        retrieval_metadata: { chunks_retrieved: 1 },
      }),
    });

    const response = await POST(chatRequest({ messages: [userMessage("hi")], workspaceId, videoTimestamp: null }));
    const raw = await response.text();
    const citations = extractCitations(raw);

    // Same Requirement 3.5 disabling behavior as before Stage 8 exists.
    expect(citations[0].disabled).toBe(true);
  });
});

/**
 * Stage 9B — real token streaming. `fakeQueryStream()` below builds a
 * `TeamBService.queryStream()` test double as a genuine async generator
 * (not a pre-buffered array wrapped to look like one) so these tests
 * exercise the SAME lazy, one-event-at-a-time consumption pattern
 * app/api/chat/route.ts's own priming logic depends on -- a bug in that
 * logic (e.g. accidentally buffering the whole stream, or losing the
 * primed first event) would surface here exactly as it would against a
 * real backend.
 *
 * `extractDeltaText()` mirrors `readSseText()`'s own delta-extraction
 * regex (this file's top-level helper) but operates on an already-read
 * raw string, so a single response body can be inspected for BOTH its
 * streamed text AND its citations/other SSE parts -- `readSseText()`
 * itself consumes the response's `ReadableStream` reader, so it can only
 * be called once per response.
 */
type FakeStreamEvent =
  | { type: "delta"; text: string }
  | ({ type: "done" } & Record<string, unknown>)
  | { type: "error"; detail: string };

function fakeQueryStream(events: FakeStreamEvent[]) {
  return vi.fn().mockImplementation(async function* () {
    for (const event of events) {
      yield event;
    }
  });
}

function fakeQueryStreamThrowing(error: unknown) {
  return vi.fn().mockImplementation(async function* () {
    throw error;
  });
}

function extractDeltaText(raw: string): string {
  return [...raw.matchAll(/"type":"text-delta"[^}]*"delta":"([^"]*)"/g)].map((m) => m[1]).join("");
}

describe("POST /api/chat — Stage 9B: real token streaming", () => {
  it("forwards genuine deltas from queryStream() and delivers citations from the done event, never calling query()", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    const realFileId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    authorizeDefaultConversation(workspaceId);
    mockedFileFind.mockResolvedValue([
      { _id: new Types.ObjectId(realFileId), storageUrl: "https://example.test/f.pdf", originalName: "F.pdf" },
    ] as never);
    const queryMock = vi.fn();
    const queryStreamMock = fakeQueryStream([
      { type: "delta", text: "Hello " },
      { type: "delta", text: "world." },
      {
        type: "done",
        answer: "Hello world.",
        session_id: "sess-1",
        source_attributions: [
          { document_id: realFileId, document_title: "F.pdf", chunk_id: "c1", relevance_score: 0.9, page_number: 1 },
        ],
        retrieval_metadata: { chunks_retrieved: 1, grounded: true },
      },
    ]);
    mockedGetTeamBService.mockReturnValue({ query: queryMock, queryStream: queryStreamMock });

    const response = await POST(chatRequest({ messages: [userMessage("hi")], workspaceId, videoTimestamp: null }));

    expect(response.status).toBe(200);
    const raw = await response.text();
    expect(extractDeltaText(raw)).toBe("Hello world.");
    const citations = extractCitations(raw);
    expect(citations).toHaveLength(1);
    expect(citations[0].disabled).toBeFalsy();
    expect(queryMock).not.toHaveBeenCalled();
    expect(queryStreamMock).toHaveBeenCalledWith(
      expect.objectContaining({ query: "hi", sub: userId, workspace_id: workspaceId })
    );
  });

  it("persists both the user and assistant messages once, only after the done event completes", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    authorizeDefaultConversation(workspaceId);
    mockedFileFind.mockResolvedValue([]);
    mockedGetTeamBService.mockReturnValue({
      query: vi.fn(),
      queryStream: fakeQueryStream([
        { type: "delta", text: "An " },
        { type: "delta", text: "answer." },
        { type: "done", answer: "An answer.", session_id: "sess-1", source_attributions: [], retrieval_metadata: {} },
      ]),
    });

    const response = await POST(
      chatRequest({ messages: [userMessage("what is normalization?")], workspaceId, videoTimestamp: null })
    );
    await response.text();

    expect(mockedMessageCreate).toHaveBeenCalledTimes(2);
    expect(mockedMessageCreate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ role: "user", content: "what is normalization?" })
    );
    expect(mockedMessageCreate).toHaveBeenNthCalledWith(2, expect.objectContaining({ role: "assistant", content: "An answer." }));
  });

  it("Stage 7 zero-retrieval citation suppression still applies over the streaming path", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    authorizeDefaultConversation(workspaceId);
    mockedGetTeamBService.mockReturnValue({
      query: vi.fn(),
      queryStream: fakeQueryStream([
        { type: "delta", text: "Hi there." },
        { type: "done", answer: "Hi there.", session_id: "sess-1", source_attributions: [], retrieval_metadata: { chunks_retrieved: 0 } },
      ]),
    });

    const response = await POST(chatRequest({ messages: [userMessage("hi")], workspaceId, videoTimestamp: null }));
    const raw = await response.text();

    expect(raw).not.toContain("data-citations");
  });

  it("Stage 8 retrieved-but-refused grounding suppression still applies over the streaming path", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    const realFileId = new Types.ObjectId().toString();
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    authorizeDefaultConversation(workspaceId);
    mockedFileFind.mockResolvedValue([
      { _id: new Types.ObjectId(realFileId), storageUrl: "https://example.test/os.pdf", originalName: "OS Notes.pdf" },
    ] as never);
    mockedGetTeamBService.mockReturnValue({
      query: vi.fn(),
      queryStream: fakeQueryStream([
        { type: "delta", text: "The context does not cover that." },
        {
          type: "done",
          answer: "The context does not cover that.",
          session_id: "sess-1",
          source_attributions: [
            { document_id: realFileId, document_title: "OS Notes.pdf", chunk_id: "c1", relevance_score: 0.4, page_number: 3 },
          ],
          retrieval_metadata: { chunks_retrieved: 1, grounded: false },
        },
      ]),
    });

    const response = await POST(
      chatRequest({ messages: [userMessage("What is the capital of France?")], workspaceId, videoTimestamp: null })
    );
    const raw = await response.text();

    expect(raw).not.toContain("data-citations");
    expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining("retrieved-but-refused"));
    consoleWarnSpy.mockRestore();
  });

  it("a pre-generation in-band error (the very first event) returns 502 without ever starting a stream or persisting anything", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    authorizeDefaultConversation(workspaceId);
    mockedGetTeamBService.mockReturnValue({
      query: vi.fn(),
      queryStream: fakeQueryStream([{ type: "error", detail: "retrieval failed" }]),
    });

    const response = await POST(chatRequest({ messages: [userMessage("hi")], workspaceId, videoTimestamp: null }));

    expect(response.status).toBe(502);
    expect(mockedMessageCreate).not.toHaveBeenCalled();
  });

  it("queryStream() throwing a TeamBQueryError before any event maps to the same status handling as the non-streaming path", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    authorizeDefaultConversation(workspaceId);
    mockedGetTeamBService.mockReturnValue({
      query: vi.fn(),
      queryStream: fakeQueryStreamThrowing(new TeamBQueryError(401)),
    });

    const response = await POST(chatRequest({ messages: [userMessage("hi")], workspaceId, videoTimestamp: null }));

    expect(response.status).toBe(401);
    expect(mockedMessageCreate).not.toHaveBeenCalled();
  });

  it("a mid-stream in-band error (after real content already streamed) never persists a message", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    authorizeDefaultConversation(workspaceId);
    mockedGetTeamBService.mockReturnValue({
      query: vi.fn(),
      queryStream: fakeQueryStream([
        { type: "delta", text: "partial answer" },
        { type: "error", detail: "Language model service is currently unavailable." },
      ]),
    });

    const response = await POST(chatRequest({ messages: [userMessage("hi")], workspaceId, videoTimestamp: null }));
    // The HTTP response is already committed to 200 by the time the
    // mid-stream failure happens (priming already succeeded on the
    // first "delta" event) -- exactly Team 4B's own disclosed trade-off.
    expect(response.status).toBe(200);
    await response.text();

    expect(mockedMessageCreate).not.toHaveBeenCalled();
  });

  it("falls back to query() and the simulated replay, unaffected, when the active TeamBService has no queryStream()", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    authorizeDefaultConversation(workspaceId);
    mockedGetTeamBService.mockReturnValue({
      query: vi.fn().mockResolvedValue({ answer: "a non-streaming answer", session_id: "s", source_attributions: [], retrieval_metadata: {} }),
      // no queryStream — same shape as every pre-Stage-9B test double.
    });

    const response = await POST(chatRequest({ messages: [userMessage("hi")], workspaceId, videoTimestamp: null }));

    expect(response.status).toBe(200);
    const text = await readSseText(response);
    expect(text.trim()).toBe("a non-streaming answer");
  });

  it("Stage 2 — a stream that produces zero delta events (straight to done) does not crash and still finalizes correctly", async () => {
    // Investigated as part of the reported "blank response" issue --
    // Step 3's own hypothesis list calls out "a stream that produces no
    // content" explicitly. This is a real, legitimate case: Team4B's own
    // zero-retrieval short-circuit (Stage 7) returns its fixed
    // "I don't have enough information..." message as a SINGLE done
    // event with no prior deltas at all (see team4b's
    // RAGService._stream_casual_result / the zero-retrieval path).
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    authorizeDefaultConversation(workspaceId);
    mockedGetTeamBService.mockReturnValue({
      query: vi.fn(),
      queryStream: fakeQueryStream([
        {
          type: "done",
          answer: "I don't have enough information in the provided context to answer this question reliably.",
          session_id: "sess-1",
          source_attributions: [],
          retrieval_metadata: { chunks_retrieved: 0 },
        },
      ]),
    });

    const response = await POST(chatRequest({ messages: [userMessage("hi")], workspaceId, videoTimestamp: null }));

    expect(response.status).toBe(200);
    const raw = await response.text();
    // Stage 2 fix: even though Team4B sent zero "delta" events, the
    // browser must still receive the done event's own answer text as a
    // fallback delta -- never a genuinely empty bubble for a real,
    // complete answer. Before this fix, extractDeltaText(raw) here was
    // "" (confirmed by re-running this exact test against the
    // pre-fix route) even though the answer was already persisted.
    expect(extractDeltaText(raw)).toBe(
      "I don't have enough information in the provided context to answer this question reliably."
    );
    expect(raw).not.toContain("data-citations"); // zero-retrieval suppression still applies
    expect(mockedMessageCreate).toHaveBeenCalledTimes(2); // user + assistant still persisted
  });

  it("Stage 2 — a stream that ends with neither a delta nor a done event (upstream closed early) surfaces as a visible error, never a silent indefinite wait", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    authorizeDefaultConversation(workspaceId);
    mockedGetTeamBService.mockReturnValue({
      query: vi.fn(),
      // A first delta (so priming succeeds and the HTTP response is
      // already committed to 200), then the async generator simply ends
      // -- no "done", no "error". Simulates a genuinely severed upstream
      // connection.
      queryStream: fakeQueryStream([{ type: "delta", text: "partial answer " }]),
    });

    const response = await POST(chatRequest({ messages: [userMessage("hi")], workspaceId, videoTimestamp: null }));

    expect(response.status).toBe(200);
    const raw = await response.text();
    // The route's own "stream ended without a done event" guard (see
    // app/api/chat/route.ts) must throw, which onError maps to a visible
    // error part -- never a response that just silently stops with the
    // partial text looking "finished".
    expect(raw).toMatch(/"type":"error"|errorText/);
    expect(mockedMessageCreate).not.toHaveBeenCalled(); // partial answer never persisted as if complete
  });
});
