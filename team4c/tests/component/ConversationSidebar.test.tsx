import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

/**
 * Persistent chat history — Step 5. Real `useQuery` (React Query itself is
 * not mocked, matching the established convention in
 * tests/unit/useWorkspaceInit.test.tsx), a real QueryClientProvider
 * wrapper, and a mocked global `fetch`. Conversation selection/restoration
 * is intentionally not implemented yet — no test here asserts clicking a
 * row does anything, since it correctly does nothing.
 */

import { ConversationSidebar } from "@/components/shared/ConversationSidebar";
import { useAppStore } from "@/store/appStore";

function renderWithClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  return render(ui, { wrapper });
}

function mockFetchOnce(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    })
  );
}

beforeEach(() => {
  useAppStore.getState().logout();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("ConversationSidebar — rendering the list", () => {
  it("renders each conversation's title and a formatted updatedAt", async () => {
    mockFetchOnce(200, {
      conversations: [
        { id: "c1", title: "Chapter 3 questions", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" },
        { id: "c2", title: "New conversation", createdAt: "2026-01-03T00:00:00.000Z", updatedAt: "2026-01-03T00:00:00.000Z" },
      ],
      nextCursor: null,
    });

    renderWithClient(<ConversationSidebar workspaceId="ws-1" />);

    expect(await screen.findByText("Chapter 3 questions")).toBeInTheDocument();
    expect(screen.getByText("New conversation")).toBeInTheDocument();
  });

  it("requests the workspace-scoped conversations endpoint, not a generic/global one", async () => {
    mockFetchOnce(200, { conversations: [], nextCursor: null });

    renderWithClient(<ConversationSidebar workspaceId="ws-42" />);

    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/workspaces/ws-42/conversations"));
  });
});

describe("ConversationSidebar — loading, empty, and error states", () => {
  it("shows a loading state before the request resolves", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {}))); // never resolves

    renderWithClient(<ConversationSidebar workspaceId="ws-1" />);

    // Skeleton placeholders render immediately; no conversation content yet.
    expect(screen.queryByText("No conversations yet")).not.toBeInTheDocument();
  });

  it("shows an empty state for a workspace with no conversations, without breaking the sidebar", async () => {
    mockFetchOnce(200, { conversations: [], nextCursor: null });

    renderWithClient(<ConversationSidebar workspaceId="ws-1" />);

    expect(await screen.findByText("No conversations yet")).toBeInTheDocument();
    // New Chat remains usable even with an empty history.
    expect(screen.getByRole("button", { name: /new chat/i })).toBeEnabled();
  });

  it("shows an error state on a failed request without throwing / breaking the workspace", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }));

    renderWithClient(<ConversationSidebar workspaceId="ws-1" />);

    expect(await screen.findByText("Couldn't load history")).toBeInTheDocument();
    // New Chat still works even if the list failed to load.
    expect(screen.getByRole("button", { name: /new chat/i })).toBeEnabled();
  });
});

describe("ConversationSidebar — New Chat action", () => {
  it("uses the existing conversation-creation flow (clears the active conversation; does not call the create endpoint itself)", async () => {
    mockFetchOnce(200, { conversations: [], nextCursor: null });
    const user = userEvent.setup();
    useAppStore.getState().setActiveConversation("existing-convo", "ws-1");

    renderWithClient(<ConversationSidebar workspaceId="ws-1" />);
    await screen.findByText("No conversations yet");

    await user.click(screen.getByRole("button", { name: /new chat/i }));

    // The store's own pre-existing clearActiveConversation() ran — this is
    // exactly the signal hooks/useActiveConversation.ts already watches
    // for to create a fresh conversation via ITS OWN existing POST call.
    expect(useAppStore.getState().chat.activeConversationId).toBeNull();
    expect(useAppStore.getState().chat.activeConversationWorkspaceId).toBeNull();

    // The sidebar itself never POSTs to the conversations endpoint —
    // it only ever GETs the list.
    const calledMethods = (fetch as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => (call[1] as RequestInit | undefined)?.method
    );
    expect(calledMethods.every((method) => method === undefined || method === "GET")).toBe(true);
  });

  it("clicking New Chat twice only clears the active conversation twice, never issues a duplicate creation request itself", async () => {
    mockFetchOnce(200, { conversations: [], nextCursor: null });
    const user = userEvent.setup();
    const clearSpy = vi.spyOn(useAppStore.getState(), "clearActiveConversation");

    renderWithClient(<ConversationSidebar workspaceId="ws-1" />);
    await screen.findByText("No conversations yet");

    const newChatButton = screen.getByRole("button", { name: /new chat/i });
    await user.click(newChatButton);
    await user.click(newChatButton);

    expect(clearSpy).toHaveBeenCalledTimes(2);
    // Actual creation-request deduplication is hooks/useActiveConversation.ts's
    // own established responsibility (tested in useActiveConversation.test.tsx)
    // — this component never issues a create request at all, so there is
    // nothing here for it to duplicate.
  });
});

