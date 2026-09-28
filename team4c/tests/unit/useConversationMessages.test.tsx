import { describe, expect, it, vi, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

/**
 * Persistent chat history — Step 6. Real React Query (matching
 * tests/unit/useWorkspaceInit.test.tsx's convention), mocked global
 * fetch — no live network. Verifies the client-side contract this hook
 * promises callers: the workspace-scoped request shape, the
 * undefined-vs-empty-array distinction, error surfacing (without
 * throwing into the render tree), and the restored-message ->
 * UIMessage/citation shape.
 *
 * Server-side ownership/isolation enforcement itself is already covered
 * by tests/unit/conversation-messages-route.test.ts (Step 4) — this file
 * does not re-test that; it only verifies this hook correctly surfaces
 * whatever the server responds (including a 404 for an unauthorized/
 * cross-workspace conversation) as `isError`, never as a crash.
 */

import { useConversationMessages } from "@/hooks/useConversationMessages";

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function mockFetch(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: status >= 200 && status < 300, status, json: async () => body })
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("useConversationMessages", () => {
  it("does not fetch while conversationId is null (still being established)", () => {
    mockFetch(200, { conversationId: "c1", messages: [] });

    renderHook(() => useConversationMessages("ws-1", null), { wrapper });

    expect(fetch).not.toHaveBeenCalled();
  });

  it("requests the correct workspace-scoped, conversation-scoped endpoint", async () => {
    mockFetch(200, { conversationId: "c1", messages: [] });

    renderHook(() => useConversationMessages("ws-1", "c1"), { wrapper });

    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/conversations/c1/messages?workspaceId=ws-1"));
  });

  it("initialMessages is undefined while loading, then the real array once resolved", async () => {
    mockFetch(200, {
      conversationId: "c1",
      messages: [{ id: "m1", role: "user", content: "Hi", createdAt: "2026-01-01T00:00:00.000Z" }],
    });

    const { result } = renderHook(() => useConversationMessages("ws-1", "c1"), { wrapper });

    expect(result.current.initialMessages).toBeUndefined();

    await waitFor(() => expect(result.current.initialMessages).toBeDefined());
    expect(result.current.initialMessages).toHaveLength(1);
  });

  it("converts a restored message into the UIMessage shape ChatPanel already renders", async () => {
    mockFetch(200, {
      conversationId: "c1",
      messages: [
        {
          id: "m1",
          role: "assistant",
          content: "Deadlocks happen on page 12.",
          createdAt: "2026-01-01T00:00:00.000Z",
          citations: [
            { type: "pdf_page", sourceFile: "os-notes.pdf", fileId: "f1", location: 12, label: "os-notes.pdf, page 12", fileUrl: "https://x/os-notes.pdf", disabled: false },
          ],
        },
      ],
    });

    const { result } = renderHook(() => useConversationMessages("ws-1", "c1"), { wrapper });
    await waitFor(() => expect(result.current.initialMessages).toBeDefined());

    const [message] = result.current.initialMessages!;
    expect(message.id).toBe("m1");
    expect(message.role).toBe("assistant");
    const textPart = message.parts.find((part) => part.type === "text");
    expect(textPart).toMatchObject({ type: "text", text: "Deadlocks happen on page 12." });
    const citationsPart = message.parts.find((part) => part.type === "data-citations");
    expect(citationsPart).toMatchObject({ type: "data-citations", data: [{ fileId: "f1", disabled: false }] });
  });

  it("a message with no citations produces no data-citations part (matching live-chat rendering exactly)", async () => {
    mockFetch(200, {
      conversationId: "c1",
      messages: [{ id: "m1", role: "user", content: "Hello", createdAt: "2026-01-01T00:00:00.000Z" }],
    });

    const { result } = renderHook(() => useConversationMessages("ws-1", "c1"), { wrapper });
    await waitFor(() => expect(result.current.initialMessages).toBeDefined());

    const [message] = result.current.initialMessages!;
    expect(message.parts.find((part) => part.type === "data-citations")).toBeUndefined();
  });

  it("surfaces a failed/unauthorized request as isError, without throwing", async () => {
    mockFetch(404, { error: "Not found." });

    const { result } = renderHook(() => useConversationMessages("ws-1", "c1"), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    // No history is available to seed — undefined, not a crash, not [].
    expect(result.current.initialMessages).toBeUndefined();
  });
});
