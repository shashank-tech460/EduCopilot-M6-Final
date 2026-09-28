import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Step 7/8 — unit tests for lib/restoreSession.ts in isolation, with
 * `@/models/Message` mocked (no live MongoDB) and a hand-built
 * `TeamBService`-shaped double per test (never the real client/mock,
 * mirroring the established convention in tests/unit/chat-api.test.ts).
 *
 * STEP 8: restoreSessionIfMissing now returns a `RestorationOutcome`
 * instead of always resolving to `undefined` -- these tests assert the
 * exact outcome, not just "did not throw", since the caller
 * (app/api/chat/route.ts) branches on it to decide whether to fail the
 * request explicitly.
 */

function messageFindResult(messages: unknown[]) {
  const query = {
    sort: () => query,
    limit: () => query,
    select: () => Promise.resolve(messages),
  };
  return query;
}

vi.mock("@/models/Message", () => ({
  MessageModel: {
    find: vi.fn(),
  },
}));

import { MessageModel } from "@/models/Message";
import { restoreSessionIfMissing } from "@/lib/restoreSession";

const mockedFind = vi.mocked(MessageModel.find);

function message(role: "user" | "assistant", content: string, createdAt: Date) {
  return { role, content, createdAt };
}

const AUTH = { sub: "user-1", workspace_id: "ws-1" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("restoreSessionIfMissing — TeamBService implementations without restoration support", () => {
  it("returns not-needed and never reads Mongo when the active TeamBService has no hasSession/seedSession (e.g. the local mock)", async () => {
    const teamB = { query: vi.fn() };

    const outcome = await restoreSessionIfMissing(teamB, "sess-1", "conv-1", AUTH);

    expect(outcome).toEqual({ status: "not-needed" });
    expect(mockedFind).not.toHaveBeenCalled();
  });
});

describe("restoreSessionIfMissing — nothing to restore", () => {
  it("returns not-needed and never calls Team B at all when there is no persisted history", async () => {
    mockedFind.mockReturnValue(messageFindResult([]) as never);
    const teamB = {
      query: vi.fn(),
      hasSession: vi.fn(),
      seedSession: vi.fn(),
    };

    const outcome = await restoreSessionIfMissing(teamB, "sess-1", "conv-1", AUTH);

    expect(outcome).toEqual({ status: "not-needed" });
    // A brand-new conversation with nothing to restore must never be
    // blocked by a Team B hiccup it doesn't actually depend on.
    expect(teamB.hasSession).not.toHaveBeenCalled();
  });
});

describe("restoreSessionIfMissing — session already exists", () => {
  it("returns not-needed and does not call seedSession when hasSession reports true", async () => {
    mockedFind.mockReturnValue(messageFindResult([message("user", "hi", new Date())]) as never);
    const teamB = {
      query: vi.fn(),
      hasSession: vi.fn().mockResolvedValue(true),
      seedSession: vi.fn(),
    };

    const outcome = await restoreSessionIfMissing(teamB, "sess-1", "conv-1", AUTH);

    expect(outcome).toEqual({ status: "not-needed" });
    expect(teamB.seedSession).not.toHaveBeenCalled();
  });
});

describe("restoreSessionIfMissing — session missing, restoring from Mongo history", () => {
  it("restores from the correct conversation's persisted history, in chronological order, and returns restored", async () => {
    mockedFind.mockReturnValue(
      messageFindResult([
        message("assistant", "second", new Date("2026-01-01T00:02:00.000Z")),
        message("user", "first", new Date("2026-01-01T00:01:00.000Z")),
      ]) as never
    );
    const teamB = {
      query: vi.fn(),
      hasSession: vi.fn().mockResolvedValue(false),
      seedSession: vi.fn().mockResolvedValue({ session_id: "sess-1", seeded: true, turn_count: 2 }),
    };

    const outcome = await restoreSessionIfMissing(teamB, "sess-1", "conv-1", AUTH);

    expect(outcome).toEqual({ status: "restored" });
    expect(mockedFind).toHaveBeenCalledWith({ conversationId: "conv-1" });
    expect(teamB.seedSession).toHaveBeenCalledTimes(1);
    const [sessionId, turns, auth] = teamB.seedSession.mock.calls[0];
    expect(sessionId).toBe("sess-1");
    expect(turns.map((t: { content: string }) => t.content)).toEqual(["first", "second"]); // oldest-first
    expect(auth).toEqual(AUTH);
  });

  it("converts createdAt to epoch-seconds timestamps for each restored turn", async () => {
    mockedFind.mockReturnValue(messageFindResult([message("user", "hi", new Date("2026-01-01T00:00:00.000Z"))]) as never);
    const teamB = {
      query: vi.fn(),
      hasSession: vi.fn().mockResolvedValue(false),
      seedSession: vi.fn().mockResolvedValue({ session_id: "sess-1", seeded: true, turn_count: 1 }),
    };

    await restoreSessionIfMissing(teamB, "sess-1", "conv-1", AUTH);

    const turns = teamB.seedSession.mock.calls[0][1];
    expect(turns[0].timestamp).toBeCloseTo(new Date("2026-01-01T00:00:00.000Z").getTime() / 1000);
  });

  it("never includes messages from a different conversation (isolation)", async () => {
    mockedFind.mockImplementation(
      ((query: { conversationId: string }) =>
        messageFindResult(
          query.conversationId === "conv-1" ? [message("user", "conv-1's message", new Date())] : []
        )) as never
    );
    const teamB = {
      query: vi.fn(),
      hasSession: vi.fn().mockResolvedValue(false),
      seedSession: vi.fn().mockResolvedValue({ session_id: "sess-1", seeded: true, turn_count: 1 }),
    };

    await restoreSessionIfMissing(teamB, "sess-1", "conv-1", AUTH);

    const turns = teamB.seedSession.mock.calls[0][1];
    expect(turns).toHaveLength(1);
    expect(turns[0].content).toBe("conv-1's message");
  });
});

describe("restoreSessionIfMissing — Step 8: explicit failure handling (never a silent context loss)", () => {
  it("returns team-b-unavailable (never throws, never proceeds) when hasSession itself rejects and real history exists", async () => {
    mockedFind.mockReturnValue(messageFindResult([message("user", "important context", new Date())]) as never);
    const teamB = {
      query: vi.fn(),
      hasSession: vi.fn().mockRejectedValue(new Error("Team B unreachable")),
      seedSession: vi.fn(),
    };

    const outcome = await restoreSessionIfMissing(teamB, "sess-1", "conv-1", AUTH);

    expect(outcome).toEqual({ status: "team-b-unavailable" });
    expect(teamB.seedSession).not.toHaveBeenCalled();
  });

  it("returns team-b-unavailable when seedSession itself rejects", async () => {
    mockedFind.mockReturnValue(messageFindResult([message("user", "hi", new Date())]) as never);
    const teamB = {
      query: vi.fn(),
      hasSession: vi.fn().mockResolvedValue(false),
      seedSession: vi.fn().mockRejectedValue(new Error("Team B seed failed")),
    };

    const outcome = await restoreSessionIfMissing(teamB, "sess-1", "conv-1", AUTH);

    expect(outcome).toEqual({ status: "team-b-unavailable" });
  });

  it("returns internal-error (distinct from team-b-unavailable) when the Mongo read itself rejects", async () => {
    mockedFind.mockImplementation(() => {
      throw new Error("Mongo unavailable");
    });
    const teamB = {
      query: vi.fn(),
      hasSession: vi.fn(),
      seedSession: vi.fn(),
    };

    const outcome = await restoreSessionIfMissing(teamB, "sess-1", "conv-1", AUTH);

    expect(outcome).toEqual({ status: "internal-error" });
    // Never even reached Team B -- this app's own history read failed first.
    expect(teamB.hasSession).not.toHaveBeenCalled();
  });

  it("never rejects/throws in any failure scenario — always resolves to a status object", async () => {
    mockedFind.mockReturnValue(messageFindResult([message("user", "hi", new Date())]) as never);
    const teamB = {
      query: vi.fn(),
      hasSession: vi.fn().mockRejectedValue(new Error("boom")),
      seedSession: vi.fn(),
    };

    await expect(restoreSessionIfMissing(teamB, "sess-1", "conv-1", AUTH)).resolves.toEqual({
      status: "team-b-unavailable",
    });
  });
});
