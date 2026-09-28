"use client";

import { useState } from "react";
import { Film, Sparkles } from "lucide-react";

import { Card, CardHeader, CardContent, CardTitle } from "@/components/ui/card";
import { WorkspaceFiles, type MaterialSummary } from "@/components/shared/workspace-files";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { ConversationSidebar } from "@/components/shared/ConversationSidebar";
import { VideoPlayer } from "@/components/video/VideoPlayer";
import { TabNavigation } from "@/components/shared/TabNavigation";
import { PanelErrorBoundary } from "@/components/shared/PanelErrorBoundary";
import { EmptyState } from "@/components/shared/EmptyState";
import { useWorkspaceInit } from "@/hooks/useWorkspaceInit";
import { useAppStore } from "@/store/appStore";

interface WorkspaceDashboardShellProps {
  workspaceId: string;
  workspaceName: string;
  initialMaterials: MaterialSummary[];
  initialVideoFile: MaterialSummary | undefined;
}

const TABS = [
  { id: "video", label: "Video" },
  { id: "chat", label: "AI Tutor" },
  { id: "files", label: "Materials" },
] as const;

type TabId = (typeof TABS)[number]["id"];

/**
 * Accion Labs Requirement 1 (Interactive Learning Dashboard) — the 3-panel
 * shell. Extracted into its own client component specifically because
 * `useWorkspaceInit` (Task 1.3) is a client hook, while the parent page
 * remains a Server Component doing the actual authenticated/ownership-
 * checked data fetch (Phase 4/5 pattern, unchanged) — this wrapper is the
 * smallest boundary needed, not a conversion of the whole page.
 *
 * 1.1 — the three panels render in a responsive layout at `md:` (768px)
 *       and above (confirmed against Tailwind's actual
 *       `--breakpoint-md: 48rem` = 768px). Video and AI Tutor form the
 *       primary two-column learning area (each panel gets roughly half
 *       the row's width, not squeezed into a three-way split); Learning
 *       Materials is a full-width row below, since it's supporting
 *       content rather than a primary, equally-weighted panel.
 * 1.2 — `useWorkspaceInit(workspaceId, initialData)` is called here, with
 *       `initialData` seeded from the server-fetched workspace (the exact
 *       optimization Task 1.3 built `staleTime` for) so this doesn't
 *       trigger a redundant client-side fetch of data the server already
 *       has.
 * 1.3 — below `md:`, only the active tab's panel renders; at `md:` and
 *       above, all three always render regardless of `activeTab`, and the
 *       tab navigation itself is hidden (`md:hidden`). Visibility is
 *       controlled entirely through Tailwind's responsive display
 *       classes (`hidden md:block` / `block md:block`) — the native
 *       `hidden` HTML attribute is deliberately NOT also used here, since
 *       the two would conflict over which one wins at each breakpoint.
 * 1.4 — see components/shared/TabNavigation.tsx for the ARIA tabs pattern
 *       details.
 *
 * Requirement 1.5 (error message + retry on panel failure) is implemented
 * via PanelErrorBoundary wrapping each panel independently — see that
 * component for details. Server-side workspace data-fetch failures are
 * handled separately by the existing app/error.tsx (Next.js's route-level
 * boundary), unchanged.
 */
