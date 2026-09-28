"use client";

import { useEffect, useRef } from "react";
import { useAppStore } from "@/store/appStore";

interface ConversationSummary {
  id: string;
  hasMessages: boolean;
}

interface ConversationsResponse {
  conversations: ConversationSummary[];
}

/**
 * STEP 4 REMEDIATION: a caller (either this hook's own effect running
 * again for the same workspace, or `ConversationSidebar`'s "New chat")
 * only ever WANTS a conversation to land in the store if nothing else
 * has already claimed this workspace's active slot in the meantime.
 * Re-reads the CURRENT store state (never the stale value captured when
 * the async work started) so a manual selection that happened during
 * the await always wins, regardless of timing.
 */
function claimActiveConversationIfStillUnclaimed(
  workspaceId: string,
  conversationId: string,
  setActiveConversation: (conversationId: string, workspaceId: string) => void
): void {
  const current = useAppStore.getState().chat;
  if (current.activeConversationWorkspaceId === workspaceId && current.activeConversationId) {
    // Someone else (a manual selection, or a sibling effect run that
    // already resolved) already claimed this workspace's active
    // conversation while this async work was in flight -- the
    // conversation this call would have set is simply left unclaimed
    // (if it was freshly created, it stays a harmless, genuinely empty
    // conversation the user can still reach from the sidebar; nothing
    // is deleted or orphaned in a broken state).
    return;
  }
  setActiveConversation(conversationId, workspaceId);
}

export function useActiveConversation(workspaceId: string): string | null {
  const activeConversationId = useAppStore(
    (state) => state.chat.activeConversationId
  );
  const activeConversationWorkspaceId = useAppStore(
    (state) => state.chat.activeConversationWorkspaceId
  );
  const setActiveConversation = useAppStore(
    (state) => state.setActiveConversation
  );

  const creationInFlightForRef = useRef<string | null>(null);

  useEffect(() => {
    if (activeConversationWorkspaceId === workspaceId && activeConversationId) {
      return;
    }

    if (creationInFlightForRef.current === workspaceId) {
      return;
    }

    creationInFlightForRef.current = workspaceId;

    async function adoptExistingOrCreateConversation() {
      try {
        // STEP 4 REMEDIATION: reuse the most recently updated
        // conversation if it's still genuinely unused, instead of
        // always minting a new one -- covers both a fresh page
        // load/reload and "New chat" (which clears the active id,
        // landing here the same way) being clicked while already on an
        // empty conversation.
        try {
          const listResponse = await fetch(`/api/workspaces/${workspaceId}/conversations?limit=1`);
          if (listResponse.ok) {
            const listData: ConversationsResponse = await listResponse.json();
            const mostRecent = listData.conversations[0];
            if (mostRecent && !mostRecent.hasMessages) {
              claimActiveConversationIfStillUnclaimed(workspaceId, mostRecent.id, setActiveConversation);
              return;
            }
          }
        } catch (error) {
          // Falls through to creating a new conversation -- an
          // unreachable list check must never block the user from
          // getting a working conversation at all.
          console.error("[chat] Failed to check for an existing empty conversation:", error);
        }

        const response = await fetch(
          `/api/workspaces/${workspaceId}/conversations`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({}),
          }
        );

        if (!response.ok) {
          console.error(
            `[chat] Failed to create conversation: ${response.status} ${response.statusText}`
          );
          return;
        }

        const data: { id: string } = await response.json();

        claimActiveConversationIfStillUnclaimed(workspaceId, data.id, setActiveConversation);
      } catch (error) {
        console.error("[chat] Conversation creation failed:", error);
      } finally {
        if (creationInFlightForRef.current === workspaceId) {
          creationInFlightForRef.current = null;
        }
      }
    }

    void adoptExistingOrCreateConversation();
  }, [
    workspaceId,
    activeConversationId,
    activeConversationWorkspaceId,
    setActiveConversation,
  ]);

  return activeConversationWorkspaceId === workspaceId
    ? activeConversationId
    : null;
}
