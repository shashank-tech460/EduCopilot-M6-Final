import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * Stage 10 — regression tests for a bug found by direct code reading: like
 * `WorkspaceFiles`' own Learning Materials panel refresh bug
 * (tests/component/workspace-files-upload.test.tsx), `WorkspaceDashboard`
 * seeds `workspaces` from `initialWorkspaces` via a plain `useState`
 * initializer, which React never re-applies when a parent re-render (e.g.
 * after `router.refresh()`) supplies a new `initialWorkspaces` array —
 * despite this component's own docstring claiming it "re-syncs with the
 * server via router.refresh()". A workspace's `materialCount`/`readyCount`
 * chips (server-aggregated by the parent server component) would therefore
 * never reflect a material finishing ingestion while this page stayed
 * mounted, unless the user happened to also create/delete a workspace in
 * this exact session (whose own optimistic `setWorkspaces` calls masked the
 * bug). No test previously existed for this component at all.
 *
 * These tests simulate exactly what `router.refresh()` does on a real
 * Next.js page: re-render the SAME mounted component instance with a new
 * `initialWorkspaces` prop (via RTL's `rerender`) — never by calling this
 * component's own create/delete handlers, which would mask the bug behind
 * their own optimistic `setWorkspaces` calls.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

// Defaults to `true` (hydrated) so every pre-existing test below, which
// assumes "Create Workspace" opens normally, is unaffected by Stage 10's
// hydration-race fix — only the dedicated tests further down override
// this to `false` to exercise the pre-hydration state itself.
vi.mock("@/hooks/useHydrated", () => ({
  useHydrated: vi.fn(() => true),
}));

import { WorkspaceDashboard, type WorkspaceSummary } from "@/components/shared/workspace-dashboard";
import { useHydrated } from "@/hooks/useHydrated";

// Restores the module-level default (hydrated) after every test, so the
// two Stage 10 hydration-race tests' own `false` override can never leak
// into an unrelated test regardless of execution order.
afterEach(() => {
  vi.mocked(useHydrated).mockReturnValue(true);
});

function workspace(overrides: Partial<WorkspaceSummary> = {}): WorkspaceSummary {
  return {
    id: "ws-1",
    name: "Operating Systems",
    createdAt: "2026-01-15T00:00:00.000Z",
    materialCount: 1,
    readyCount: 0,
    pdfCount: 1,
    videoCount: 0,
    ...overrides,
  };
}

describe("WorkspaceDashboard — Stage 10 (dashboard material-count chip refresh)", () => {
  it("picks up a processing -> ready transition when initialWorkspaces changes on a re-render, with no user action", () => {
    const { rerender } = render(
      <WorkspaceDashboard userName="Sample Student" initialWorkspaces={[workspace({ materialCount: 1, readyCount: 0 })]} />
    );
    expect(screen.getByText("1 processing")).toBeInTheDocument();

    rerender(
      <WorkspaceDashboard userName="Sample Student" initialWorkspaces={[workspace({ materialCount: 1, readyCount: 1 })]} />
    );

    expect(screen.queryByText("1 processing")).not.toBeInTheDocument();
  });

  it("picks up a brand-new workspace appearing in initialWorkspaces on a re-render", () => {
    const { rerender } = render(<WorkspaceDashboard userName="Sample Student" initialWorkspaces={[]} />);
    expect(screen.getByText("You don't have any workspaces yet.")).toBeInTheDocument();

    rerender(
      <WorkspaceDashboard userName="Sample Student" initialWorkspaces={[workspace({ name: "DBMS" })]} />
    );

    expect(screen.getByText("DBMS")).toBeInTheDocument();
    expect(screen.getByText("1 workspace.")).toBeInTheDocument();
  });

  it("picks up a workspace disappearing from initialWorkspaces on a re-render (deleted elsewhere)", () => {
    const { rerender } = render(
      <WorkspaceDashboard userName="Sample Student" initialWorkspaces={[workspace({ id: "ws-1", name: "DBMS" })]} />
    );
    expect(screen.getByText("DBMS")).toBeInTheDocument();

    rerender(<WorkspaceDashboard userName="Sample Student" initialWorkspaces={[]} />);

    expect(screen.queryByText("DBMS")).not.toBeInTheDocument();
    expect(screen.getByText("You don't have any workspaces yet.")).toBeInTheDocument();
  });

  it("a data re-sync from a changed initialWorkspaces prop does not reset unrelated local UI state (e.g. an in-progress search)", async () => {
    const user = userEvent.setup();
    const ws = workspace();
    const { rerender } = render(
      <WorkspaceDashboard userName="Sample Student" initialWorkspaces={[ws, workspace({ id: "ws-2", name: "DBMS" })]} />
    );

    await user.type(screen.getByPlaceholderText(/search/i), "Operating");
    expect(screen.getByText("Operating Systems")).toBeInTheDocument();
    expect(screen.queryByText("DBMS")).not.toBeInTheDocument(); // filtered out by the search

    // A genuinely new `initialWorkspaces` array (exactly what a fresh
    // router.refresh()-triggered SSR pass produces) must be picked up as
    // a plain data re-sync, not a full remount that would wipe the
    // in-progress search text the user already typed.
    rerender(
      <WorkspaceDashboard
        userName="Sample Student"
        initialWorkspaces={[{ ...ws, readyCount: 1 }, workspace({ id: "ws-2", name: "DBMS" })]}
      />
    );

    expect(screen.getByPlaceholderText(/search/i)).toHaveValue("Operating");
    expect(screen.getByText("Operating Systems")).toBeInTheDocument();
    expect(screen.queryByText("DBMS")).not.toBeInTheDocument();
  });
});

/**
 * Stage 10 — regression tests for a live-reproduced bug: clicking "Create
 * Workspace" as the very first interaction on a freshly-loaded page
 * silently did nothing (opened only on a second click) — a hydration race
 * where the native DOM click event could arrive before React finished
 * attaching this button's handler. Fixed via `useHydrated()` (hooks/
 * useHydrated.ts), which disables the trigger until hydration is
 * guaranteed complete. `useHydrated` is mocked here so both states
 * (pre-/post-hydration) are deterministically testable without needing a
 * real SSR-then-hydrate two-pass render, which jsdom/RTL's `render()`
 * (a plain client render, not `hydrateRoot`) cannot exercise directly.
 */
describe("WorkspaceDashboard — Stage 10 (first-click hydration race)", () => {
  it("disables Create Workspace before hydration completes, so a too-early click cannot be silently lost", () => {
    vi.mocked(useHydrated).mockReturnValue(false);

    render(<WorkspaceDashboard userName="Sample Student" initialWorkspaces={[]} />);

    expect(screen.getByRole("button", { name: "Create Workspace" })).toBeDisabled();
  });

  it("enables Create Workspace once hydration is complete", () => {
    vi.mocked(useHydrated).mockReturnValue(true);

    render(<WorkspaceDashboard userName="Sample Student" initialWorkspaces={[]} />);

    expect(screen.getByRole("button", { name: "Create Workspace" })).toBeEnabled();
  });
});
