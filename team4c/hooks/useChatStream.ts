"use client";

import { useEffect, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { useQueryClient } from "@tanstack/react-query";
import { DefaultChatTransport, type UIMessage } from "ai";

import { useAppStore, type SourceAttribution, type QueuedChatMessage } from "@/store/appStore";
import { isOffline, isNetworkError, flushOfflineQueue } from "@/components/chat/OfflineQueue";

/**
 * Chat streaming hook — Accion Labs Task 2.1, adapted from the design
 * document's `useChatStream` sample (which shows `ai/react`'s v3/v4-era
 * `handleSubmit`/`input`/flat `content` API). The actually installed
 * versions here (ai@7, @ai-sdk/react@4 — confirmed by reading
 * node_modules/ai/dist/index.d.ts directly, not assumed) use a
 * transport-based API with structured message `parts` instead. This is
 * the "use the correct API for the installed version" adaptation Phase F
 * explicitly calls for — the *behavior* matches the spec exactly; only the
 * API shape differs from the sample.
 *
 * Property 1 (payload completeness) — the request body always includes
 * `workspaceId` and `videoTimestamp`, read fresh via the `body` transport
 * option's function form on every send, not captured once at hook-mount
 * time.
 *
 * The conflict noted in this task's Phase A report is resolved here:
 * `videoTimestamp` is `null` when `video.activeMediaId` is null (no video
 * active) rather than sending the store's numeric default of 0 — matching
 * Property 1's exact wording without changing appStore.ts's types.
 *
 * Requirement 8.1/8.2 (Offline Queue): handled here rather than in
 * ChatPanel, since only this hook has access to `sendMessage`/`status`/
 * `error`. Two integration points:
 *   1. Before sending, `isOffline()` short-circuits straight to the queue
 *      without even attempting a request.
 *   2. `onError` classifies the failure — a real network failure
 *      (`isNetworkError`) queues the message that was just attempted; an
 *      application error (401/404/500/etc.) falls through to the
 *      existing, unchanged `setMessageError` inline-error path.
 *
 * Persistent chat history (Step 6): passing `id: conversationId` to
 * `useChat()` is the AI SDK's own documented mechanism for this exact
 * scenario — verified directly in node_modules/@ai-sdk/react/dist/index.js
 * before relying on it: `useChat()` recreates its internal `Chat` instance
 * whenever the `id` option changes (`shouldRecreateChat`), and every
 * update from the previous instance is identity-checked and ignored by
 * the subscription that drives `messages` (`messagesSnapshotRef.current
 * .chat !== chat`). This is what makes "switch to a different
 * conversation" and "New Chat" (a new conversationId) correctly show a
 * clean message list — no manual `key`-remount of ChatPanel is needed —
 * and what prevents a still-in-flight stream from the PREVIOUS
 * conversation from ever rendering into the NEWLY selected one. Message
 * PERSISTENCE is unaffected either way: app/api/chat/route.ts already
 * writes both turns to Mongo using the conversationId captured in the
 * request body at send time, before the streaming loop even starts, not
 * something read from client state after the fact — switching
 * conversations mid-stream cannot save a message under the wrong one.
 *
 * `initialMessages` (from `hooks/useConversationMessages.ts`) seeds a
 * resumed conversation's saved history. It is `undefined` while that
 * fetch is still loading — distinct from `[]` (loaded, genuinely empty) —
 * and is applied via `setMessages()` exactly once per conversationId
 * (`seededForRef` below), so it never clobbers messages the user has
 * already sent in the current conversation after the initial seed.
 *
 * STUCK-STREAM WATCHDOG (MVP polish pass): confirmed via live
 * investigation that a Next.js dev-server Hot Module Reload / Fast
 * Refresh remount occurring while a response is streaming leaves
 * `useChat()`'s internal `Chat` instance permanently in `status ===
 * "streaming"` — Team4B's own server logs show the request completing
 * successfully and the answer being generated, but the UI never receives
 * it and stays on "Thinking…" forever, with no error and no way to send
 * another message (`submitMessage` refuses while `isStreaming`). This is
 * a dev-mode-only trigger (Fast Refresh does not exist in a production
 * build) but leaves the app completely stuck when it happens, so this
 * adds a client-only recovery: if streaming is still ongoing after
 * `STUCK_STREAM_TIMEOUT_MS` (set well above the worst real generation
 * time this project has measured, including a cold Ollama model load),
 * the current `Chat` instance is abandoned by changing `useChat()`'s
 * `id` (the SDK's own documented mechanism for creating a fresh
 * instance — see the `id` option below) and the conversation's last
 * known-good saved history is re-seeded into it, so the UI returns to a
 * normal, usable state instead of staying stuck. The orphaned request
 * was never persisted (confirmed: Team4B never received a save call for
 * it), so nothing is lost beyond the one attempt the user can simply
 * retry.
 */
export function useChatStream(
  workspaceId: string,
  conversationId: string | null,
  initialMessages: UIMessage[] | undefined
) {
  // MVP M5 correction: `conversationId` is `null` only while
  // `useActiveConversation` (hooks/useActiveConversation.ts) is still
  // establishing/creating the active Conversation for `workspaceId` --
  // `submitMessage` below refuses to send until it is non-null, so the
  // real Chat UI never operates without an authorized Conversation.
  // Tracks the text of the most recent submitAttempt so onError (which
  // only receives the Error, not the original request) can queue the
  // right message if it turns out to be a network failure.
  // Stage 6 — invalidates the SAME sidebar list query key
  // (`["conversations", workspaceId]`) that `ConversationSidebar.tsx`'s
  // own delete flow already invalidates, reusing that established
  // pattern rather than introducing a second one. This is what makes a
  // freshly auto-generated title (app/api/chat/route.ts) — and this
  // conversation's reordering to the top via its bumped `updatedAt` —
  // show up in the sidebar without a manual reload.
  const queryClient = useQueryClient();
  const lastAttemptedTextRef = useRef<string | null>(null);
  // Persistent chat history (Step 6) — which conversationId's
  // `initialMessages` have already been applied via setMessages(), so the
  // seeding effect below runs at most once per conversation. See that
  // effect for the full reasoning.
  const seededForRef = useRef<string | null>(null);
  // Resolves the in-flight flush-loop's per-item promise from onFinish/
  // onError — lets flushOfflineQueue await one queued item fully
  // completing before sending the next (Property 17's FIFO + no-duplicate
  // guarantee), without needing sendMessage() itself to return a promise
  // that resolves on stream completion (it doesn't).
  const flushResolveRef = useRef<((succeeded: boolean) => void) | null>(null);
  // MVP M5 micro-correction: the exact QueuedChatMessage currently being
  // replayed, if any -- set immediately before calling sendMessage() for
  // a replay, cleared after onFinish/onError. A network failure during
  // THIS specific send must requeue using THIS item's own original
  // workspaceId/conversationId/videoTimestamp, never whatever the hook's
  // CURRENT `workspaceId`/`conversationId` parameters happen to be at
  // the moment onError fires -- those can legitimately have changed
  // (the user switched conversations/workspaces) while the replay
  // request was still in flight. `null` means "the send currently in
  // flight (if any) is a normal, non-replay submitMessage() call."
  const replayingItemRef = useRef<QueuedChatMessage | null>(null);
  // Stuck-stream watchdog: bumped to force useChat() to construct a
  // fresh Chat instance, abandoning one whose stream got orphaned by a
  // dev-server Fast Refresh remount (see module docstring). Included in
  // `id` below rather than replacing it, so a genuine conversation
  // switch is unaffected.
  const [streamGeneration, setStreamGeneration] = useState(0);
  const [timedOut, setTimedOut] = useState(false);

  const { messages, sendMessage, status, error, regenerate, clearError, setMessages } = useChat({
    // A fixed sentinel, never a real conversationId (those are Mongo
    // ObjectId hex strings) — the AI SDK's `shouldRecreateChat` check
    // specifically requires `options.id != null` to trigger recreation,
    // so passing `undefined` while a brand-new conversation is still
    // being created (conversationId briefly null — New Chat, or the very
    // first workspace visit) would NOT reset the chat instance, leaving
    // the previous conversation's messages visible until the new
    // conversationId arrives. The sentinel makes every transition INTO
    // and OUT OF the "creating" state its own distinct id, so New Chat
    // clears the visible list immediately on click, not only once
    // creation finishes. `streamGeneration` is appended so the stuck-
    // stream watchdog can force recreation without changing conversation.
    id: `${conversationId ?? "pending-new-conversation"}#${streamGeneration}`,
    transport: new DefaultChatTransport({
      api: "/api/chat",
      body: () => {
        const { activeMediaId, currentTimestamp } = useAppStore.getState().video;
        return {
          workspaceId,
          // MVP M5 correction: the ACTIVE conversation for a normal
          // (non-replay) send. Offline-queue replay overrides this with
          // the queued item's own ORIGINAL conversationId via
          // sendMessage's per-call `body` option (see `handleOnline`
          // below) -- this default is never used for a replay.
          conversationId,
          videoTimestamp: activeMediaId ? currentTimestamp : null,
        };
      },
    }),
    onFinish: ({ message }) => {
      const citationsPart = message.parts.find(
        (part): part is { type: "data-citations"; data: SourceAttribution[] } =>
          part.type === "data-citations"
      );
      useAppStore.getState().addMessage({
        id: message.id,
        role: message.role === "assistant" ? "assistant" : "user",
        content: message.parts
          .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
          .map((part) => part.text)
          .join(""),
        attributions: citationsPart?.data,
        timestamp: new Date(),
        status: "complete",
      });
      useAppStore.getState().setStreaming(false);
      // Stage 6 — refreshes the sidebar list so a first-message title
      // update (or this conversation's reordering to the top) appears
      // without a manual reload. Not conditioned on this being the
      // FIRST message -- an unconditional, cheap cache invalidation
      // (not a forced refetch) after every completed turn, matching the
      // existing delete-flow's own invalidation call exactly.
      void queryClient.invalidateQueries({ queryKey: ["conversations", workspaceId] });
      replayingItemRef.current = null;
      flushResolveRef.current?.(true);
      flushResolveRef.current = null;
      setTimedOut(false);
    },
    onError: (err) => {
      useAppStore.getState().setStreaming(false);
      setTimedOut(false);

      if (isNetworkError(err)) {
        const replayingItem = replayingItemRef.current;
        if (replayingItem) {
          // The item being replayed is STILL present in the offline
          // queue -- flushOfflineQueue (components/chat/OfflineQueue.ts)
          // only ever dequeues an item on SUCCESS; on failure it simply
          // breaks out of its loop, leaving the item exactly as it was.
          // Its own original workspaceId/conversationId/videoTimestamp/
          // queuedAt are therefore already correct and untouched --
          // re-enqueueing here (as the pre-correction code did,
          // unconditionally) would create a DUPLICATE entry, and
          // rebuilding it from the hook's CURRENT
          // workspaceId/conversationId (as the branch below does for a
          // genuinely new message) would silently rewrite it to
          // whichever conversation/workspace happens to be active NOW --
          // exactly the bug this correction exists to fix. So: neither
          // action is taken; the existing queued entry is left alone.
        } else {
          const text = lastAttemptedTextRef.current;
          if (text && conversationId) {
            useAppStore.getState().enqueueOfflineMessage({
              id: crypto.randomUUID(),
              text,
              workspaceId,
              conversationId,
              videoTimestamp: useAppStore.getState().video.activeMediaId
                ? useAppStore.getState().video.currentTimestamp
                : null,
              queuedAt: new Date(),
            });
          }
        }
        // Requirement 8.1 — a network failure is handled entirely by the
        // queue notification (rendered in ChatPanel from the queue state
        // itself); it must NOT also populate the existing inline
        // application-error UI, which is reserved for real API/HTTP
        // errors per the error-classification rule.
      } else {
        useAppStore.getState().setMessageError(err.message);
      }

      replayingItemRef.current = null;
      flushResolveRef.current?.(false);
      flushResolveRef.current = null;
    },
  });

  const isStreaming = status === "submitted" || status === "streaming";

  // Keep the App_Store's isStreaming flag (used elsewhere, e.g. a future
  // Dashboard-level indicator) in sync with useChat's own status. This
  // runs as an effect, not during render — calling a store setter directly
  // in the render body would be an impure side effect and risks
  // Strict-Mode double-invocation issues.
  useEffect(() => {
    useAppStore.getState().setStreaming(isStreaming);
  }, [isStreaming]);

  // Stuck-stream watchdog — see module docstring. 4 minutes is set well
  // above the worst real generation time measured for this project's
  // local CPU-only Ollama setup (including a cold model load), so this
  // only ever fires for a genuinely orphaned stream, never a slow-but-
  // healthy one.
  const STUCK_STREAM_TIMEOUT_MS = 240_000;
  useEffect(() => {
    if (!isStreaming) {
      return;
    }
    const timer = setTimeout(() => {
      seededForRef.current = null;
      setStreamGeneration((generation) => generation + 1);
      useAppStore.getState().setStreaming(false);
      setTimedOut(true);
    }, STUCK_STREAM_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [isStreaming]);

  // Persistent chat history (Step 6) — seeds a resumed conversation's
  // saved messages exactly once per conversationId. `seededForRef` (not a
  // plain boolean) is what makes "once per conversation" correct across a
  // conversation switch: `initialMessages` legitimately becomes available
  // again for a NEW conversationId, and must be applied again for that
  // new id, but must never re-apply for the SAME id after the user has
  // since sent a message in it (which would wipe out what they just
  // sent). `initialMessages === undefined` means "still loading" (see
  // hooks/useConversationMessages.ts) and is deliberately not treated the
  // same as `[]` ("loaded, genuinely empty") — seeding only happens once
  // the real answer is known, never speculatively.
  useEffect(() => {
    if (initialMessages !== undefined && conversationId && seededForRef.current !== conversationId) {
      setMessages(initialMessages);
      seededForRef.current = conversationId;
    }
  }, [initialMessages, conversationId, setMessages]);

  // Requirement 8.2 — automatically retry queued messages when
  // connectivity is restored. The browser's native "online" event, not
  // polling — navigator.onLine is only checked reactively here, never
  // pinged proactively.
  useEffect(() => {
    function handleOnline() {
      flushOfflineQueue((item: QueuedChatMessage) => {
        return new Promise<boolean>((resolve) => {
          flushResolveRef.current = resolve;
          lastAttemptedTextRef.current = item.text;
          // MVP M5 micro-correction: set BEFORE calling sendMessage, so
          // onError can tell "this failure belongs to a replay of THIS
          // exact item" from "this failure belongs to a fresh,
          // normal send" -- cleared in both onFinish and onError.
          replayingItemRef.current = item;
          // Replay MUST use the queued item's own ORIGINAL
          // workspaceId/conversationId/videoTimestamp -- never
          // whichever workspace/conversation/video happens to be
          // active right now (the user may have switched any of them
          // while this item sat in the queue) -- overridden per-call
          // via sendMessage's `body` option, which merges on top of
          // (and here, deliberately overrides) the transport's own
          // `body` function above.
          sendMessage(
            { text: item.text },
            { body: { conversationId: item.conversationId, workspaceId: item.workspaceId, videoTimestamp: item.videoTimestamp } }
          );
        });
      });
    }

    window.addEventListener("online", handleOnline);
    return () => window.removeEventListener("online", handleOnline);
  }, [sendMessage]);

  function submitMessage(text: string) {
    if (!text.trim() || isStreaming || !conversationId) {
      return;
    }

    if (isOffline()) {
      // Requirement 8.1 — queued immediately, without ever attempting a
      // request that's already known to be futile.
      useAppStore.getState().enqueueOfflineMessage({
        id: crypto.randomUUID(),
        text,
        workspaceId,
        conversationId,
        videoTimestamp: useAppStore.getState().video.activeMediaId
          ? useAppStore.getState().video.currentTimestamp
          : null,
        queuedAt: new Date(),
      });
      return;
    }

    lastAttemptedTextRef.current = text;
    replayingItemRef.current = null;
    setTimedOut(false);
    sendMessage({ text });
  }

  function retry() {
    clearError();
    regenerate();
  }

  return {
    messages,
    submitMessage,
    isStreaming,
    error,
    retry,
    timedOut,
    offlineQueue: useAppStore((state) => state.chat.offlineQueue),
  };
}
