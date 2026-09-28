import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * Tests the Dashboard Shell (Accion Labs Requirement 1.1-1.4). Mocks the
 * three heavy child panels (WorkspaceFiles, VideoPlayer, ChatPanel) and
 * useWorkspaceInit — their own real behavior is already covered by their
 * dedicated test files; these tests verify the SHELL's own job: which
 * panels render where, tab switching, and that useWorkspaceInit is
 * actually invoked with the right arguments (the exact gap the audit
 * found: it existed but was never called in production).
 */

const useWorkspaceInitMock = vi.fn();

vi.mock("@/hooks/useWorkspaceInit", () => ({
  useWorkspaceInit: (...args: unknown[]) => useWorkspaceInitMock(...args),
}));

let filesShouldThrow = false;

vi.mock("@/components/shared/workspace-files", () => ({
  WorkspaceFiles: ({ workspaceId }: { workspaceId: string }) => {
    if (filesShouldThrow) {
      throw new Error("Simulated Files panel crash");
    }
    return <div data-testid="mock-files">Files for {workspaceId}</div>;
  },
}));

let videoShouldThrow = false;

vi.mock("@/components/video/VideoPlayer", () => ({
  VideoPlayer: ({ title }: { title: string }) => {
    if (videoShouldThrow) {
      throw new Error("Simulated Video panel crash");
    }
    return <div data-testid="mock-video">Video: {title}</div>;
  },
}));

let chatShouldThrow = false;

vi.mock("@/components/chat/ChatPanel", () => ({
  ChatPanel: ({ workspaceId }: { workspaceId: string }) => {
    if (chatShouldThrow) {
      throw new Error("Simulated Chat panel crash");
    }
    return <div data-testid="mock-chat">Chat for {workspaceId}</div>;
  },
}));

// Step 5 (persistent chat history): ConversationSidebar uses React Query's
// useQuery for real, which throws without a QueryClientProvider ancestor —
// none of these shell tests provide one (they test the shell's own job:
// which panels render where, tab switching, error-boundary isolation), so
// a real ConversationSidebar would trip the Chat panel's own
// PanelErrorBoundary and fail every "mock-chat is present" assertion here.
// Mocked with the same lightweight stand-in convention as its three
// siblings above — ConversationSidebar's own real behavior is covered by
// tests/component/ConversationSidebar.test.tsx.
vi.mock("@/components/shared/ConversationSidebar", () => ({
  ConversationSidebar: ({ workspaceId }: { workspaceId: string }) => (
    <div data-testid="mock-conversation-sidebar">Conversations for {workspaceId}</div>
  ),
}));

import { WorkspaceDashboardShell } from "@/components/shared/workspace-dashboard-shell";

const initialVideoFile = {
  id: "file-1",
  originalName: "Lecture.mp4",
  type: "video" as const,
  status: "ready" as const,
  processingError: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  storageUrl: "https://example.test/lecture.mp4",
  sizeBytes: 1000,
};

beforeEach(() => {
  vi.clearAllMocks();
  chatShouldThrow = false;
  videoShouldThrow = false;
  filesShouldThrow = false;
});

describe("WorkspaceDashboardShell — Requirement 1.2 (useWorkspaceInit wiring)", () => {
  it("invokes useWorkspaceInit with the workspace id and seeded initial data on mount", () => {
    render(
      <WorkspaceDashboardShell
        workspaceId="ws-1"
        workspaceName="DBMS"
        initialMaterials={[]}
        initialVideoFile={undefined}
      />
    );

    expect(useWorkspaceInitMock).toHaveBeenCalledWith("ws-1", { id: "ws-1", name: "DBMS" });
  });
});

describe("WorkspaceDashboardShell — Requirement 1.1 (all three panels present)", () => {
  it("renders Files, Video, and Chat panels all in the DOM at once", () => {
    render(
      <WorkspaceDashboardShell
        workspaceId="ws-1"
        workspaceName="DBMS"
        initialMaterials={[]}
        initialVideoFile={initialVideoFile}
      />
    );

    // All three exist in the DOM simultaneously — the responsive grid
    // shows all of them at md+ widths; only the mobile tab logic hides
    // the non-active ones via CSS, so this proves the actual requirement
    // ("render three primary panels") independent of viewport.
    expect(screen.getByTestId("mock-files")).toBeInTheDocument();
    expect(screen.getByTestId("mock-video")).toBeInTheDocument();
    expect(screen.getByTestId("mock-chat")).toBeInTheDocument();
  });
});

