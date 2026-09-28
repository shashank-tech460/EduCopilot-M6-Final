"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, FileText, FolderKanban, Plus, Search, Trash2, Video } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { TiltCard } from "@/components/shared/TiltCard";
import { Spotlight } from "@/components/shared/Spotlight";
import { StatusBadge } from "@/components/shared/StatusBadge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
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
import { Label } from "@/components/ui/label";
import { EmptyState } from "@/components/shared/EmptyState";
import { PageHeader } from "@/components/shared/PageHeader";
import { toast } from "@/store/useToastStore";
import { useHydrated } from "@/hooks/useHydrated";

export interface WorkspaceSummary {
  id: string;
  name: string;
  createdAt: string;
  /** Real, server-aggregated counts (Phase 6H) — never fabricated. A
   * freshly-created workspace defaults all of these to 0, which is
   * simply true, not a placeholder. */
  materialCount?: number;
  readyCount?: number;
  pdfCount?: number;
  videoCount?: number;
}

interface WorkspaceDashboardProps {
  userName: string;
  initialWorkspaces: WorkspaceSummary[];
}

/**
 * Client component handling all interactive dashboard behavior (create,
 * delete). Initial data comes from the server component parent
 * (app/(dashboard)/dashboard/page.tsx), which queries MongoDB directly —
 * this component re-syncs with the server via router.refresh() after each
 * mutation rather than reloading the page, so state stays correct without a
 * full navigation.
 *
 * Deletion requires confirmation via AlertDialog (destructive, irreversible
 * — it cascade-deletes every file/conversation/message in the workspace on
 * the server) rather than firing immediately from a click.
 */
