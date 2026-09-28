import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor, cleanup } from "@testing-library/react";

/**
 * Tests useChatStream's Requirement 8.1/8.2 integration: submitting while
 * offline, classifying a real network failure vs. an application error in
 * onError, and flushing the queue on the browser's "online" event. The
 * underlying @ai-sdk/react useChat is mocked (same approach as
 * ChatPanel.test.tsx) so these tests exercise useChatStream's own logic,
 * not the network/streaming internals (covered separately in
 * chat-api.test.ts and offlineQueue.test.ts).
 */

let capturedOptions: {
  onFinish?: (arg: { message: { id: string; role: string; parts: unknown[] } }) => void;
  onError?: (err: Error) => void;
} = {};
const sendMessageMock = vi.fn();
const regenerateMock = vi.fn();
const clearErrorMock = vi.fn();
const setMessagesMock = vi.fn();

vi.mock("@ai-sdk/react", () => ({
  useChat: (options: typeof capturedOptions) => {
    capturedOptions = options;
    return {
      messages: [],
      sendMessage: sendMessageMock,
      status: "ready",
      error: undefined,
      regenerate: regenerateMock,
      clearError: clearErrorMock,
      // Step 6: useChatStream now destructures setMessages to seed a
      // restored conversation's history — these tests pass
      // initialMessages: [] (see the useChatStream(...) call sites
      // below), so the seeding effect runs harmlessly with an empty
      // array; it still needs to exist to avoid a runtime TypeError.
      setMessages: setMessagesMock,
    };
  },
}));

vi.mock("ai", () => ({
  DefaultChatTransport: vi.fn(),
}));

// Stage 6 — useChatStream now calls useQueryClient() in its onFinish
// callback (sidebar invalidation, covered separately in
// useChatStream-sidebarInvalidation.test.tsx). This file's tests render
// the hook without a QueryClientProvider, so it must be mocked here too,
// same as @ai-sdk/react/ai above -- otherwise useQueryClient() throws
// with no provider, unrelated to what these tests actually verify.
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

import { useChatStream } from "@/hooks/useChatStream";
import { useAppStore } from "@/store/appStore";
import { __resetOfflineQueueFlushGuardForTests } from "@/components/chat/OfflineQueue";

beforeEach(() => {
  vi.clearAllMocks();
  useAppStore.getState().clearOfflineQueue();
  useAppStore.getState().clearMessages();
  // The video slice is real, shared, global Zustand store state -- an
  // earlier test that sets an active video timestamp (e.g. "preserves
  // the active video timestamp on the queued message", below) would
  // otherwise leak into every later test in this file, since nothing
  // else in this suite resets it.
  useAppStore.getState().setActiveMedia(null);
  useAppStore.getState().setVideoTimestamp(0);
  // See OfflineQueue.ts's own doc comment on this function: the flush
  // re-entrancy guard is module-global, so an earlier test's flush that
  // wasn't fully awaited to completion could otherwise leave it stuck,
  // silently no-oping every later test's own flushOfflineQueue call.
  __resetOfflineQueueFlushGuardForTests();
});

afterEach(() => {
  // Unmounts every renderHook() instance from the test that just ran --
  // without this, a hook's "online" event listener (registered via
  // useEffect) stays attached to `window` across tests, so a LATER
  // test's `window.dispatchEvent(new Event("online"))` would also
  // re-trigger an EARLIER test's already-finished hook instance,
  // racing it against OfflineQueue.ts's module-level `isFlushing` guard
  // in a way that depends on listener registration order -- exactly the
  // kind of cross-test interference this file's tests must not have.
  cleanup();
});

describe("useChatStream — Requirement 8.1 (queue on unreachable API)", () => {
  it("queues the message and never calls sendMessage when already offline at submit time", () => {
    vi.stubGlobal("navigator", { onLine: false });
    const { result, unmount } = renderHook(() => useChatStream("ws-1", "conv-1", []));

    act(() => {
      result.current.submitMessage("What is normalization?");
    });

    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(useAppStore.getState().chat.offlineQueue).toHaveLength(1);
    expect(useAppStore.getState().chat.offlineQueue[0].text).toBe("What is normalization?");
    expect(useAppStore.getState().chat.offlineQueue[0].workspaceId).toBe("ws-1");

    unmount();
    vi.unstubAllGlobals();
  });

  it("queues the message when sendMessage was attempted but failed with a real network error (TypeError)", () => {
    const { result, unmount } = renderHook(() => useChatStream("ws-1", "conv-1", []));

    act(() => {
      result.current.submitMessage("hello");
    });
    act(() => {
      capturedOptions.onError?.(new TypeError("Failed to fetch"));
    });

    expect(useAppStore.getState().chat.offlineQueue).toHaveLength(1);
    expect(useAppStore.getState().chat.messages).toHaveLength(0); // no error message shown
    unmount();
  });

  it("does NOT queue an application/HTTP error (e.g. Unauthorized) — falls through to the existing inline error path instead", () => {
    const { result, unmount } = renderHook(() => useChatStream("ws-1", "conv-1", []));

    act(() => {
      result.current.submitMessage("hello");
    });
    act(() => {
      capturedOptions.onError?.(new Error("Unauthorized"));
    });

    expect(useAppStore.getState().chat.offlineQueue).toHaveLength(0);
    unmount();
  });

  it("preserves the active video timestamp on the queued message", () => {
    useAppStore.getState().setActiveMedia("file-1");
    useAppStore.getState().setVideoTimestamp(1935);
    vi.stubGlobal("navigator", { onLine: false });

    const { result, unmount } = renderHook(() => useChatStream("ws-1", "conv-1", []));
    act(() => {
      result.current.submitMessage("What happens here?");
    });

    expect(useAppStore.getState().chat.offlineQueue[0].videoTimestamp).toBe(1935);
    unmount();
    vi.unstubAllGlobals();
  });
});

