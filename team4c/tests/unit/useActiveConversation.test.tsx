import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

import { useActiveConversation } from "@/hooks/useActiveConversation";
import { useAppStore } from "@/store/appStore";

/**
 * MVP M5 correction — `useActiveConversation` is the ONLY client-side
 * code that establishes a Conversation for the Chat UI to use. It never
 * generates an id itself; it always calls the real, existing
 * `POST /api/workspaces/[id]/conversations` route (mocked here at the
 * `fetch` layer, matching this file's own scope: proving the HOOK's
 * request/reuse/stability logic, not re-testing the route itself, which
 * has its own dedicated test file).
 *
 * STEP 4 REMEDIATION: the hook now checks the existing conversation list
 * FIRST (`GET .../conversations?limit=1`) before ever POSTing a new one,
 * and re-checks the store's current active-conversation state
 * immediately before committing its own result (never a stale, captured-
 * at-effect-start value) — the `fetch` mock below is method-aware to
 * exercise both steps; the default (empty list) preserves every
 * pre-existing test's original "always creates a fresh conversation"
 * behavior.
 */

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response;
}

function resetChatState() {
  useAppStore.setState((state) => ({
    chat: { ...state.chat, activeConversationId: null, activeConversationWorkspaceId: null },
  }));
}

/** Default fetch mock: GET always reports no existing conversations (so
 * every pre-existing test's "always creates new" assumption holds
 * unchanged), POST always creates `conv-for-<workspaceId>`. */
function defaultFetchMock() {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const match = /\/api\/workspaces\/([^/]+)\/conversations/.exec(url);
    const workspaceId = match?.[1] ?? "unknown";
    const method = init?.method ?? "GET";
    if (method === "GET") {
      return jsonResponse({ conversations: [] });
    }
    return jsonResponse({ id: `conv-for-${workspaceId}`, workspaceId, title: "New conversation" });
  });
}