export function WorkspaceDashboard({ userName, initialWorkspaces }: WorkspaceDashboardProps) {
  const router = useRouter();
  /**
   * Stage 10 — closes a live-reproduced hydration race: "Create
   * Workspace" (below) could silently swallow the very first click on a
   * freshly-loaded page. See hooks/useHydrated.ts's own docstring for
   * the full mechanism.
   */
  const hydrated = useHydrated();
  const [workspaces, setWorkspaces] = useState(initialWorkspaces);
  /**
   * Stage 10 — same root cause and fix as `WorkspaceFiles`' own Learning
   * Materials refresh bug (components/shared/workspace-files.tsx): a
   * plain `useState(initialWorkspaces)` initializer only seeds state
   * once, at mount, so React never applies a later, changed
   * `initialWorkspaces` prop on its own. This component's docstring
   * above claims it "re-syncs with the server via router.refresh()" —
   * that was never actually true, since neither `router.refresh()` call
   * below had any way to reach this component's own `workspaces` state.
   * In practice this mostly self-masked here (unlike the Learning
   * Materials panel) because both existing `router.refresh()` call
   * sites immediately follow a matching optimistic `setWorkspaces(...)`
   * of their own — but a per-workspace `materialCount`/`readyCount`
   * chip changing because a DIFFERENT action (ingestion finishing in a
   * workspace the user isn't even viewing) would never be picked up
   * while this page stayed mounted.
   *
   * Fixed via React's own documented "adjust state during render" (not
   * an effect) pattern for exactly this situation, rather than a
   * `useEffect` calling `setState` directly in its body — the latter is
   * flagged by this project's own react-hooks/set-state-in-effect rule,
   * since an unconditional setState-in-effect causes an extra, avoidable
   * render pass; comparing against a tracked previous prop value during
   * render lets React apply the update in the SAME render pass instead.
   */
  const [prevInitialWorkspaces, setPrevInitialWorkspaces] = useState(initialWorkspaces);
  if (initialWorkspaces !== prevInitialWorkspaces) {
    setPrevInitialWorkspaces(initialWorkspaces);
    setWorkspaces(initialWorkspaces);
  }
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const filteredWorkspaces = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return workspaces;
    return workspaces.filter((w) => w.name.toLowerCase().includes(trimmed));
  }, [workspaces, query]);
  const [pendingDelete, setPendingDelete] = useState<WorkspaceSummary | null>(null);

  async function handleCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCreateError(null);
    setIsSubmitting(true);

    try {
      const response = await fetch("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await response.json();

      if (!response.ok) {
        setCreateError(data?.error ?? "Something went wrong.");
        return;
      }

      setWorkspaces((prev) => [
        { ...data, materialCount: 0, readyCount: 0, pdfCount: 0, videoCount: 0 },
        ...prev,
      ]);
      setName("");
      setDialogOpen(false);
      toast({ title: "Workspace created", description: data.name, variant: "success" });
      router.refresh();
    } catch {
      setCreateError("Something went wrong. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleConfirmDelete() {
    if (!pendingDelete) return;
    const { id, name: workspaceName } = pendingDelete;
    setDeletingId(id);

    try {
      const response = await fetch(`/api/workspaces/${id}`, { method: "DELETE" });

      if (!response.ok) {
        toast({
          title: "Couldn't delete workspace",
          description: "Please try again.",
          variant: "destructive",
        });
        return;
      }

      setWorkspaces((prev) => prev.filter((workspace) => workspace.id !== id));
      toast({ title: "Workspace deleted", description: workspaceName, variant: "default" });
      router.refresh();
    } catch {
      toast({
        title: "Couldn't delete workspace",
        description: "Please try again.",
        variant: "destructive",
      });
    } finally {
      setDeletingId(null);
      setPendingDelete(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={`Welcome, ${userName}`}
        description={
          workspaces.length === 0
            ? "You don't have any workspaces yet."
            : `${workspaces.length} workspace${workspaces.length === 1 ? "" : "s"}.`
        }
        actions={
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Button size="sm" disabled={!hydrated}>
                <Plus className="h-4 w-4" />
                Create Workspace
              </Button>
            </DialogTrigger>
            <DialogContent>
            <form onSubmit={handleCreate}>
              <DialogHeader>
                <DialogTitle>Create workspace</DialogTitle>
                <DialogDescription>
                  Give it a name, like a course or subject.
                </DialogDescription>
              </DialogHeader>
              <div className="flex flex-col gap-1.5 py-4">
                <Label htmlFor="workspace-name">Workspace name</Label>
                <Input
                  id="workspace-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={60}
                  autoFocus
                  aria-invalid={!!createError}
                />
                {createError ? (
                  <p className="text-xs text-destructive">{createError}</p>
                ) : null}
              </div>
              <DialogFooter>
                <Button type="submit" disabled={isSubmitting}>
                  {isSubmitting ? "Creating…" : "Create Workspace"}
                </Button>
              </DialogFooter>
            </form>
            </DialogContent>
          </Dialog>
        }
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-medium">Your Workspaces</h2>
        {workspaces.length > 1 ? (
          <div className="relative w-full max-w-xs">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search workspaces…"
              aria-label="Search workspaces"
              className="pl-8"
            />
          </div>
        ) : null}
      </div>

      {workspaces.length === 0 ? (
        <EmptyState
          icon={FolderKanban}
          title="No workspaces yet"
          description="Create one for a course or subject to start uploading material."
        />
      ) : filteredWorkspaces.length === 0 ? (
        <EmptyState
          icon={Search}
          title="No workspaces match your search"
          description={`Nothing found for "${query}". Try a different name.`}
          compact
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filteredWorkspaces.map((workspace) => {
            const materialCount = workspace.materialCount ?? 0;
            const readyCount = workspace.readyCount ?? 0;
            const processingCount = Math.max(0, materialCount - readyCount);
            return (
              <Spotlight key={workspace.id} className="rounded-xl" color="oklch(0.62 0.22 288 / 0.14)">
                <TiltCard className="group h-full">
                  <Card className="flex h-full flex-col overflow-hidden transition-[box-shadow,border-color] duration-[var(--duration-md)] hover:border-primary/40 hover:shadow-[var(--shadow-lg)]">
                    <CardHeader className="pb-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-brand-indigo/25 to-brand-violet/15 text-brand-indigo transition-transform duration-[var(--duration-md)] group-hover:scale-110">
                          <FolderKanban className="h-4.5 w-4.5" aria-hidden="true" />
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                          onClick={() => setPendingDelete(workspace)}
                          disabled={deletingId === workspace.id}
                          aria-label={`Delete ${workspace.name}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                      <CardTitle className="truncate pt-1" title={workspace.name}>
                        {workspace.name}
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="flex flex-1 flex-col gap-3 pt-0">
                      {materialCount > 0 ? (
                        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                          {(workspace.pdfCount ?? 0) > 0 ? (
                            <span className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-secondary/50 px-2 py-0.5">
                              <FileText className="h-3 w-3" /> {workspace.pdfCount}
                            </span>
                          ) : null}
                          {(workspace.videoCount ?? 0) > 0 ? (
                            <span className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-secondary/50 px-2 py-0.5">
                              <Video className="h-3 w-3" /> {workspace.videoCount}
                            </span>
                          ) : null}
                          {processingCount > 0 ? <StatusBadge status="processing" label={`${processingCount} processing`} /> : null}
                        </div>
                      ) : (
                        <p className="text-xs text-muted-foreground">No materials yet</p>
                      )}
                      <div className="mt-auto flex items-center justify-between pt-1">
                        <Button asChild size="sm" variant="secondary" className="gap-1.5 transition-all group-hover:bg-primary group-hover:text-primary-foreground">
                          <Link href={`/workspace/${workspace.id}`}>
                            Open
                            <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
                          </Link>
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                </TiltCard>
              </Spotlight>
            );
          })}
        </div>
      )}

      <AlertDialog
        open={!!pendingDelete}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete &quot;{pendingDelete?.name}&quot;?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes the workspace and everything in it —
              all uploaded files, conversations, and messages. This cannot
              be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={!!deletingId}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmDelete}
              disabled={!!deletingId}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deletingId ? "Deleting…" : "Delete workspace"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