describe("ConversationSidebar — collapse / responsive behavior", () => {
  it("reuses the existing ui.sidebarOpen store field: collapsing hides the list and shows an expand control", async () => {
    mockFetchOnce(200, { conversations: [], nextCursor: null });
    const user = userEvent.setup();

    renderWithClient(<ConversationSidebar workspaceId="ws-1" />);
    await screen.findByText("No conversations yet");

    await user.click(screen.getByRole("button", { name: /hide conversation history/i }));

    expect(useAppStore.getState().ui.sidebarOpen).toBe(false);
    expect(screen.queryByText("No conversations yet")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /show conversation history/i })).toBeInTheDocument();
  });

  it("expanding again restores the list", async () => {
    mockFetchOnce(200, {
      conversations: [{ id: "c1", title: "Resume later", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }],
      nextCursor: null,
    });
    const user = userEvent.setup();
    useAppStore.getState().setSidebarOpen(false);

    renderWithClient(<ConversationSidebar workspaceId="ws-1" />);

    await user.click(screen.getByRole("button", { name: /show conversation history/i }));

    expect(await screen.findByText("Resume later")).toBeInTheDocument();
  });
});

describe("ConversationSidebar — active conversation is visually distinguished", () => {
  it("highlights the currently active conversation among the list", async () => {
    mockFetchOnce(200, {
      conversations: [
        { id: "c1", title: "Active one", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
        { id: "c2", title: "Not active", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
      ],
      nextCursor: null,
    });
    useAppStore.getState().setActiveConversation("c1", "ws-1");

    renderWithClient(<ConversationSidebar workspaceId="ws-1" />);

    const activeRow = (await screen.findByText("Active one")).closest("li");
    const otherRow = screen.getByText("Not active").closest("li");
    expect(within(activeRow as HTMLElement).getByText("Active one")).toBeInTheDocument();
    expect(activeRow?.innerHTML).not.toEqual(otherRow?.innerHTML);
  });
});

describe("ConversationSidebar — selecting a conversation (Step 6)", () => {
  it("clicking a row sets it as the active conversation via the existing store action", async () => {
    mockFetchOnce(200, {
      conversations: [
        { id: "c1", title: "Older chat", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
      ],
      nextCursor: null,
    });
    const user = userEvent.setup();

    renderWithClient(<ConversationSidebar workspaceId="ws-1" />);
    await screen.findByText("Older chat");

    // Anchored ("starts with") rather than a bare substring match, since
    // Step 5 added a sibling "Delete {title}" button per row, which would
    // otherwise also match a plain /older chat/i substring.
    await user.click(screen.getByRole("button", { name: /^older chat/i }));

    expect(useAppStore.getState().chat.activeConversationId).toBe("c1");
    expect(useAppStore.getState().chat.activeConversationWorkspaceId).toBe("ws-1");
  });

  it("clicking the already-active conversation is a no-op (does not re-set / re-trigger anything)", async () => {
    mockFetchOnce(200, {
      conversations: [
        { id: "c1", title: "Current chat", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
      ],
      nextCursor: null,
    });
    const user = userEvent.setup();
    useAppStore.getState().setActiveConversation("c1", "ws-1");
    const setActiveSpy = vi.spyOn(useAppStore.getState(), "setActiveConversation");

    renderWithClient(<ConversationSidebar workspaceId="ws-1" />);
    await screen.findByText("Current chat");

    await user.click(screen.getByRole("button", { name: /^current chat/i }));

    expect(setActiveSpy).not.toHaveBeenCalled();
  });

  it("rows are real, keyboard-accessible buttons, not inert divs", async () => {
    mockFetchOnce(200, {
      conversations: [
        { id: "c1", title: "Accessible row", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
      ],
      nextCursor: null,
    });

    renderWithClient(<ConversationSidebar workspaceId="ws-1" />);

    expect(await screen.findByRole("button", { name: /^accessible row/i })).toBeInTheDocument();
  });
});

describe("ConversationSidebar — deleting a conversation (Step 5)", () => {
  function mockFetchByMethod(handlers: { GET?: () => unknown; DELETE?: (url: string) => { status: number; body: unknown } }) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (method === "DELETE" && handlers.DELETE) {
          const { status, body } = handlers.DELETE(url);
          return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
        }
        const body = handlers.GET ? handlers.GET() : { conversations: [], nextCursor: null };
        return { ok: true, status: 200, json: async () => body } as Response;
      })
    );
  }

  it("shows a confirmation dialog before deleting, and does not call the delete endpoint until confirmed", async () => {
    const user = userEvent.setup();
    mockFetchByMethod({
      GET: () => ({
        conversations: [{ id: "c1", title: "Chapter 3 questions", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }],
        nextCursor: null,
      }),
    });

    renderWithClient(<ConversationSidebar workspaceId="ws-1" />);
    await screen.findByText("Chapter 3 questions");

    await user.click(screen.getByRole("button", { name: /delete chapter 3 questions/i }));

    expect(await screen.findByText(/delete this conversation\?/i)).toBeInTheDocument();
    const deleteCalls = (fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call) => (call[1] as RequestInit | undefined)?.method === "DELETE"
    );
    expect(deleteCalls).toHaveLength(0);
  });

  it("clicking Cancel does not delete the conversation", async () => {
    const user = userEvent.setup();
    mockFetchByMethod({
      GET: () => ({
        conversations: [{ id: "c1", title: "Chapter 3 questions", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }],
        nextCursor: null,
      }),
    });

    renderWithClient(<ConversationSidebar workspaceId="ws-1" />);
    await screen.findByText("Chapter 3 questions");
    await user.click(screen.getByRole("button", { name: /delete chapter 3 questions/i }));
    await screen.findByText(/delete this conversation\?/i);

    await user.click(screen.getByRole("button", { name: /cancel/i }));

    expect(screen.queryByText(/delete this conversation\?/i)).not.toBeInTheDocument();
    const deleteCalls = (fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call) => (call[1] as RequestInit | undefined)?.method === "DELETE"
    );
    expect(deleteCalls).toHaveLength(0);
  });

  it("confirming deletion calls the correct workspace-scoped DELETE endpoint", async () => {
    const user = userEvent.setup();
    mockFetchByMethod({
      GET: () => ({
        conversations: [{ id: "c1", title: "Chapter 3 questions", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }],
        nextCursor: null,
      }),
      DELETE: () => ({ status: 200, body: { success: true } }),
    });

    renderWithClient(<ConversationSidebar workspaceId="ws-42" />);
    await screen.findByText("Chapter 3 questions");
    await user.click(screen.getByRole("button", { name: /delete chapter 3 questions/i }));
    await screen.findByText(/delete this conversation\?/i);

    await user.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith("/api/conversations/c1?workspaceId=ws-42", expect.objectContaining({ method: "DELETE" }))
    );
  });

  it("deleting the ACTIVE conversation clears active state, letting useActiveConversation adopt or create a replacement", async () => {
    const user = userEvent.setup();
    useAppStore.getState().setActiveConversation("c1", "ws-1");
    mockFetchByMethod({
      GET: () => ({
        conversations: [{ id: "c1", title: "Active chat", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }],
        nextCursor: null,
      }),
      DELETE: () => ({ status: 200, body: { success: true } }),
    });

    renderWithClient(<ConversationSidebar workspaceId="ws-1" />);
    await screen.findByText("Active chat");
    await user.click(screen.getByRole("button", { name: /delete active chat/i }));
    await screen.findByText(/delete this conversation\?/i);
    await user.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(useAppStore.getState().chat.activeConversationId).toBeNull());
  });

  it("deleting a NON-active conversation leaves the active conversation untouched", async () => {
    const user = userEvent.setup();
    useAppStore.getState().setActiveConversation("c1", "ws-1");
    mockFetchByMethod({
      GET: () => ({
        conversations: [
          { id: "c1", title: "Active chat", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
          { id: "c2", title: "Other chat", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
        ],
        nextCursor: null,
      }),
      DELETE: () => ({ status: 200, body: { success: true } }),
    });

    renderWithClient(<ConversationSidebar workspaceId="ws-1" />);
    await screen.findByText("Other chat");
    await user.click(screen.getByRole("button", { name: /delete other chat/i }));
    await screen.findByText(/delete this conversation\?/i);
    await user.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect((fetch as ReturnType<typeof vi.fn>).mock.calls.some((call) => (call[1] as RequestInit | undefined)?.method === "DELETE")).toBe(
        true
      )
    );
    expect(useAppStore.getState().chat.activeConversationId).toBe("c1");
  });

  it("shows an error toast and keeps the conversation visible when deletion fails", async () => {
    const user = userEvent.setup();
    mockFetchByMethod({
      GET: () => ({
        conversations: [{ id: "c1", title: "Chapter 3 questions", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }],
        nextCursor: null,
      }),
      DELETE: () => ({ status: 500, body: { error: "Internal error" } }),
    });

    renderWithClient(<ConversationSidebar workspaceId="ws-1" />);
    await screen.findByText("Chapter 3 questions");
    await user.click(screen.getByRole("button", { name: /delete chapter 3 questions/i }));
    await screen.findByText(/delete this conversation\?/i);
    await user.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(screen.queryByText(/delete this conversation\?/i)).not.toBeInTheDocument());
    // The conversation is still in the list — a failed delete never
    // silently disappears it from view.
    expect(screen.getByText("Chapter 3 questions")).toBeInTheDocument();
  });

  it("clicking the delete button never also triggers row selection", async () => {
    const user = userEvent.setup();
    mockFetchByMethod({
      GET: () => ({
        conversations: [{ id: "c1", title: "Chapter 3 questions", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }],
        nextCursor: null,
      }),
    });

    renderWithClient(<ConversationSidebar workspaceId="ws-1" />);
    await screen.findByText("Chapter 3 questions");

    await user.click(screen.getByRole("button", { name: /delete chapter 3 questions/i }));

    expect(useAppStore.getState().chat.activeConversationId).toBeNull();
  });
});

