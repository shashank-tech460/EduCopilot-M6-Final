import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import type { UIMessage } from "ai";

/**
 * Persistent chat history — Step 6. Tests useChatStream's OWN restoration
 * orchestration logic (which `id` it hands to useChat, when it calls
 * setMessages, and how often) with @ai-sdk/react's useChat mocked — the
 * same approach every other useChatStream test file in this project
 * already uses (tests/unit/useChatStream-offlineQueue.test.tsx). The AI
 * SDK's own internal id-based chat-instance-recreation mechanism (which
 * is what actually clears/isolates messages across a conversationId
 * change) was verified directly against the installed
 * node_modules/@ai-sdk/react source before relying on it — see
 * hooks/useChatStream.ts's own doc comment — and is a third-party
 * library's own responsibility to keep correct, not something this
 * project's test suite re-verifies.
 */

let capturedUseChatOptions: { id?: string } = {};
const setMessagesMock = vi.fn();

vi.mock("@ai-sdk/react", () => ({
  useChat: (options: { id?: string }) => {
    capturedUseChatOptions = options;
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

function restoredMessage(id: string, text: string): UIMessage {
  return { id, role: "assistant", parts: [{ type: "text", text }] } as UIMessage;
}

beforeEach(() => {
  vi.clearAllMocks();
  capturedUseChatOptions = {};
});

describe("useChatStream — conversation identity passed to useChat", () => {
  it("passes the real conversationId as useChat's id when one is active", () => {
    // Suffixed with "#<generation>" (stuck-stream watchdog, MVP polish
    // pass) -- still derived from and starting with the real
    // conversationId, just no longer identical to it.
    renderHook(() => useChatStream("ws-1", "conv-abc", []));
    expect(capturedUseChatOptions.id).toBe("conv-abc#0");
  });

  it("passes a sentinel id (not undefined) while no conversation is active yet — so a brief null window still isolates from the previous conversation", () => {
    renderHook(() => useChatStream("ws-1", null, undefined));
    expect(capturedUseChatOptions.id).toBeTruthy();
    expect(capturedUseChatOptions.id).not.toBe("conv-abc");
  });

  it("New Chat (conversationId -> null) uses a DIFFERENT id than the conversation that was just left", () => {
    const { result, rerender } = renderHook(
      ({ conversationId }: { conversationId: string | null }) => {
        useChatStream("ws-1", conversationId, []);
        return conversationId;
      },
      { initialProps: { conversationId: "conv-old" as string | null } }
    );
    const idWhileOnOldConversation = capturedUseChatOptions.id;
    expect(idWhileOnOldConversation).toBe("conv-old#0");

    rerender({ conversationId: null });

    expect(capturedUseChatOptions.id).not.toBe(idWhileOnOldConversation);
    void result;
  });
});

describe("useChatStream — seeding restored messages", () => {
  it("seeds initialMessages via setMessages once they arrive", () => {
    const restored = [restoredMessage("m1", "Earlier answer")];
    renderHook(() => useChatStream("ws-1", "conv-1", restored));

    expect(setMessagesMock).toHaveBeenCalledWith(restored);
  });

  it("does NOT call setMessages while initialMessages is still undefined (loading)", () => {
    renderHook(() => useChatStream("ws-1", "conv-1", undefined));

    expect(setMessagesMock).not.toHaveBeenCalled();
  });

  it("seeds with an empty array for a genuinely empty conversation (distinct from still-loading)", () => {
    renderHook(() => useChatStream("ws-1", "conv-1", []));

    expect(setMessagesMock).toHaveBeenCalledWith([]);
  });

  it("seeds only once per conversationId — a later re-render with the same conversationId does not re-seed", () => {
    const restored = [restoredMessage("m1", "Earlier answer")];
    const { rerender } = renderHook(
      ({ initialMessages }: { initialMessages: UIMessage[] | undefined }) => useChatStream("ws-1", "conv-1", initialMessages),
      { initialProps: { initialMessages: restored } }
    );
    expect(setMessagesMock).toHaveBeenCalledTimes(1);

    // Re-render with the SAME conversationId and a new array reference
    // (simulating a React Query refetch) — must not re-seed and wipe out
    // whatever the user may have since sent in this conversation.
    rerender({ initialMessages: [restoredMessage("m1", "Earlier answer")] });

    expect(setMessagesMock).toHaveBeenCalledTimes(1);
  });

  it("switching to a DIFFERENT conversationId re-seeds with that conversation's own messages — no mixing", () => {
    const conversationA = [restoredMessage("a1", "Message in conversation A")];
    const conversationB = [restoredMessage("b1", "Message in conversation B")];

    const { rerender } = renderHook(
      ({ conversationId, initialMessages }: { conversationId: string; initialMessages: UIMessage[] }) =>
        useChatStream("ws-1", conversationId, initialMessages),
      { initialProps: { conversationId: "conv-A", initialMessages: conversationA } }
    );
    expect(setMessagesMock).toHaveBeenNthCalledWith(1, conversationA);

    rerender({ conversationId: "conv-B", initialMessages: conversationB });

    expect(setMessagesMock).toHaveBeenNthCalledWith(2, conversationB);
    // Never called with conversation A's data mixed into B's seed.
    expect(setMessagesMock).not.toHaveBeenCalledWith([...conversationA, ...conversationB]);
  });
});
