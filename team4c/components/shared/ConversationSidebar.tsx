"use client";

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageSquarePlus, MessagesSquare, PanelLeftClose, PanelLeftOpen, AlertCircle, Trash2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/EmptyState";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "@/store/useToastStore";
import { useAppStore } from "@/store/appStore";

interface ConversationSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

interface ConversationsResponse {
  conversations: ConversationSummary[];
  nextCursor: string | null;
}

function formatUpdatedAt(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/**
 * Conversation sidebar — persistent chat history, Step 5.
 *
 * Lists conversations via the Step 3 endpoint (`GET
 * /api/workspaces/[id]/conversations`, already sorted `updatedAt` desc —
 * this component does not re-sort). Read-only for now: clicking a row does
 * nothing (Step 6) — see hooks/useChatStream.ts / hooks/
 * useConversationMessages.ts for how selecting a row here actually
 * restores that conversation's messages into ChatPanel. This component
 * itself does no restoration work; it only sets which conversation is
 * active, via the same existing store action selection below uses.
 *

 * "New Chat" reuses the EXISTING conversation-creation flow rather than
 * calling the create endpoint itself: `clearActiveConversation()`
 * (store/appStore.ts, already existed, previously unused by any
 * component) resets `chat.activeConversationId`, which is exactly the
 * condition `hooks/useActiveConversation.ts`'s effect already watches for
 * to POST a fresh conversation — the same code path that already runs on
 * a first workspace visit today. No new fetch logic is introduced here.
 * That hook's own `creationInFlightForRef` guard already prevents a
 * duplicate POST if this is triggered rapidly/repeatedly.
 *
 * Collapse state reuses the existing, previously-unconsumed
 * `ui.sidebarOpen`/`toggleSidebar` store fields (store/appStore.ts) rather
 * than introducing new local/global state for the same concept.
 */
export function ConversationSidebar({ workspaceId }: { workspaceId: string }) {
  const sidebarOpen = useAppStore((state) => state.ui.sidebarOpen);
  const toggleSidebar = useAppStore((state) => state.toggleSidebar);
  const setSidebarOpen = useAppStore((state) => state.setSidebarOpen);
  const activeConversationId = useAppStore((state) => state.chat.activeConversationId);
  const queryClient = useQueryClient();
  const [pendingDelete, setPendingDelete] = useState<ConversationSummary | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  // MVP polish pass: `sidebarOpen` defaults to `true` (store/appStore.ts)
  // for every viewport -- fine on desktop, but confirmed live to leave
  // this expanded, fixed-width (`w-56`) rail and ChatPanel squeezed into
  // an unreadable two-column split on a real mobile viewport (375px),
  // with no page-level overflow to signal anything was wrong. Reusing
  // the EXISTING collapse mechanism (already has its own show/hide
  // toggle button, already tested) rather than adding a second one:
  // collapse it once, on mount, only when the viewport is already
  // narrow.
  //
  // Deliberately one-directional (collapse only, never force-expand):
  // `ui.sidebarOpen` is persisted to localStorage (this store's own
  // `partialize`), and an existing, intentional contract (see the
  // "collapse / responsive behavior" describe block below) already
  // relies on a manually-collapsed sidebar staying collapsed across a
  // reload, on any viewport -- an earlier version of this effect that
  // also force-expanded on a wide viewport broke exactly that contract,
  // since it cannot distinguish "collapsed because a previous mount on
  // a narrow viewport did this" from "collapsed because the user chose
  // to." One-directional avoids needing that distinction: it only ever
  // acts on the untouched default (`true`), never overrides a `false`
  // it did not just set itself, and never runs on the server (window is
  // unavailable during SSR).
  useEffect(() => {
    if (typeof window !== "undefined" && window.innerWidth < 640) {
      setSidebarOpen(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { data, isLoading, isError, refetch } = useQuery<ConversationsResponse>({
    queryKey: ["conversations", workspaceId],
    queryFn: async () => {
      const response = await fetch(`/api/workspaces/${workspaceId}/conversations`);
      if (!response.ok) {
        throw new Error("Unable to load conversations.");
      }
      return response.json();
    },
    staleTime: 10_000,
  });

  // Refetch when the active conversation changes (New Chat, or the
  // existing auto-create-on-visit flow) so a freshly created conversation
  // appears without a manual reload. Only reacts to identity changes, not
  // on every render, so this does not cause repeated/duplicate requests.
  useEffect(() => {
    if (activeConversationId) {
      void refetch();
    }
  }, [activeConversationId, refetch]);

  function handleNewChat() {
    useAppStore.getState().clearActiveConversation();
  }

  /**
   * Step 5 — individual conversation deletion.
   *
   * If the deleted conversation was the active one, `clearActiveConversation()`
   * is the SAME existing action "New chat" already uses — it puts the
   * store back into "no active conversation for this workspace" state,
   * which `hooks/useActiveConversation.ts`'s own Step 4 adopt-or-create
   * logic then resolves on its own (adopting another existing empty
   * conversation, or creating a fresh one). No new selection logic is
   * introduced here.
   */
  async function handleConfirmDelete() {
    if (!pendingDelete) return;
    const { id, title } = pendingDelete;
    setIsDeleting(true);

    try {
      const response = await fetch(`/api/conversations/${id}?workspaceId=${workspaceId}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        toast({
          title: "Couldn't delete conversation",
          description: "Please try again.",
          variant: "destructive",
        });
        return;
      }

      if (id === activeConversationId) {
        useAppStore.getState().clearActiveConversation();
      }

      await queryClient.invalidateQueries({ queryKey: ["conversations", workspaceId] });
      toast({ title: "Conversation deleted", description: title });
    } catch {
      toast({
        title: "Couldn't delete conversation",
        description: "Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsDeleting(false);
      setPendingDelete(null);
    }
  }

  // Persistent chat history (Step 6) — the ONLY thing selecting a row
  // does: set the existing activeConversationId/activeConversationWorkspaceId
  // store fields directly (the same setter useActiveConversation itself
  // calls after creating a new conversation). Setting an id that already
  // exists means useActiveConversation's own effect condition
  // (`activeConversationWorkspaceId === workspaceId && activeConversationId`)
  // is already satisfied, so it does NOT create another conversation —
  // restoration itself is entirely useChatStream/useConversationMessages'
  // responsibility, reacting to this same store value.
  function handleSelectConversation(conversationId: string) {
    if (conversationId === activeConversationId) {
      return;
    }
    useAppStore.getState().setActiveConversation(conversationId, workspaceId);
  }

  if (!sidebarOpen) {
    return (
      <div className="flex w-10 shrink-0 flex-col items-center border-r border-border/70 bg-card/30 py-2">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={toggleSidebar}
          aria-label="Show conversation history"
          title="Show conversation history"
        >
          <PanelLeftOpen className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
    );
  }

  return (
    <div className="flex w-56 shrink-0 flex-col border-r border-border/70 bg-card/30">
      <div className="flex items-center justify-between gap-1 border-b border-border/60 px-2 py-2">
        <Button type="button" variant="ghost" size="sm" className="flex-1 justify-start gap-1.5" onClick={handleNewChat}>
          <MessageSquarePlus className="h-4 w-4" aria-hidden="true" />
          New chat
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={toggleSidebar}
          aria-label="Hide conversation history"
          title="Hide conversation history"
        >
          <PanelLeftClose className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-2" aria-label="Conversation history">
        {isLoading ? (
          <div className="flex flex-col gap-2 p-1">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-3/4" />
          </div>
        ) : isError ? (
          <EmptyState
            icon={AlertCircle}
            title="Couldn't load history"
            description="Your current chat still works — try again shortly."
            compact
            className="border-none"
          />
        ) : !data || data.conversations.length === 0 ? (
          <EmptyState
            icon={MessagesSquare}
            title="No conversations yet"
            description="Start a chat to see it here."
            compact
            className="border-none"
          />
        ) : (
          <ul className="flex flex-col gap-1">
            {data.conversations.map((conversation) => (
              <li key={conversation.id} className="group relative">
                <button
                  type="button"
                  onClick={() => handleSelectConversation(conversation.id)}
                  aria-current={conversation.id === activeConversationId ? "true" : undefined}
                  className={cn(
                    "w-full rounded-md py-2 pl-2.5 pr-8 text-left text-sm transition-colors duration-[var(--duration-sm)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
                    conversation.id === activeConversationId
                      ? "bg-sidebar-accent text-sidebar-accent-foreground"
                      : "text-muted-foreground hover:bg-sidebar-accent/60"
                  )}
                  title={conversation.title}
                >
                  <p className="truncate font-medium text-foreground">{conversation.title}</p>
                  <p className="text-xs text-muted-foreground">{formatUpdatedAt(conversation.updatedAt)}</p>
                </button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute right-1 top-1/2 h-6 w-6 -translate-y-1/2 opacity-0 group-hover:opacity-100"
                  aria-label={`Delete ${conversation.title}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    setPendingDelete(conversation);
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this conversation?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete
                ? `"${pendingDelete.title}" and all its messages will be permanently removed. This cannot be undone.`
                : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmDelete}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