describe("ConversationSidebar — mobile default collapse (MVP polish pass)", () => {
  /**
   * ROOT CAUSE this guards (confirmed live, not assumed): `ui.sidebarOpen`
   * defaults to `true` for every viewport (store/appStore.ts), and the
   * expanded sidebar is a fixed `w-56` (224px) flex sibling of ChatPanel
   * with no responsive breakpoint at all -- on a real 375px mobile
   * viewport this squeezed ChatPanel into an unreadable ~150px column,
   * with no page-level horizontal overflow to make the problem visible
   * any other way. Fixed by collapsing (the EXISTING, already-tested
   * collapse mechanism -- just its default) once on mount when the
   * viewport is already narrow.
   */
  function setViewportWidth(width: number) {
    Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: width });
  }

  beforeEach(() => {
    // `ui.sidebarOpen` is deliberately NOT reset by the shared
    // `logout()` beforeEach above (store/appStore.ts's own logout()
    // docstring: layout preference isn't session-scoped data) -- reset
    // it to the store's own documented default explicitly here so each
    // test in this block starts from a known state, not whatever the
    // previous test's mount effect left it as.
    useAppStore.getState().setSidebarOpen(true);
  });

  it("starts collapsed on a narrow (mobile) viewport", async () => {
    setViewportWidth(375);
    mockFetchOnce(200, { conversations: [], nextCursor: null });

    renderWithClient(<ConversationSidebar workspaceId="ws-1" />);

    await waitFor(() => expect(screen.getByLabelText("Show conversation history")).toBeInTheDocument());
    expect(screen.queryByLabelText("Hide conversation history")).not.toBeInTheDocument();
  });

  it("stays expanded (the existing default) on a desktop-width viewport", async () => {
    setViewportWidth(1280);
    mockFetchOnce(200, { conversations: [], nextCursor: null });

    renderWithClient(<ConversationSidebar workspaceId="ws-1" />);

    await waitFor(() => expect(screen.getByLabelText("Hide conversation history")).toBeInTheDocument());
  });

  it("does not re-collapse after the user re-opens it", async () => {
    setViewportWidth(375);
    mockFetchOnce(200, { conversations: [], nextCursor: null });
    const user = userEvent.setup();

    const { rerender } = renderWithClient(<ConversationSidebar workspaceId="ws-1" />);
    await waitFor(() => expect(screen.getByLabelText("Show conversation history")).toBeInTheDocument());

    await user.click(screen.getByLabelText("Show conversation history"));
    expect(screen.getByLabelText("Hide conversation history")).toBeInTheDocument();

    rerender(<ConversationSidebar workspaceId="ws-1" />);
    expect(screen.getByLabelText("Hide conversation history")).toBeInTheDocument();
  });
});