describe("WorkspaceDashboardShell — Requirement 1.3 (mobile tab navigation)", () => {
  it("shows tab navigation with Video, AI Tutor, and Materials tabs", () => {
    render(
      <WorkspaceDashboardShell
        workspaceId="ws-1"
        workspaceName="DBMS"
        initialMaterials={[]}
        initialVideoFile={initialVideoFile}
      />
    );

    expect(screen.getByRole("tab", { name: "Video" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "AI Tutor" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Materials" })).toBeInTheDocument();
  });

  it("defaults to the Video tab being selected", () => {
    render(
      <WorkspaceDashboardShell
        workspaceId="ws-1"
        workspaceName="DBMS"
        initialMaterials={[]}
        initialVideoFile={initialVideoFile}
      />
    );

    expect(screen.getByRole("tab", { name: "Video" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Materials" })).toHaveAttribute("aria-selected", "false");
  });

  it("activating the AI Tutor tab marks it selected and marks Video unselected", async () => {
    const user = userEvent.setup();
    render(
      <WorkspaceDashboardShell
        workspaceId="ws-1"
        workspaceName="DBMS"
        initialMaterials={[]}
        initialVideoFile={initialVideoFile}
      />
    );

    await user.click(screen.getByRole("tab", { name: "AI Tutor" }));

    expect(screen.getByRole("tab", { name: "AI Tutor" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Video" })).toHaveAttribute("aria-selected", "false");
  });

  it("activating the Materials tab marks it selected", async () => {
    const user = userEvent.setup();
    render(
      <WorkspaceDashboardShell
        workspaceId="ws-1"
        workspaceName="DBMS"
        initialMaterials={[]}
        initialVideoFile={initialVideoFile}
      />
    );

    await user.click(screen.getByRole("tab", { name: "Materials" }));

    expect(screen.getByRole("tab", { name: "Materials" })).toHaveAttribute("aria-selected", "true");
  });

  it("keyboard: ArrowRight moves selection to the next tab", async () => {
    const user = userEvent.setup();
    render(
      <WorkspaceDashboardShell
        workspaceId="ws-1"
        workspaceName="DBMS"
        initialMaterials={[]}
        initialVideoFile={initialVideoFile}
      />
    );

    const videoTab = screen.getByRole("tab", { name: "Video" });
    videoTab.focus();
    await user.keyboard("{ArrowRight}");

    expect(screen.getByRole("tab", { name: "AI Tutor" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "AI Tutor" })).toHaveFocus();
  });
});

describe("WorkspaceDashboardShell — Requirement 1.4 (accessible tab structure)", () => {
  it("each tab has aria-controls pointing to a real panel with a matching id", () => {
    render(
      <WorkspaceDashboardShell
        workspaceId="ws-1"
        workspaceName="DBMS"
        initialMaterials={[]}
        initialVideoFile={initialVideoFile}
      />
    );

    const videoTab = screen.getByRole("tab", { name: "Video" });
    const controlledId = videoTab.getAttribute("aria-controls");
    expect(controlledId).toBeTruthy();
    expect(document.getElementById(controlledId as string)).toHaveAttribute("role", "tabpanel");
  });

  it("only the active tab is in the natural tab order (roving tabindex)", () => {
    render(
      <WorkspaceDashboardShell
        workspaceId="ws-1"
        workspaceName="DBMS"
        initialMaterials={[]}
        initialVideoFile={initialVideoFile}
      />
    );

    expect(screen.getByRole("tab", { name: "Video" })).toHaveAttribute("tabIndex", "0");
    expect(screen.getByRole("tab", { name: "AI Tutor" })).toHaveAttribute("tabIndex", "-1");
    expect(screen.getByRole("tab", { name: "Materials" })).toHaveAttribute("tabIndex", "-1");
  });
});

describe("WorkspaceDashboardShell — Test 5/6: real PanelErrorBoundary integration (Requirement 1.5)", () => {
  it("Test 5 — the real Dashboard wraps panels with independent boundaries: a Chat crash shows Chat's error UI while Files/Video keep rendering", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    chatShouldThrow = true;

    render(
      <WorkspaceDashboardShell
        workspaceId="ws-1"
        workspaceName="DBMS"
        initialMaterials={[]}
        initialVideoFile={initialVideoFile}
      />
    );

    expect(
      screen.getByText("Something went wrong while loading this panel.")
    ).toBeInTheDocument();
    expect(screen.queryByTestId("mock-chat")).not.toBeInTheDocument();
    // Files and Video are untouched, independent subtrees — this is the
    // real WorkspaceDashboardShell + real PanelErrorBoundary, not a
    // standalone fake example.
    expect(screen.getByTestId("mock-files")).toBeInTheDocument();
    expect(screen.getByTestId("mock-video")).toBeInTheDocument();

    vi.restoreAllMocks();
  });

  it("Property 19 — a Video crash shows Video's error UI while Files/Chat keep rendering", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    videoShouldThrow = true;

    render(
      <WorkspaceDashboardShell
        workspaceId="ws-1"
        workspaceName="DBMS"
        initialMaterials={[]}
        initialVideoFile={initialVideoFile}
      />
    );

    expect(
      screen.getByText("Something went wrong while loading this panel.")
    ).toBeInTheDocument();
    expect(screen.queryByTestId("mock-video")).not.toBeInTheDocument();
    expect(screen.getByTestId("mock-files")).toBeInTheDocument();
    expect(screen.getByTestId("mock-chat")).toBeInTheDocument();

    vi.restoreAllMocks();
  });

  it("Property 19 — a Files crash shows Files' error UI while Video/Chat keep rendering", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    filesShouldThrow = true;

    render(
      <WorkspaceDashboardShell
        workspaceId="ws-1"
        workspaceName="DBMS"
        initialMaterials={[]}
        initialVideoFile={initialVideoFile}
      />
    );

    expect(
      screen.getByText("Something went wrong while loading this panel.")
    ).toBeInTheDocument();
    expect(screen.queryByTestId("mock-files")).not.toBeInTheDocument();
    expect(screen.getByTestId("mock-video")).toBeInTheDocument();
    expect(screen.getByTestId("mock-chat")).toBeInTheDocument();

    vi.restoreAllMocks();
  });

  it("Property 19 — Retry recovers a crashed panel without affecting its siblings", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    videoShouldThrow = true;
    const user = userEvent.setup();

    render(
      <WorkspaceDashboardShell
        workspaceId="ws-1"
        workspaceName="DBMS"
        initialMaterials={[]}
        initialVideoFile={initialVideoFile}
      />
    );

    expect(
      screen.getByText("Something went wrong while loading this panel.")
    ).toBeInTheDocument();

    videoShouldThrow = false;
    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(screen.getByTestId("mock-video")).toBeInTheDocument();
    expect(screen.getByTestId("mock-files")).toBeInTheDocument();
    expect(screen.getByTestId("mock-chat")).toBeInTheDocument();

    vi.restoreAllMocks();
  });

  it("Test 6 — normal rendering (no errors) is completely unaffected by adding error boundaries", () => {
    render(
      <WorkspaceDashboardShell
        workspaceId="ws-1"
        workspaceName="DBMS"
        initialMaterials={[]}
        initialVideoFile={initialVideoFile}
      />
    );

    expect(screen.getByTestId("mock-files")).toBeInTheDocument();
    expect(screen.getByTestId("mock-video")).toBeInTheDocument();
    expect(screen.getByTestId("mock-chat")).toBeInTheDocument();
    expect(
      screen.queryByText("Something went wrong while loading this panel.")
    ).not.toBeInTheDocument();
  });
});

describe("WorkspaceDashboardShell — Test 7: mobile tab navigation unaffected by error boundaries", () => {
  it("tab switching still works correctly when a sibling panel has crashed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    chatShouldThrow = true;
    const user = userEvent.setup();

    render(
      <WorkspaceDashboardShell
        workspaceId="ws-1"
        workspaceName="DBMS"
        initialMaterials={[]}
        initialVideoFile={initialVideoFile}
      />
    );

    // Chat has crashed, but switching to the Materials tab must still work
    // normally — the boundary around Chat doesn't affect tab navigation
    // itself, which lives outside any single panel's boundary.
    await user.click(screen.getByRole("tab", { name: "Materials" }));
    expect(screen.getByRole("tab", { name: "Materials" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("mock-files")).toBeInTheDocument();

    vi.restoreAllMocks();
  });
});
