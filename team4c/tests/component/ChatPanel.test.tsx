import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * Tests ChatPanel's rendering/interaction logic with @ai-sdk/react's
 * useChat mocked — no real network call, no real streaming. The actual
 * streaming behavior (real SSE bytes) is covered separately in
 * tests/unit/chat-api.test.ts, which exercises the real AI SDK streaming
 * primitives server-side. This file verifies the UI reacts correctly to
 * whatever useChat reports (empty state, streaming state, error+retry,
 * disabled submit) — the two together cover the full client+server path.
 */

const useChatMock = vi.fn();
const sendMessageMock = vi.fn();
const regenerateMock = vi.fn();
const clearErrorMock = vi.fn();

vi.mock("@ai-sdk/react", () => ({
  useChat: (...args: unknown[]) => useChatMock(...args),
}));

vi.mock("ai", () => ({
  DefaultChatTransport: vi.fn(),
}));

// MVP M5 correction: ChatPanel now also calls useActiveConversation
// (hooks/useActiveConversation.ts) directly, which performs a real
// fetch() to establish the active Conversation -- mocked here to a
// fixed, already-established id so this file's existing tests (which
// predate M5 and don't exercise conversation establishment itself,
// covered separately in tests/unit/useActiveConversation.test.tsx)
// don't depend on real network/async timing.
vi.mock("@/hooks/useActiveConversation", () => ({
  useActiveConversation: () => "conv-established-1",
}));

vi.mock("@/hooks/useSourceScope", () => ({
  useSourceScope: () => ({
    sources: [],
    readySources: [],
    isLoadingSources: false,
    selectedDocumentIds: null,
    updateScope: vi.fn(),
  }),
}));

// Step 6: ChatPanel now also calls useConversationMessages directly
// (a real useQuery call, which throws without a QueryClientProvider —
// none of these pre-existing tests provide one, and none of them are
// about restoration itself, which has its own dedicated test file).
// Defaults to "confirmed no history, not loading" so every existing test
// here keeps behaving exactly as it did before Step 6 — they all render
// ChatPanel as a fresh, empty conversation.
const useConversationMessagesMock = vi.fn();
vi.mock("@/hooks/useConversationMessages", () => ({
  useConversationMessages: (...args: unknown[]) => useConversationMessagesMock(...args),
}));

// Stage 6: useChatStream now also calls useQueryClient() (sidebar
// invalidation on message completion, covered separately in
// tests/unit/useChatStream-sidebarInvalidation.test.tsx) -- another real
// react-query hook that throws without a QueryClientProvider, same
// reasoning as the useConversationMessages mock above.
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

import { ChatPanel } from "@/components/chat/ChatPanel";

const setMessagesMock = vi.fn();

function baseChatState(overrides: Partial<ReturnType<typeof useChatMock>> = {}) {
  return {
    messages: [],
    sendMessage: sendMessageMock,
    status: "ready",
    error: undefined,
    regenerate: regenerateMock,
    clearError: clearErrorMock,
    setMessages: setMessagesMock,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useChatMock.mockReturnValue(baseChatState());
  useConversationMessagesMock.mockReturnValue({ initialMessages: [], isLoading: false, isError: false });

  // @tanstack/react-virtual measures the scroll container's real layout
  // size via `offsetWidth`/`offsetHeight` (confirmed by reading
  // node_modules/@tanstack/virtual-core/dist/esm/index.js's getRect()
  // directly, not assumed) to decide which rows are "visible." jsdom does
  // not compute real layout, so both report 0 by default and the
  // virtualizer correctly — per its own logic — renders zero rows. This
  // is the standard, documented way to test virtualized lists under
  // jsdom, not a workaround for a bug in the component.
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    value: 500,
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    value: 400,
  });
});

