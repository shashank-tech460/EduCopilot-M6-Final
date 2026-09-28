import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, cleanup } from "@testing-library/react";

/**
 * Regression test for the stuck-stream watchdog (MVP polish pass).
 *
 * ROOT CAUSE this guards (confirmed via live investigation, not assumed):
 * a Next.js dev-server Fast Refresh remount while a response is streaming
 * leaves useChat()'s internal Chat instance permanently at
 * status === "streaming" — Team4B's own logs show the request actually
 * completed, but the UI never receives it and stays on "Thinking…"
 * forever with no way to recover (submitMessage refuses to send while
 * isStreaming). The fix: if streaming is still ongoing after
 * STUCK_STREAM_TIMEOUT_MS, useChatStream changes useChat()'s `id` (the
 * SDK's own documented mechanism for creating a fresh Chat instance),
 * abandoning the orphaned one, and reports `timedOut: true` so the UI can
 * tell the user what happened instead of leaving them stuck silently.
 *
 * The mocked useChat() below always reports status: "streaming" and
 * records every distinct `id` it was constructed with -- this test
 * verifies that after the timeout elapses, useChatStream requests a NEW,
 * distinct id (proving it abandoned the stuck instance) and flips
 * timedOut to true, without ever needing a real network/stream.
 */

const capturedIds: string[] = [];
const sendMessageMock = vi.fn();
const regenerateMock = vi.fn();
const clearErrorMock = vi.fn();
const setMessagesMock = vi.fn();

vi.mock("@ai-sdk/react", () => ({
  // A fresh Chat instance (any id past the original "#0" generation)
  // reports "ready", matching real useChat() behavior for a newly
  // constructed instance -- only the very first, never-recreated
  // instance is held "streaming" to simulate the stuck stream.
  useChat: (options: { id: string }) => {
    if (capturedIds[capturedIds.length - 1] !== options.id) {
      capturedIds.push(options.id);
    }
    return {
      messages: [],
      sendMessage: sendMessageMock,
      status: options.id.endsWith("#0") ? "streaming" : "ready",
      error: undefined,
      regenerate: regenerateMock,
      clearError: clearErrorMock,
      setMessages: setMessagesMock,
    };
  },
}));

vi.mock("ai", () => ({
  DefaultChatTransport: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

import { useChatStream } from "@/hooks/useChatStream";
import { useAppStore } from "@/store/appStore";

beforeEach(() => {
  vi.clearAllMocks();
  capturedIds.length = 0;
  useAppStore.getState().clearMessages();
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useChatStream stuck-stream watchdog", () => {
  it("abandons a stream stuck for longer than the watchdog timeout and reports timedOut", async () => {
    const { result, rerender } = renderHook(
      ({ conversationId }: { conversationId: string | null }) =>
        useChatStream("ws-1", conversationId, []),
      { initialProps: { conversationId: "conv-1" } }
    );

    expect(capturedIds).toEqual(["conv-1#0"]);
    expect(result.current.timedOut).toBe(false);

    await vi.advanceTimersByTimeAsync(240_000);
    rerender({ conversationId: "conv-1" });

    expect(capturedIds).toEqual(["conv-1#0", "conv-1#1"]);
    expect(result.current.timedOut).toBe(true);
    expect(useAppStore.getState().chat.isStreaming).toBe(false);
  });

  it("does not fire before the timeout elapses", async () => {
    const { result, rerender } = renderHook(
      ({ conversationId }: { conversationId: string | null }) =>
        useChatStream("ws-1", conversationId, []),
      { initialProps: { conversationId: "conv-2" } }
    );

    await vi.advanceTimersByTimeAsync(239_000);
    rerender({ conversationId: "conv-2" });

    expect(capturedIds).toEqual(["conv-2#0"]);
    expect(result.current.timedOut).toBe(false);
  });

  it("clears timedOut when a new message is submitted", async () => {
    const { result, rerender } = renderHook(
      ({ conversationId }: { conversationId: string | null }) =>
        useChatStream("ws-1", conversationId, []),
      { initialProps: { conversationId: "conv-3" } }
    );

    await vi.advanceTimersByTimeAsync(240_000);
    rerender({ conversationId: "conv-3" });
    expect(result.current.timedOut).toBe(true);

    result.current.submitMessage("Try again");
    rerender({ conversationId: "conv-3" });

    expect(result.current.timedOut).toBe(false);
  });
});
