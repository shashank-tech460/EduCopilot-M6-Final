import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";

/**
 * Stage 6 — sidebar refresh half of "conversation titles + sidebar
 * invalidation". Verifies useChatStream's own onFinish invalidates the
 * SAME React Query key (`["conversations", workspaceId]`) that
 * components/shared/ConversationSidebar.tsx already uses for its list
 * query and its own delete-flow invalidation — reusing that established
 * pattern, not introducing a second one.
 *
 * `@tanstack/react-query`'s useQueryClient is mocked directly (same
 * approach this project already uses for @ai-sdk/react/ai in
 * useChatStream-offlineQueue.test.tsx / useChatStream-restoration.test.tsx)
 * so this test needs no real QueryClientProvider tree and exercises only
 * useChatStream's own call, not React Query's internals.
 */

let capturedOptions: {
  onFinish?: (arg: { message: { id: string; role: string; parts: unknown[] } }) => void;
} = {};
const setMessagesMock = vi.fn();
const invalidateQueriesMock = vi.fn();

vi.mock("@ai-sdk/react", () => ({
  useChat: (options: typeof capturedOptions) => {
    capturedOptions = options;
    return {
      messages: [],
      sendMessage: vi.fn(),
      status: "ready",
      error: undefined,
      regenerate: vi.fn(),
      clearError: vi.fn(),
      setMessages: setMessagesMock,
    };
  },
}));

vi.mock("ai", () => ({
  DefaultChatTransport: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: invalidateQueriesMock }),
}));

import { useChatStream } from "@/hooks/useChatStream";

beforeEach(() => {
  vi.clearAllMocks();
  capturedOptions = {};
});

afterEach(() => {
  cleanup();
});

describe("useChatStream — Stage 6: sidebar invalidation on message completion", () => {
  it("invalidates the [\"conversations\", workspaceId] query when a message finishes streaming", () => {
    const { unmount } = renderHook(() => useChatStream("ws-1", "conv-1", []));

    act(() => {
      capturedOptions.onFinish?.({ message: { id: "m1", role: "assistant", parts: [] } });
    });

    expect(invalidateQueriesMock).toHaveBeenCalledWith({ queryKey: ["conversations", "ws-1"] });
    unmount();
  });

  it("uses the actual active workspaceId, not a hardcoded one", () => {
    const { unmount } = renderHook(() => useChatStream("a-completely-different-workspace", "conv-1", []));

    act(() => {
      capturedOptions.onFinish?.({ message: { id: "m1", role: "assistant", parts: [] } });
    });

    expect(invalidateQueriesMock).toHaveBeenCalledWith({
      queryKey: ["conversations", "a-completely-different-workspace"],
    });
    unmount();
  });

  it("does not invalidate the sidebar query before a message has finished (no premature refresh)", () => {
    const { unmount } = renderHook(() => useChatStream("ws-1", "conv-1", []));

    expect(invalidateQueriesMock).not.toHaveBeenCalled();
    unmount();
  });
});