export function WorkspaceDashboardShell({
  workspaceId,
  workspaceName,
  initialMaterials,
  initialVideoFile,
}: WorkspaceDashboardShellProps) {
  const [activeTab, setActiveTab] = useState<TabId>("video");

  useWorkspaceInit(workspaceId, { id: workspaceId, name: workspaceName });

  // Requirement fix: clicking a ready video/YouTube item in Learning
  // Materials (components/shared/workspace-files.tsx's handleSelectMaterial)
  // calls the existing setActiveMedia() action; this is what makes that
  // selection actually change what the Video panel displays. The `.find()`
  // against `initialMaterials` — already workspace-scoped, server-verified
  // data passed down from the ownership-checked page fetch — is the
  // security-relevant part: App_Store's `activeMediaId` persists across
  // page loads (Task 1.1), so a stale id left over from a *different*
  // workspace must never be trusted directly. If it doesn't match a file
  // that's genuinely in *this* workspace's own material list, it's simply
  // not found here and safely falls through to the server-computed default
  // — never rendering a foreign file.
  const activeMediaId = useAppStore((state) => state.video.activeMediaId);
  const selectedVideoFile = initialMaterials.find(
    (file) =>
      file.id === activeMediaId &&
      (file.type === "video" || file.type === "youtube_url") &&
      file.status === "ready"
  );
  const currentVideoFile = selectedVideoFile ?? initialVideoFile;

  function panelClasses(tabId: TabId) {
    return activeTab === tabId ? "block" : "hidden md:block";
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="md:hidden">
        <TabNavigation
          tabs={TABS as unknown as { id: string; label: string }[]}
          activeTab={activeTab}
          onChange={(id) => setActiveTab(id as TabId)}
          panelIdFor={(id) => `panel-${id}`}
        />
      </div>

      <div className="flex flex-col gap-4">
        {/* Primary learning area: Video + AI Tutor side by side at md+.
            Two columns, not three sharing one row — this is the actual
            fix for Chat collapsing into an unusably narrow column: Chat
            now gets roughly half the row's width instead of ~28% of a
            three-way split. */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div
            id="panel-video"
            role="tabpanel"
            aria-labelledby="tab-video"
            className={panelClasses("video")}
          >
            <PanelErrorBoundary panelName="Video">
              <Card className="flex flex-col overflow-hidden border-border/70 md:h-full md:min-h-[500px]">
                <CardHeader className="border-b border-border/60 bg-card/60">
                  <CardTitle className="truncate" title={currentVideoFile ? currentVideoFile.originalName : undefined}>
                    {currentVideoFile ? currentVideoFile.originalName : "Current Lesson"}
                  </CardTitle>
                </CardHeader>
                <CardContent className="flex flex-1 flex-col justify-center bg-gradient-to-b from-transparent to-black/10 p-4 md:p-6">
                  {currentVideoFile ? (
                    <VideoPlayer
                      fileId={currentVideoFile.id}
                      type={currentVideoFile.type as "video" | "youtube_url"}
                      storageUrl={currentVideoFile.storageUrl}
                      title={currentVideoFile.originalName}
                    />
                  ) : (
                    <EmptyState
                      icon={Film}
                      title="No lesson video yet"
                      description="Upload an MP4 or add a YouTube video to start learning."
                      compact
                      className="border-none"
                    />
                  )}
                </CardContent>
              </Card>
            </PanelErrorBoundary>
          </div>

          <div
            id="panel-chat"
            role="tabpanel"
            aria-labelledby="tab-chat"
            className={panelClasses("chat")}
          >
            <PanelErrorBoundary panelName="Chat">
              {/* Phase 6K: was `md:h-full md:min-h-[500px]` — `h-full`
                  needs a definite-height ancestor to actually cap
                  anything, and this grid row's height is auto/content-
                  driven, so it did nothing on desktop: a long AI answer
                  grew this Card (and the whole grid row, and the page)
                  instead of scrolling inside ChatPanel's own internal
                  `overflow-y-auto` region (components/chat/ChatPanel.tsx
                  already has that region — it just had no bounded
                  height to scroll within). A real fixed height, matching
                  the pattern already used on mobile, actually bounds it;
                  the Video panel (which keeps `md:h-full`) stretches to
                  match via the grid's default `align-items: stretch`. */}
              <Card className="flex h-[500px] flex-col overflow-hidden border-border/70 md:h-[640px]">
                <CardHeader className="border-b border-border/60 bg-card/60">
                  <CardTitle className="flex items-center gap-2">
                    <span className="flex h-6 w-6 items-center justify-center rounded-md bg-gradient-to-br from-brand-indigo/30 to-brand-violet/20 text-brand-indigo">
                      <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                    </span>
                    AI Tutor
                  </CardTitle>
                </CardHeader>
                {/* Conversation history rail + the existing Chat panel,
                    side by side within the same card — the sidebar reuses
                    ui.sidebarOpen (store/appStore.ts) to collapse without
                    shrinking ChatPanel's own usable width below what it
                    already had before this rail existed. */}
                <div className="flex min-h-0 flex-1">
                  <ConversationSidebar workspaceId={workspaceId} />
                  <div className="min-w-0 flex-1">
                    <ChatPanel workspaceId={workspaceId} />
                  </div>
                </div>
              </Card>
            </PanelErrorBoundary>
          </div>
        </div>

        {/* Learning Materials: supporting content, full width below the
            primary Video/Chat area rather than squeezed into a third
            column. */}
        <div
          id="panel-files"
          role="tabpanel"
          aria-labelledby="tab-files"
          className={panelClasses("files")}
        >
          <PanelErrorBoundary panelName="Files">
            <WorkspaceFiles workspaceId={workspaceId} initialMaterials={initialMaterials} />
          </PanelErrorBoundary>
        </div>
      </div>
    </div>
  );
}