beforeEach(() => {
  resetChatState();
  vi.stubGlobal("fetch", defaultFetchMock());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useActiveConversation", () => {
  it("A/1: establishes a real conversation via the server-side creation API — never invents one client-side", async () => {
    const { result } = renderHook(() => useActiveConversation("ws-1"));

    await waitFor(() => expect(result.current).not.toBeNull());

    expect(result.current).toBe("conv-for-ws-1");
    expect(fetch).toHaveBeenCalledWith(
      "/api/workspaces/ws-1/conversations",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("8/10: the established conversation remains stable across re-renders of the same workspace", async () => {
    const { result, rerender } = renderHook(({ workspaceId }) => useActiveConversation(workspaceId), {
      initialProps: { workspaceId: "ws-1" },
    });

    await waitFor(() => expect(result.current).not.toBeNull());
    const first = result.current;

    rerender({ workspaceId: "ws-1" });
    rerender({ workspaceId: "ws-1" });

    expect(result.current).toBe(first);
    // Only ONE creation cycle total (GET-check + POST-create) --
    // re-renders never re-trigger it.
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("9/F: switching workspaces establishes a DIFFERENT conversation", async () => {
    const { result, rerender } = renderHook(({ workspaceId }) => useActiveConversation(workspaceId), {
      initialProps: { workspaceId: "ws-1" },
    });
    await waitFor(() => expect(result.current).not.toBeNull());
    const first = result.current;

    rerender({ workspaceId: "ws-2" });
    await waitFor(() => expect(result.current).toBe("conv-for-ws-2"));

    expect(result.current).not.toBe(first);
  });

  it("does not fire a second creation request while one is already in flight for the same workspace", async () => {
    const resolver: { resolve: (() => void) | null } = { resolve: null };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise((resolve) => {
            resolver.resolve = () =>
              resolve({ ok: true, json: async () => ({ id: "conv-slow", workspaceId: "ws-1" }) } as Response);
          })
      )
    );

    const { rerender } = renderHook(({ workspaceId }) => useActiveConversation(workspaceId), {
      initialProps: { workspaceId: "ws-1" },
    });
    rerender({ workspaceId: "ws-1" });
    rerender({ workspaceId: "ws-1" });

    expect(fetch).toHaveBeenCalledTimes(1);
    resolver.resolve?.();
  });

  // -------------------------------------------------------------------
  // STEP 4 REMEDIATION -- empty-conversation reuse
  // -------------------------------------------------------------------

  it("adopts the most recent conversation instead of creating a new one when it has no messages yet", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (method === "GET") {
          return jsonResponse({
            conversations: [{ id: "existing-empty-convo", title: "New conversation", hasMessages: false }],
          });
        }
        throw new Error("must not POST a new conversation when an empty one can be adopted");
      })
    );

    const { result } = renderHook(() => useActiveConversation("ws-1"));

    await waitFor(() => expect(result.current).toBe("existing-empty-convo"));

    expect(fetch).toHaveBeenCalledTimes(1); // only the GET check -- no POST
  });

  it("creates a new conversation when the most recent one already has messages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (method === "GET") {
          return jsonResponse({
            conversations: [{ id: "already-used-convo", title: "What is a process?", hasMessages: true }],
          });
        }
        return jsonResponse({ id: "brand-new-convo", workspaceId: "ws-1", title: "New conversation" });
      })
    );

    const { result } = renderHook(() => useActiveConversation("ws-1"));

    await waitFor(() => expect(result.current).toBe("brand-new-convo"));
  });

  it("falls through to creating a new conversation if the empty-check itself fails, never blocking the user", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (method === "GET") {
          return jsonResponse({}, false); // list check fails
        }
        return jsonResponse({ id: "conv-for-ws-1", workspaceId: "ws-1", title: "New conversation" });
      })
    );

    const { result } = renderHook(() => useActiveConversation("ws-1"));

    await waitFor(() => expect(result.current).toBe("conv-for-ws-1"));
  });

  // -------------------------------------------------------------------
  // STEP 4 REMEDIATION -- stale-response race protection
  // -------------------------------------------------------------------

  it("REGRESSION (Phase 2 repro): a manual selection made while creation is still in flight always wins over the creation's own result", async () => {
    const listResolver: { resolve: (() => void) | null } = { resolve: null };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (method === "GET") {
          // The empty-conversation check hangs -- simulates "New chat"
          // being clicked, then the user immediately clicking a
          // DIFFERENT, older conversation before this check resolves.
          return new Promise((resolve) => {
            listResolver.resolve = () => resolve(jsonResponse({ conversations: [] }));
          });
        }
        return jsonResponse({ id: "freshly-created-convo", workspaceId: "ws-1", title: "New conversation" });
      })
    );

    renderHook(() => useActiveConversation("ws-1"));

    // The user manually selects an older conversation WHILE the GET
    // check above is still pending.
    useAppStore.getState().setActiveConversation("manually-selected-convo", "ws-1");

    // Now let the creation flow's own GET (and, since it would find
    // nothing to adopt, its POST) resolve.
    listResolver.resolve?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The manual selection must still be active -- the creation flow's
    // own result must never have overwritten it.
    expect(useAppStore.getState().chat.activeConversationId).toBe("manually-selected-convo");
  });

  it("a manual selection made while the ADOPT-EXISTING check is in flight also wins", async () => {
    const listResolver: { resolve: (() => void) | null } = { resolve: null };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (method === "GET") {
          return new Promise((resolve) => {
            listResolver.resolve = () =>
              resolve(jsonResponse({ conversations: [{ id: "adoptable-empty-convo", title: "New conversation", hasMessages: false }] }));
          });
        }
        throw new Error("must not reach POST in this scenario");
      })
    );

    renderHook(() => useActiveConversation("ws-1"));

    useAppStore.getState().setActiveConversation("manually-selected-convo", "ws-1");

    listResolver.resolve?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(useAppStore.getState().chat.activeConversationId).toBe("manually-selected-convo");
  });
});