describe("ChatPanel", () => {
  it("shows the empty state when there are no messages", () => {
    render(<ChatPanel workspaceId="ws-1" />);
    expect(
      screen.getByText("Ask questions about your uploaded course material and learn faster.")
    ).toBeInTheDocument();
  });

  it("renders user and assistant messages with their text content", () => {
    useChatMock.mockReturnValue(
      baseChatState({
        messages: [
          { id: "m1", role: "user", parts: [{ type: "text", text: "What is normalization?" }] },
          {
            id: "m2",
            role: "assistant",
            parts: [{ type: "text", text: "Normalization reduces redundancy." }],
          },
        ],
      })
    );

    render(<ChatPanel workspaceId="ws-1" />);

    expect(screen.getByText("What is normalization?")).toBeInTheDocument();
    expect(screen.getByText("Normalization reduces redundancy.")).toBeInTheDocument();
  });

  it("submitting the form calls sendMessage with the typed text and clears the input", async () => {
    const user = userEvent.setup();
    render(<ChatPanel workspaceId="ws-1" />);

    const input = screen.getByLabelText("Chat message");
    await user.type(input, "What is normalization?");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(sendMessageMock).toHaveBeenCalledWith({ text: "What is normalization?" });
    expect(input).toHaveValue("");
  });

  it("does not submit an empty/whitespace-only message", async () => {
    const user = userEvent.setup();
    render(<ChatPanel workspaceId="ws-1" />);

    await user.type(screen.getByLabelText("Chat message"), "   ");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("shows a loading indicator and disables input/submit while streaming — Requirement 2.3", () => {
    useChatMock.mockReturnValue(baseChatState({ status: "streaming" }));

    render(<ChatPanel workspaceId="ws-1" />);

    expect(screen.getByText("Thinking…")).toBeInTheDocument();
    expect(screen.getByLabelText("Chat message")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it(
    "Stage 2 — shows a reassuring 'still working' message once a stream has been running a while, without hiding the original Thinking… indicator",
    async () => {
      vi.useFakeTimers();
      try {
        useChatMock.mockReturnValue(baseChatState({ status: "streaming" }));

        render(<ChatPanel workspaceId="ws-1" />);
        expect(screen.getByText("Thinking…")).toBeInTheDocument();
        expect(screen.queryByText(/still working/i)).not.toBeInTheDocument();

        await act(async () => {
          vi.advanceTimersByTime(15_000);
        });

        expect(screen.getByText("Thinking…")).toBeInTheDocument(); // still there, not replaced
        expect(screen.getByText(/still working/i)).toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    }
  );

  it("Stage 2 — never shows the 'still working' message before the threshold elapses", async () => {
    vi.useFakeTimers();
    try {
      useChatMock.mockReturnValue(baseChatState({ status: "streaming" }));

      render(<ChatPanel workspaceId="ws-1" />);

      await act(async () => {
        vi.advanceTimersByTime(14_000);
      });

      expect(screen.queryByText(/still working/i)).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("Stage 2 — clears the 'still working' message once streaming finishes, and a later stream starts its own fresh timer", async () => {
    vi.useFakeTimers();
    try {
      useChatMock.mockReturnValue(baseChatState({ status: "streaming" }));
      const { rerender } = render(<ChatPanel workspaceId="ws-1" />);

      await act(async () => {
        vi.advanceTimersByTime(15_000);
      });
      expect(screen.getByText(/still working/i)).toBeInTheDocument();

      useChatMock.mockReturnValue(baseChatState({ status: "ready" }));
      rerender(<ChatPanel workspaceId="ws-1" />);
      expect(screen.queryByText(/still working/i)).not.toBeInTheDocument();

      // A brand new stream must not inherit the previous one's elapsed
      // time -- confirms the timer genuinely resets per stream rather
      // than the flag simply never being cleared.
      useChatMock.mockReturnValue(baseChatState({ status: "streaming" }));
      rerender(<ChatPanel workspaceId="ws-1" />);
      expect(screen.queryByText(/still working/i)).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-enables input once streaming completes — Requirement 2.4", () => {
    useChatMock.mockReturnValue(baseChatState({ status: "ready" }));
    render(<ChatPanel workspaceId="ws-1" />);
    expect(screen.getByLabelText("Chat message")).not.toBeDisabled();
  });

  it("shows an inline error with a retry button on failure, and retry calls regenerate — Requirement 2.5", async () => {
    useChatMock.mockReturnValue(
      baseChatState({ error: new Error("Stream disconnected.") })
    );
    const user = userEvent.setup();

    render(<ChatPanel workspaceId="ws-1" />);

    expect(screen.getByText("Stream disconnected.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(clearErrorMock).toHaveBeenCalled();
    expect(regenerateMock).toHaveBeenCalled();
  });
});

/**
 * Requirement 2.6 — "scrollback through previous messages without
 * performance degradation for up to 500 messages," implemented via
 * virtualization (Accion Labs Implementation Plan Task 2.1: "Build
 * message list with virtual scrolling support for 500+ messages").
 *
 * These tests verify the actual behavior the requirement cares about —
 * correct order, bounded DOM footprint, scrollability, and that new/
 * streaming messages still work — not merely that "500 messages can be
 * placed in an array."
 */
describe("ChatPanel — Requirement 2.6 (500-message virtualization)", () => {
  function makeMessages(count: number) {
    return Array.from({ length: count }, (_, i) => ({
      id: `m${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      parts: [{ type: "text", text: `Message number ${i}` }],
    }));
  }

  it("renders a 500-message conversation with messages in correct chronological order", () => {
    useChatMock.mockReturnValue(baseChatState({ messages: makeMessages(500) }));

    render(<ChatPanel workspaceId="ws-1" />);

    // The virtualizer only mounts rows near the scroll position (top, by
    // default, before any scroll/streaming-triggered scrollToIndex runs),
    // so early messages are what should be present and in order.
    const rendered = screen.getAllByText(/^Message number \d+$/).map((el) => el.textContent);
    const indices = rendered.map((text) => Number(text?.replace("Message number ", "")));
    for (let i = 1; i < indices.length; i++) {
      expect(indices[i]).toBeGreaterThan(indices[i - 1]);
    }
  });

  it("does NOT mount a DOM node per message for a 500-message conversation — the actual virtualization mechanism", () => {
    useChatMock.mockReturnValue(baseChatState({ messages: makeMessages(500) }));

    render(<ChatPanel workspaceId="ws-1" />);

    // If this were unvirtualized, exactly 500 message nodes would be in
    // the DOM. The whole point of Task 2.1's "virtual scrolling" is that
    // far fewer are mounted at once, regardless of total message count —
    // this is the mechanism that actually prevents performance
    // degradation, not an incidental test detail.
    const rendered = screen.getAllByText(/^Message number \d+$/);
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThan(100);
  });

  it("keeps the message list container scrollable with a 500-message conversation", () => {
    useChatMock.mockReturnValue(baseChatState({ messages: makeMessages(500) }));

    const { container } = render(<ChatPanel workspaceId="ws-1" />);

    const scrollContainer = container.querySelector(".overflow-y-auto");
    expect(scrollContainer).toBeInTheDocument();
    // The virtualizer's total-size element reflects all 500 messages'
    // estimated/measured height, not just the mounted subset — this is
    // what makes the scrollbar reflect the true conversation length.
    const sizedElement = scrollContainer?.querySelector("ul");
    const totalHeight = Number(sizedElement?.getAttribute("style")?.match(/height: (\d+)/)?.[1]);
    expect(totalHeight).toBeGreaterThan(500 * 40); // well over a single screen's worth
  });

  it("still shows a newly appended message correctly in a long conversation", () => {
    const messages501 = [...makeMessages(500), {
      id: "m500",
      role: "user",
      parts: [{ type: "text", text: "The newest message" }],
    }];
    useChatMock.mockReturnValue(baseChatState({ messages: messages501 }));

    const { container } = render(<ChatPanel workspaceId="ws-1" />);

    // jsdom does not fire native "scroll" events from a programmatic
    // scrollTop/scrollTo() write (a documented jsdom limitation, not a
    // bug in the virtualizer or this component) — @tanstack/react-virtual
    // tracks scroll position via exactly that native event
    // (confirmed by reading virtual-core's observeElementOffset directly),
    // so the auto-scroll-to-newest effect's real effect has to be
    // simulated manually here the same way a real scroll would trigger it.
    const scrollContainer = container.querySelector(".overflow-y-auto") as HTMLElement;
    scrollContainer.scrollTop = 999999;
    act(() => {
      scrollContainer.dispatchEvent(new Event("scroll"));
    });

    expect(screen.getByText("The newest message")).toBeInTheDocument();
  });

  it("still renders incremental streaming token updates correctly within a long conversation", () => {
    const streamingMessages = [
      ...makeMessages(500),
      { id: "m500", role: "assistant", parts: [{ type: "text", text: "Partial resp" }] },
    ];
    const { container, rerender } = render(<ChatPanel workspaceId="ws-1" />);
    useChatMock.mockReturnValue(baseChatState({ messages: streamingMessages, status: "streaming" }));
    rerender(<ChatPanel workspaceId="ws-1" />);

    const scrollContainer = container.querySelector(".overflow-y-auto") as HTMLElement;
    scrollContainer.scrollTop = 999999;
    act(() => {
      scrollContainer.dispatchEvent(new Event("scroll"));
    });

    expect(screen.getByText("Partial resp")).toBeInTheDocument();

    // Simulate the next streamed token arriving — same message id, more text.
    const updatedMessages = [
      ...makeMessages(500),
      { id: "m500", role: "assistant", parts: [{ type: "text", text: "Partial response now longer" }] },
    ];
    useChatMock.mockReturnValue(baseChatState({ messages: updatedMessages, status: "streaming" }));
    rerender(<ChatPanel workspaceId="ws-1" />);
    act(() => {
      scrollContainer.dispatchEvent(new Event("scroll"));
    });

    expect(screen.getByText("Partial response now longer")).toBeInTheDocument();
    expect(screen.queryByText("Partial resp")).not.toBeInTheDocument();
  });

  it("still works correctly for a normal short conversation (not just the 500-message case)", () => {
    useChatMock.mockReturnValue(baseChatState({ messages: makeMessages(3) }));

    render(<ChatPanel workspaceId="ws-1" />);

    expect(screen.getByText("Message number 0")).toBeInTheDocument();
    expect(screen.getByText("Message number 1")).toBeInTheDocument();
    expect(screen.getByText("Message number 2")).toBeInTheDocument();
  });
});

describe("ChatPanel — Source Attribution rendering (Requirement 3.1)", () => {
  it("renders multiple citations alongside an assistant message without altering the message text", () => {
    useChatMock.mockReturnValue(
      baseChatState({
        messages: [
          {
            id: "m1",
            role: "assistant",
            parts: [
              { type: "text", text: "Normalization reduces redundancy." },
              {
                type: "data-citations",
                data: [
                  {
                    type: "video_timestamp",
                    sourceFile: "Lecture12.mp4",
                    fileId: "file-1",
                    location: 155,
                    label: "Lecture12.mp4 at 155s",
                  },
                  {
                    type: "pdf_page",
                    sourceFile: "Notes.pdf",
                    fileId: "file-2",
                    location: 12,
                    label: "Notes.pdf, page 12",
                    fileUrl: "https://example.test/notes.pdf",
                  },
                ],
              },
            ],
          },
        ],
      })
    );

    render(<ChatPanel workspaceId="ws-1" />);

    // Normal message text renders exactly as before.
    expect(screen.getByText("Normalization reduces redundancy.")).toBeInTheDocument();
    // Both citations render as separate clickable elements.
    expect(screen.getByRole("button", { name: /Lecture12\.mp4/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Notes\.pdf/ })).toBeInTheDocument();
  });

  it("renders a message with no citations exactly as before (no empty attribution row)", () => {
    useChatMock.mockReturnValue(
      baseChatState({
        messages: [
          { id: "m1", role: "assistant", parts: [{ type: "text", text: "Plain answer, no sources." }] },
        ],
      })
    );

    render(<ChatPanel workspaceId="ws-1" />);

    expect(screen.getByText("Plain answer, no sources.")).toBeInTheDocument();
    expect(screen.queryAllByRole("button", { name: /\.mp4|\.pdf/ })).toHaveLength(0);
  });
});

describe("ChatPanel — Requirement 8.1 (visible queued-message notification)", () => {
  it("shows a queued notification when the offline queue has a message, and none when it's empty", async () => {
    const { useAppStore } = await import("@/store/appStore");
    useAppStore.getState().clearOfflineQueue();
    useAppStore.getState().enqueueOfflineMessage({
      id: "q1",
      text: "queued question",
      workspaceId: "ws-1",
      conversationId: "conv-1",
      videoTimestamp: null,
      queuedAt: new Date(),
    });

    render(<ChatPanel workspaceId="ws-1" />);

    expect(
      screen.getByText("Message queued — it will send when you're back online.")
    ).toBeInTheDocument();

    act(() => {
      useAppStore.getState().clearOfflineQueue();
    });
  });

  it("does not show a queued notification when the offline queue is empty", async () => {
    const { useAppStore } = await import("@/store/appStore");
    useAppStore.getState().clearOfflineQueue();

    render(<ChatPanel workspaceId="ws-1" />);

    expect(screen.queryByText(/queued/i)).not.toBeInTheDocument();
  });
});

describe("ChatPanel — restoring a selected conversation (Step 6)", () => {
  it("shows a loading state, not the empty-conversation prompt, while a conversation's history is still loading", () => {
    useConversationMessagesMock.mockReturnValue({ initialMessages: undefined, isLoading: true, isError: false });
    useChatMock.mockReturnValue(baseChatState({ messages: [] }));

    render(<ChatPanel workspaceId="ws-1" />);

    expect(screen.getByText("Loading conversation…")).toBeInTheDocument();
    expect(screen.queryByText("Ask your AI tutor")).not.toBeInTheDocument();
  });

  it("shows the real empty-conversation prompt once loading finishes and there is genuinely no history", () => {
    useConversationMessagesMock.mockReturnValue({ initialMessages: [], isLoading: false, isError: false });
    useChatMock.mockReturnValue(baseChatState({ messages: [] }));

    render(<ChatPanel workspaceId="ws-1" />);

    expect(screen.queryByText("Loading conversation…")).not.toBeInTheDocument();
    expect(screen.getByText("Ask your AI tutor")).toBeInTheDocument();
  });

  it("does not show a loading state once restored messages are already present (messages.length > 0 takes precedence)", () => {
    useConversationMessagesMock.mockReturnValue({ initialMessages: undefined, isLoading: false, isError: false });
    useChatMock.mockReturnValue(
      baseChatState({
        messages: [{ id: "m1", role: "assistant", parts: [{ type: "text", text: "Restored answer" }] }],
      })
    );

    render(<ChatPanel workspaceId="ws-1" />);

    expect(screen.getByText("Restored answer")).toBeInTheDocument();
    expect(screen.queryByText("Loading conversation…")).not.toBeInTheDocument();
  });
});
