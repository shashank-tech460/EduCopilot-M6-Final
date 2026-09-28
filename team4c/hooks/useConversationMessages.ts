"use client";

import { useQuery } from "@tanstack/react-query";
import type { UIMessage } from "ai";

import type { SourceAttribution } from "@/store/appStore";

interface RestoredMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  citations?: SourceAttribution[];
}

interface MessagesResponse {
  conversationId: string;
  messages: RestoredMessage[];
}

/**
 * Converts one message from `GET /api/conversations/[id]/messages`'s
 * response into the exact `UIMessage` shape `ChatPanel`/`useChatStream`
 * already render live messages in — a restored message and a live one are
 * indistinguishable to the rendering code below this point. Citations go
 * into a `data-citations` part with the SAME `SourceAttribution[]` shape
 * the live streaming response already sends (app/api/chat/route.ts's
 * `data-citations` stream part) — no new citation-rendering path is
 * introduced.
 */
function toUIMessage(message: RestoredMessage): UIMessage {
  return {
    id: message.id,
    role: message.role,
    parts: [
      { type: "text", text: message.content },
      ...(message.citations && message.citations.length > 0
        ? [{ type: "data-citations" as const, data: message.citations }]
        : []),
    ],
  } as UIMessage;
}

/**
 * Persistent chat history — Step 6. Fetches a conversation's saved
 * message history (Step 4's endpoint) and adapts it into the shape
 * `useChatStream` seeds `useChat()` with on conversation selection.
 *
 * `enabled: !!conversationId` — no request while
 * `useActiveConversation` is still establishing the active conversation
 * (conversationId is briefly `null` on a first visit).
 *
 * `initialMessages` is `undefined` while loading/not yet requested (a
 * real "don't know yet" state, distinct from `[]`, which means "loaded,
 * genuinely no messages") — callers must not treat the two the same.
 */
export function useConversationMessages(workspaceId: string, conversationId: string | null) {
  const { data, isLoading, isError } = useQuery<MessagesResponse>({
    queryKey: ["conversation-messages", conversationId],
    queryFn: async () => {
      const response = await fetch(
        `/api/conversations/${conversationId}/messages?workspaceId=${encodeURIComponent(workspaceId)}`
      );
      if (!response.ok) {
        throw new Error("Unable to load conversation history.");
      }
      return response.json();
    },
    enabled: !!conversationId,
    staleTime: 10_000,
  });

  return {
    initialMessages: data ? data.messages.map(toUIMessage) : undefined,
    isLoading: isLoading && !!conversationId,
    isError,
  };
}