describe("useChatStream — Requirement 8.2 (auto-retry on reconnect)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("flushes the queue and calls sendMessage when the browser's online event fires", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    const { result, unmount } = renderHook(() => useChatStream("ws-1", "conv-1", []));
    act(() => {
      result.current.submitMessage("queued while offline");
    });
    expect(useAppStore.getState().chat.offlineQueue).toHaveLength(1);

    vi.stubGlobal("navigator", { onLine: true });
    act(() => {
      window.dispatchEvent(new Event("online"));
    });

    await waitFor(() =>
      expect(sendMessageMock).toHaveBeenCalledWith(
        { text: "queued while offline" },
        { body: { conversationId: "conv-1", workspaceId: "ws-1", videoTimestamp: null } }
      )
    );

    // Simulate that replay succeeding.
    act(() => {
      capturedOptions.onFinish?.({ message: { id: "m1", role: "assistant", parts: [] } });
    });

    await waitFor(() => expect(useAppStore.getState().chat.offlineQueue).toHaveLength(0));
    unmount();
  });
});

describe("useChatStream — MVP M5 correction (I): offline replay uses the ORIGINAL conversationId", () => {
  it("replays a queued message using the conversationId it was queued under, even if a DIFFERENT conversation is active now", async () => {
    vi.stubGlobal("navigator", { onLine: false });

    // Queued while conversation "conv-original" was active.
    const { result, rerender, unmount } = renderHook(
      ({ conversationId }) => useChatStream("ws-1", conversationId, []),
      { initialProps: { conversationId: "conv-original" } }
    );
    act(() => {
      result.current.submitMessage("queued under the original conversation");
    });
    expect(useAppStore.getState().chat.offlineQueue[0].conversationId).toBe("conv-original");

    // The user has since switched to a DIFFERENT conversation (e.g. a
    // workspace switch established a new one) -- the hook is re-rendered
    // with a new, different conversationId, simulating that.
    rerender({ conversationId: "conv-now-active" });

    vi.stubGlobal("navigator", { onLine: true });
    act(() => {
      window.dispatchEvent(new Event("online"));
    });

    // The replay must use "conv-original" -- the queued item's OWN
    // conversationId -- never "conv-now-active".
    await waitFor(() =>
      expect(sendMessageMock).toHaveBeenCalledWith(
        { text: "queued under the original conversation" },
        { body: { conversationId: "conv-original", workspaceId: "ws-1", videoTimestamp: null } }
      )
    );
    expect(sendMessageMock).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ body: expect.objectContaining({ conversationId: "conv-now-active" }) })
    );

    // Settles the flush cycle (mirrors the preceding 8.2 test's own
    // pattern) so this test doesn't leave OfflineQueue.ts's module-level
    // `isFlushing` guard stuck `true` for whichever test runs next.
    act(() => {
      capturedOptions.onFinish?.({ message: { id: "m1", role: "assistant", parts: [] } });
    });
    await waitFor(() => expect(useAppStore.getState().chat.offlineQueue).toHaveLength(0));

    unmount();
    vi.unstubAllGlobals();
  });
});

describe("useChatStream — MVP M5 micro-correction: replay failure never requeues under the CURRENT context", () => {
  it("a network failure during replay leaves the queued item's ORIGINAL workspace/conversation/videoTimestamp untouched, never rewritten to whatever is active now", async () => {
    // Pre-populate the offline queue directly with an item that belongs
    // to workspace-A / conversation-A / videoTimestamp=123 -- simulating
    // that it was queued earlier, under a different active context than
    // "now".
    useAppStore.getState().enqueueOfflineMessage({
      id: "original-item",
      text: "a question from workspace A",
      workspaceId: "workspace-A",
      conversationId: "conversation-A",
      videoTimestamp: 123,
      queuedAt: new Date(),
    });

    // The hook is currently rendered for a COMPLETELY DIFFERENT active
    // workspace/conversation (workspace-B / conversation-B) -- e.g. the
    // user switched while "original-item" was still queued.
    vi.stubGlobal("navigator", { onLine: true });
    const { unmount } = renderHook(() => useChatStream("workspace-B", "conversation-B", []));

    act(() => {
      window.dispatchEvent(new Event("online"));
    });

    // The replay attempt itself now fails with a real network error.
    await waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(1));
    act(() => {
      capturedOptions.onError?.(new TypeError("Failed to fetch"));
    });

    // The item must still be queued, and MUST STILL carry its ORIGINAL
    // context -- never rewritten to workspace-B/conversation-B.
    const queue = useAppStore.getState().chat.offlineQueue;
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      id: "original-item",
      workspaceId: "workspace-A",
      conversationId: "conversation-A",
      videoTimestamp: 123,
    });
    expect(queue[0].workspaceId).not.toBe("workspace-B");
    expect(queue[0].conversationId).not.toBe("conversation-B");

    // Lets the flush cycle's promise chain (triggered by onError above)
    // fully settle before the test ends.
    await waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(1));

    unmount();
    vi.unstubAllGlobals();
  });
});
