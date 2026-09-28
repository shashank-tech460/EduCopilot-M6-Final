import { describe, expect, it, vi, beforeEach } from "vitest";
import { Types } from "mongoose";

/**
 * Tests the file API routes directly (real Request objects), with `auth`,
 * `connectToDatabase`, `WorkspaceModel` (used internally by the real,
 * un-mocked assertOwnership()), `FileModel`, `services/storage`, and
 * `services/teamA` all mocked. No live MongoDB connection is opened.
 * Mirrors the approach already established in tests/unit/workspaces-api.test.ts.
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

vi.mock("@/models/File", () => ({
  FileModel: {
    find: vi.fn(),
    create: vi.fn(),
    findById: vi.fn(),
    findByIdAndDelete: vi.fn(),
    findOne: vi.fn(),
  },
}));

vi.mock("@/services/storage", () => ({
  storeFile: vi.fn(),
  referenceYoutubeUrl: vi.fn(),
  deleteStoredFile: vi.fn().mockResolvedValue(undefined),
  mintLocalStorageRetrievalUrl: vi.fn(async (file: { storageUrl: string }) => file.storageUrl),
}));

vi.mock("@/services/teamA", () => ({
  getTeamAService: vi.fn(),
}));

import { auth } from "@/lib/auth";
import { WorkspaceModel } from "@/models/Workspace";
import { FileModel } from "@/models/File";
import { referenceYoutubeUrl } from "@/services/storage";
import { getTeamAService } from "@/services/teamA";
import { TeamASubmitError } from "@/services/teamA/client";
import { GET, POST } from "@/app/api/workspaces/[id]/files/route";
import { DELETE } from "@/app/api/workspaces/[id]/files/[fileId]/route";
import { POST as RETRY } from "@/app/api/workspaces/[id]/files/[fileId]/retry/route";

type SimpleAuthFn = () => Promise<{
  user: { id: string; name?: string | null; email?: string | null };
  expires: string;
} | null>;

const mockedAuth = vi.mocked(auth) as unknown as ReturnType<typeof vi.fn<SimpleAuthFn>>;
const mockedWorkspaceFindById = vi.mocked(WorkspaceModel.findById);
const mockedFileFind = vi.mocked(FileModel.find);
const mockedFileCreate = vi.mocked(FileModel.create);
const mockedFileFindById = vi.mocked(FileModel.findById);
const mockedFileFindByIdAndDelete = vi.mocked(FileModel.findByIdAndDelete);
const mockedFileFindOne = vi.mocked(FileModel.findOne);
const mockedReferenceYoutubeUrl = vi.mocked(referenceYoutubeUrl);
const mockedGetTeamAService = vi.mocked(getTeamAService);

function fakeSession(userId: string) {
  return {
    user: { id: userId, name: "Sample Student", email: "sample.student@example.com" },
    expires: "2099-01-01",
  } as never;
}

function ownedWorkspace(id: string, ownerId: string) {
  return { _id: new Types.ObjectId(id), userId: new Types.ObjectId(ownerId), name: "DBMS" } as never;
}

function paramsFor(id: string) {
  return { params: Promise.resolve({ id }) };
}

function fileParamsFor(id: string, fileId: string) {
  return { params: Promise.resolve({ id, fileId }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  // A deterministic fake Team A service for every test — individual tests
  // override submit()/checkStatus() only when the return value matters.
  mockedGetTeamAService.mockReturnValue({
    submit: vi.fn().mockResolvedValue({ ingestionId: "mock-test-id" }),
    checkStatus: vi.fn().mockResolvedValue({ status: "ready", error: null }),
  });
  // Stage 9 default: "no existing upload attempt matches this
  // uploadIdempotencyKey" -- every pre-Stage-9 test (which never sends
  // one, or doesn't care) proceeds straight to create exactly as before.
  mockedFileFindOne.mockResolvedValue(null);
});

describe("GET /api/workspaces/[id]/files", () => {
  it("returns 401 when unauthenticated", async () => {
    mockedAuth.mockResolvedValue(null);
    const response = await GET(new Request("http://localhost"), paramsFor(new Types.ObjectId().toString()));
    expect(response.status).toBe(401);
  });

  it("returns 404 (not 403) when the workspace belongs to another user — item 9", async () => {
    const ownerId = new Types.ObjectId().toString();
    const attackerId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(attackerId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, ownerId));

    const response = await GET(new Request("http://localhost"), paramsFor(workspaceId));

    expect(response.status).toBe(404);
    expect(mockedFileFind).not.toHaveBeenCalled();
  });

  it("returns the owner's materials when the workspace belongs to them — item 8", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    const sortMock = vi.fn().mockResolvedValue([]);
    mockedFileFind.mockReturnValue({ sort: sortMock } as never);

    const response = await GET(new Request("http://localhost"), paramsFor(workspaceId));

    expect(response.status).toBe(200);
    expect(mockedFileFind).toHaveBeenCalledWith({ workspaceId });
  });

  it("safely handles a malformed workspace ID (not a valid ObjectId) — item 15", async () => {
    mockedAuth.mockResolvedValue(fakeSession(new Types.ObjectId().toString()));

    const response = await GET(new Request("http://localhost"), paramsFor("not-a-valid-id"));

    expect(response.status).toBe(404);
    expect(mockedWorkspaceFindById).not.toHaveBeenCalled();
    expect(mockedFileFind).not.toHaveBeenCalled();
  });
});

describe("POST /api/workspaces/[id]/files", () => {
  function formDataRequest(fields: Record<string, string | globalThis.File>) {
    const formData = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      formData.set(key, value);
    }
    return new Request("http://localhost", { method: "POST", body: formData });
  }

  it("returns 401 when unauthenticated — item 5", async () => {
    mockedAuth.mockResolvedValue(null);
    const response = await POST(
      formDataRequest({ type: "youtube_url", youtubeUrl: "https://youtu.be/dQw4w9WgXcQ" }),
      paramsFor(new Types.ObjectId().toString())
    );
    expect(response.status).toBe(401);
  });

  it("denies upload to another user's workspace — item 7", async () => {
    const ownerId = new Types.ObjectId().toString();
    const attackerId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(attackerId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, ownerId));

    const response = await POST(
      formDataRequest({ type: "youtube_url", youtubeUrl: "https://youtu.be/dQw4w9WgXcQ" }),
      paramsFor(workspaceId)
    );

    expect(response.status).toBe(404);
    expect(mockedFileCreate).not.toHaveBeenCalled();
  });

  it("accepts a valid YouTube URL upload to the user's own workspace — item 6", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    mockedReferenceYoutubeUrl.mockReturnValue({
      storageUrl: "https://youtu.be/dQw4w9WgXcQ",
      storageProvider: "youtube",
      publicId: "https://youtu.be/dQw4w9WgXcQ",
    });

    const createdId = new Types.ObjectId();
    const savedDoc = {
      _id: createdId,
      workspaceId,
      originalName: "https://youtu.be/dQw4w9WgXcQ",
      type: "youtube_url",
      status: "uploading",
      processingError: null,
      storageUrl: "https://youtu.be/dQw4w9WgXcQ",
      createdAt: new Date(),
      save: vi.fn().mockResolvedValue(undefined),
    };
    mockedFileCreate.mockResolvedValue(savedDoc as never);

    const response = await POST(
      formDataRequest({ type: "youtube_url", youtubeUrl: "https://youtu.be/dQw4w9WgXcQ" }),
      paramsFor(workspaceId)
    );
    const data = await response.json();

    expect(response.status).toBe(201);
    expect(data.id).toBe(createdId.toString());
    // Confirms the Team A hand-off actually ran and updated status —
    // "mock Team A hand-off works" end-to-end through the real route.
    expect(data.status).toBe("ready");
  });

  it("Phase 6G / item E — a real Team A ingestion failure (e.g. aborted_authority_lost) reaches status='failed' with an accurate processingError, not a false 'ready'", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    mockedReferenceYoutubeUrl.mockReturnValue({
      storageUrl: "https://youtu.be/dQw4w9WgXcQ",
      storageProvider: "youtube",
      publicId: "https://youtu.be/dQw4w9WgXcQ",
    });
    // Mirrors the real client's behavior: services/teamA/client.ts's
    // realTeamA.submit() throws a TeamASubmitError when Team A's
    // canonical /v1/ingest returns a non-2xx status (e.g. 409
    // aborted_authority_lost) -- confirmed live against the real
    // service, see docs/PHASE_6_LIVE_COLLECTION_ALIGNMENT.md §9.
    mockedGetTeamAService.mockReturnValue({
      submit: vi.fn().mockRejectedValue(new TeamASubmitError(409)),
      checkStatus: vi.fn(),
    });

    const savedDoc = {
      _id: new Types.ObjectId(),
      workspaceId,
      originalName: "https://youtu.be/dQw4w9WgXcQ",
      type: "youtube_url",
      status: "uploading",
      processingError: null,
      storageUrl: "https://youtu.be/dQw4w9WgXcQ",
      createdAt: new Date(),
      save: vi.fn().mockResolvedValue(undefined),
    };
    mockedFileCreate.mockResolvedValue(savedDoc as never);

    const response = await POST(
      formDataRequest({ type: "youtube_url", youtubeUrl: "https://youtu.be/dQw4w9WgXcQ" }),
      paramsFor(workspaceId)
    );
    const data = await response.json();

    expect(response.status).toBe(201); // upload itself still succeeds; ingestion status is carried in the body
    expect(data.status).toBe("failed");
    // Stage 9: the raw status code is deliberately NOT exposed to the
    // user any more -- describeIngestionFailure() maps a 409 to a fixed,
    // safe, actionable message instead (see tests/unit/ingestion.test.ts
    // for the full status->message mapping, tested in isolation).
    expect(data.processingError).not.toContain("409");
    expect(data.processingError).toBe(
      "This file is already being processed. Please wait a moment, then refresh and try again."
    );
    // The in-memory document was actually mutated to reflect the real
    // failure and persisted via save() -- not silently left as "uploading"
    // or forced to "ready".
    expect(savedDoc.status).toBe("failed");
    expect(savedDoc.save).toHaveBeenCalled();
  });

  it("rejects an invalid YouTube URL with 400, without creating a file", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));

    const response = await POST(
      formDataRequest({ type: "youtube_url", youtubeUrl: "https://example.com/not-youtube" }),
      paramsFor(workspaceId)
    );

    expect(response.status).toBe(400);
    expect(mockedFileCreate).not.toHaveBeenCalled();
  });

  it("stores the file's initial status as 'uploading' before hand-off (item 12)", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    mockedReferenceYoutubeUrl.mockReturnValue({
      storageUrl: "https://youtu.be/dQw4w9WgXcQ",
      storageProvider: "youtube",
      publicId: "https://youtu.be/dQw4w9WgXcQ",
    });
    mockedFileCreate.mockResolvedValue({
      _id: new Types.ObjectId(),
      workspaceId,
      originalName: "x",
      type: "youtube_url",
      status: "uploading",
      processingError: null,
      storageUrl: "x",
      createdAt: new Date(),
      save: vi.fn().mockResolvedValue(undefined),
    } as never);

    await POST(
      formDataRequest({ type: "youtube_url", youtubeUrl: "https://youtu.be/dQw4w9WgXcQ" }),
      paramsFor(workspaceId)
    );

    const createCallArgs = mockedFileCreate.mock.calls[0][0] as Record<string, unknown>;
    // The route relies on the schema default rather than hardcoding a
    // status itself — confirmed independently in models.test.ts. Here we
    // confirm the route doesn't override that default with something else.
    expect(createCallArgs.status).toBe("uploading");
  });

  it("safely handles a malformed workspace ID (not a valid ObjectId) — item 15", async () => {
    mockedAuth.mockResolvedValue(fakeSession(new Types.ObjectId().toString()));

    const response = await POST(
      formDataRequest({ type: "youtube_url", youtubeUrl: "https://youtu.be/dQw4w9WgXcQ" }),
      paramsFor("not-a-valid-id")
    );

    expect(response.status).toBe(404);
    expect(mockedFileCreate).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/workspaces/[id]/files/[fileId]", () => {
  it("returns 401 when unauthenticated", async () => {
    mockedAuth.mockResolvedValue(null);
    const response = await DELETE(
      new Request("http://localhost"),
      fileParamsFor(new Types.ObjectId().toString(), new Types.ObjectId().toString())
    );
    expect(response.status).toBe(401);
  });

  it("deletes a material the user owns — item 10", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    const fileId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    mockedFileFindById.mockResolvedValue({
      _id: new Types.ObjectId(fileId),
      workspaceId: new Types.ObjectId(workspaceId),
      storageProvider: "local-mock",
      publicId: "abc",
    } as never);

    const response = await DELETE(new Request("http://localhost"), fileParamsFor(workspaceId, fileId));

    expect(response.status).toBe(200);
    expect(mockedFileFindByIdAndDelete).toHaveBeenCalledWith(fileId);
  });

  it("denies deleting a material when the workspace belongs to another user — item 11", async () => {
    const ownerId = new Types.ObjectId().toString();
    const attackerId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(attackerId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, ownerId));

    const response = await DELETE(
      new Request("http://localhost"),
      fileParamsFor(workspaceId, new Types.ObjectId().toString())
    );

    expect(response.status).toBe(404);
    expect(mockedFileFindByIdAndDelete).not.toHaveBeenCalled();
  });

  it("denies deleting a file that belongs to a different workspace than the one requested — item 11", async () => {
    const userId = new Types.ObjectId().toString();
    const requestedWorkspaceId = new Types.ObjectId().toString();
    const actualWorkspaceId = new Types.ObjectId().toString();
    const fileId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    // The requester DOES own the workspace they're asking about...
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(requestedWorkspaceId, userId));
    // ...but the file actually belongs to a different workspace entirely.
    mockedFileFindById.mockResolvedValue({
      _id: new Types.ObjectId(fileId),
      workspaceId: new Types.ObjectId(actualWorkspaceId),
      storageProvider: "local-mock",
      publicId: "abc",
    } as never);

    const response = await DELETE(
      new Request("http://localhost"),
      fileParamsFor(requestedWorkspaceId, fileId)
    );

    expect(response.status).toBe(404);
    expect(mockedFileFindByIdAndDelete).not.toHaveBeenCalled();
  });

  it("safely handles a malformed file ID", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));

    const response = await DELETE(
      new Request("http://localhost"),
      fileParamsFor(workspaceId, "not-a-valid-id")
    );

    expect(response.status).toBe(404);
    expect(mockedFileFindById).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Stage 9 — upload idempotency / duplicate prevention.
//
// `resolveUploadedFile()` (lib/ingestion.ts) is what makes a retry of an
// upload whose earlier response the client never received (ambiguous
// network failure) safe: the SAME `uploadIdempotencyKey` is sent again,
// and the route must recognize the existing File instead of creating a
// second one. Exercised here via the YouTube branch specifically (a
// plain string URL, no `File`/binary body) -- `resolveUploadedFile()`
// itself has no knowledge of material type, so this equally proves the
// PDF/MP4 branch's identical call to it; jsdom (this suite's default
// test environment) does not reliably round-trip a real binary `File`
// through `Request`/`FormData`, which is why the byte-upload path's OWN
// idempotency behavior is instead covered by
// tests/component/workspace-files-upload.test.tsx (client-side) and by
// this same `resolveUploadedFile()` logic being shared code, not
// per-branch duplicated code.
// ---------------------------------------------------------------------------

describe("POST /api/workspaces/[id]/files — Stage 9: upload idempotency / duplicate prevention", () => {
  function youtubeUploadRequest(idempotencyKey: string | undefined) {
    const formData = new FormData();
    formData.set("type", "youtube_url");
    formData.set("youtubeUrl", "https://youtu.be/dQw4w9WgXcQ");
    if (idempotencyKey !== undefined) {
      formData.set("uploadIdempotencyKey", idempotencyKey);
    }
    return new Request("http://localhost", { method: "POST", body: formData });
  }

  function existingFile(status: "uploading" | "processing" | "ready" | "failed", workspaceId: string) {
    return {
      _id: new Types.ObjectId(),
      workspaceId: new Types.ObjectId(workspaceId),
      originalName: "https://youtu.be/dQw4w9WgXcQ",
      type: "youtube_url",
      status,
      processingError: status === "failed" ? "Something went wrong while processing your file. Please try again." : null,
      storageUrl: "https://youtu.be/dQw4w9WgXcQ",
      storageProvider: "youtube",
      createdAt: new Date(),
      save: vi.fn().mockResolvedValue(undefined),
    };
  }

  beforeEach(() => {
    mockedReferenceYoutubeUrl.mockReturnValue({
      storageUrl: "https://youtu.be/dQw4w9WgXcQ",
      storageProvider: "youtube",
      publicId: "https://youtu.be/dQw4w9WgXcQ",
    });
  });

  it("returns the existing file as-is (200) when a matching attempt already succeeded — never re-registers or re-hands-off", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    const ready = existingFile("ready", workspaceId);
    mockedFileFindOne.mockResolvedValue(ready as never);
    const submitMock = vi.fn();
    mockedGetTeamAService.mockReturnValue({ submit: submitMock, checkStatus: vi.fn() });

    const response = await POST(youtubeUploadRequest("retry-key-1"), paramsFor(workspaceId));
    const data = await response.json();

    expect(response.status).toBe(200); // not 201 -- nothing new was created
    expect(data.id).toBe(ready._id.toString());
    expect(data.status).toBe("ready");
    expect(mockedFileCreate).not.toHaveBeenCalled();
    expect(submitMock).not.toHaveBeenCalled();
  });

  it("reuses the existing File and retries ingestion (never creating a second File) when a matching attempt previously failed", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    const failed = existingFile("failed", workspaceId);
    mockedFileFindOne.mockResolvedValue(failed as never);
    const submitMock = vi.fn().mockResolvedValue({ ingestionId: "retry-ingestion-id" });
    mockedGetTeamAService.mockReturnValue({
      submit: submitMock,
      checkStatus: vi.fn().mockResolvedValue({ status: "ready", error: null }),
    });

    const response = await POST(youtubeUploadRequest("retry-key-2"), paramsFor(workspaceId));
    const data = await response.json();

    expect(response.status).toBe(200); // reused, not a fresh 201 creation
    expect(data.id).toBe(failed._id.toString());
    expect(data.status).toBe("ready");
    expect(mockedFileCreate).not.toHaveBeenCalled(); // never creates a second File
    // The SAME document_id (this File's own _id) is resubmitted -- exactly
    // what makes Team A's own generation-based idempotency safe here.
    expect(submitMock).toHaveBeenCalledWith(
      expect.objectContaining({ document_id: failed._id.toString() }),
      expect.anything()
    );
  });

  it("returns 409 without touching anything when a matching attempt is currently uploading", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    mockedFileFindOne.mockResolvedValue(existingFile("uploading", workspaceId) as never);
    const submitMock = vi.fn();
    mockedGetTeamAService.mockReturnValue({ submit: submitMock, checkStatus: vi.fn() });

    const response = await POST(youtubeUploadRequest("retry-key-3"), paramsFor(workspaceId));

    expect(response.status).toBe(409);
    expect(mockedFileCreate).not.toHaveBeenCalled();
    expect(submitMock).not.toHaveBeenCalled();
  });

  it("returns 409 without touching anything when a matching attempt is currently processing", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    mockedFileFindOne.mockResolvedValue(existingFile("processing", workspaceId) as never);

    const response = await POST(youtubeUploadRequest("retry-key-4"), paramsFor(workspaceId));

    expect(response.status).toBe(409);
    expect(mockedFileCreate).not.toHaveBeenCalled();
  });

  it("creates a new File exactly as before when no uploadIdempotencyKey is sent at all (backward compatible)", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    mockedFileCreate.mockResolvedValue({
      _id: new Types.ObjectId(),
      workspaceId,
      originalName: "https://youtu.be/dQw4w9WgXcQ",
      type: "youtube_url",
      status: "uploading",
      processingError: null,
      storageUrl: "https://youtu.be/dQw4w9WgXcQ",
      createdAt: new Date(),
      save: vi.fn().mockResolvedValue(undefined),
    } as never);

    const response = await POST(youtubeUploadRequest(undefined), paramsFor(workspaceId));

    expect(response.status).toBe(201);
    expect(mockedFileFindOne).not.toHaveBeenCalled(); // no key -> lookup is skipped entirely
    expect(mockedFileCreate).toHaveBeenCalledTimes(1);
  });

  it("gracefully reuses the existing file (never a raw 500) when two concurrent requests race to create with the same key", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    const winner = existingFile("uploading", workspaceId);
    // First lookup (before create) finds nothing; the create itself then
    // races another request and loses (a real unique-index violation);
    // the second lookup (the race-recovery path) finds the WINNING
    // request's own File.
    mockedFileFindOne.mockResolvedValueOnce(null).mockResolvedValueOnce(winner as never);
    mockedFileCreate.mockRejectedValue(Object.assign(new Error("E11000 duplicate key error"), { code: 11000 }));

    const response = await POST(youtubeUploadRequest("race-key"), paramsFor(workspaceId));
    const data = await response.json();

    expect(response.status).toBe(409); // the winner's own File is "uploading" -- a genuine in-progress conflict
    expect(data.error).toContain("already in progress");
  });
});

// ---------------------------------------------------------------------------
// Stage 9 — POST /api/workspaces/[id]/files/[fileId]/retry
// ---------------------------------------------------------------------------

describe("POST /api/workspaces/[id]/files/[fileId]/retry", () => {
  it("returns 401 when unauthenticated", async () => {
    mockedAuth.mockResolvedValue(null);

    const response = await RETRY(
      new Request("http://localhost", { method: "POST" }),
      fileParamsFor(new Types.ObjectId().toString(), new Types.ObjectId().toString())
    );

    expect(response.status).toBe(401);
  });

  it("returns 404 when the workspace belongs to another user", async () => {
    const ownerId = new Types.ObjectId().toString();
    const attackerId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(attackerId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, ownerId));

    const response = await RETRY(
      new Request("http://localhost", { method: "POST" }),
      fileParamsFor(workspaceId, new Types.ObjectId().toString())
    );

    expect(response.status).toBe(404);
    expect(mockedFileFindById).not.toHaveBeenCalled();
  });

  it("returns 404 for a malformed file ID", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));

    const response = await RETRY(
      new Request("http://localhost", { method: "POST" }),
      fileParamsFor(workspaceId, "not-a-valid-id")
    );

    expect(response.status).toBe(404);
    expect(mockedFileFindById).not.toHaveBeenCalled();
  });

  it("returns 404 for a file belonging to a different workspace than requested", async () => {
    const userId = new Types.ObjectId().toString();
    const requestedWorkspaceId = new Types.ObjectId().toString();
    const actualWorkspaceId = new Types.ObjectId().toString();
    const fileId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(requestedWorkspaceId, userId));
    mockedFileFindById.mockResolvedValue({
      _id: new Types.ObjectId(fileId),
      workspaceId: new Types.ObjectId(actualWorkspaceId),
      status: "failed",
    } as never);

    const response = await RETRY(
      new Request("http://localhost", { method: "POST" }),
      fileParamsFor(requestedWorkspaceId, fileId)
    );

    expect(response.status).toBe(404);
  });

  it("returns 409 and does not call Team A when the file is not currently in a failed state", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    const fileId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    mockedFileFindById.mockResolvedValue({
      _id: new Types.ObjectId(fileId),
      workspaceId: new Types.ObjectId(workspaceId),
      status: "ready",
    } as never);
    const submitMock = vi.fn();
    mockedGetTeamAService.mockReturnValue({ submit: submitMock, checkStatus: vi.fn() });

    const response = await RETRY(
      new Request("http://localhost", { method: "POST" }),
      fileParamsFor(workspaceId, fileId)
    );

    expect(response.status).toBe(409);
    expect(submitMock).not.toHaveBeenCalled();
  });

  it("retries ingestion on the existing File (same document_id) and returns the updated file on success", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    const fileId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    const failedFile = {
      _id: new Types.ObjectId(fileId),
      workspaceId: new Types.ObjectId(workspaceId),
      originalName: "notes.pdf",
      type: "pdf",
      status: "failed",
      processingError: "Something went wrong while processing your file. Please try again.",
      storageUrl: "https://example.test/notes.pdf",
      storageProvider: "local-mock",
      publicId: "notes-public-id",
      createdAt: new Date(),
      save: vi.fn().mockResolvedValue(undefined),
    };
    mockedFileFindById.mockResolvedValue(failedFile as never);
    const submitMock = vi.fn().mockResolvedValue({ ingestionId: "retry-attempt-id" });
    mockedGetTeamAService.mockReturnValue({
      submit: submitMock,
      checkStatus: vi.fn().mockResolvedValue({ status: "ready", error: null }),
    });

    const response = await RETRY(
      new Request("http://localhost", { method: "POST" }),
      fileParamsFor(workspaceId, fileId)
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.status).toBe("ready");
    expect(submitMock).toHaveBeenCalledWith(
      expect.objectContaining({ document_id: fileId }),
      expect.anything()
    );
  });

  it("on a repeated Team A failure, returns the file still 'failed' with a safe message rather than throwing", async () => {
    const userId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId().toString();
    const fileId = new Types.ObjectId().toString();
    mockedAuth.mockResolvedValue(fakeSession(userId));
    mockedWorkspaceFindById.mockResolvedValue(ownedWorkspace(workspaceId, userId));
    const failedFile = {
      _id: new Types.ObjectId(fileId),
      workspaceId: new Types.ObjectId(workspaceId),
      originalName: "notes.pdf",
      type: "pdf",
      status: "failed",
      processingError: "This file is already being processed. Please wait a moment, then refresh and try again.",
      storageUrl: "https://example.test/notes.pdf",
      storageProvider: "local-mock",
      publicId: "notes-public-id",
      createdAt: new Date(),
      save: vi.fn().mockResolvedValue(undefined),
    };
    mockedFileFindById.mockResolvedValue(failedFile as never);
    mockedGetTeamAService.mockReturnValue({
      submit: vi.fn().mockRejectedValue(new TeamASubmitError(409)),
      checkStatus: vi.fn(),
    });

    const response = await RETRY(
      new Request("http://localhost", { method: "POST" }),
      fileParamsFor(workspaceId, fileId)
    );
    const data = await response.json();

    expect(response.status).toBe(200); // the retry ROUTE succeeded at attempting the retry
    expect(data.status).toBe("failed"); // but ingestion itself failed again
    expect(data.processingError).toBe(
      "This file is already being processed. Please wait a moment, then refresh and try again."
    );
  });
});
