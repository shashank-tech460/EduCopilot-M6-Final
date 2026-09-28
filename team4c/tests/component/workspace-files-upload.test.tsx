import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

// Defaults to `true` (hydrated) so every pre-existing test below, which
// assumes "Add Material" opens normally, is unaffected by Stage 10's
// hydration-race fix — only the dedicated tests further down override
// this to `false` to exercise the pre-hydration state itself.
vi.mock("@/hooks/useHydrated", () => ({
  useHydrated: vi.fn(() => true),
}));

import { WorkspaceFiles } from "@/components/shared/workspace-files";
import { useAppStore } from "@/store/appStore";
import { MAX_PDF_SIZE_BYTES, MAX_VIDEO_SIZE_BYTES } from "@/lib/validation";
import { useHydrated } from "@/hooks/useHydrated";

afterEach(() => {
  vi.mocked(useHydrated).mockReturnValue(true);
});

/**
 * Tests the Task 6.1 upload behavior: client-side pre-validation
 * (Requirement 5.4 / Property 8) and failed-upload retry without
 * reselecting the file (Property 18). XMLHttpRequest is mocked — jsdom's
 * real implementation would attempt an actual network request.
 */

class MockXHR {
  static instances: MockXHR[] = [];
  upload = { onprogress: null as ((e: ProgressEvent) => void) | null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  status = 0;
  responseText = "";
  sentBody: FormData | null = null;

  open() {}
  send(body: FormData) {
    this.sentBody = body;
    MockXHR.instances.push(this);
  }

  respondSuccess(data: Record<string, unknown>) {
    this.status = 201;
    this.responseText = JSON.stringify(data);
    this.onload?.();
  }

  respondFailure(status: number, data: Record<string, unknown>) {
    this.status = status;
    this.responseText = JSON.stringify(data);
    this.onload?.();
  }
}

function pdfFile(name: string, sizeBytes: number): globalThis.File {
  const file = new File(["x".repeat(Math.min(sizeBytes, 10))], name, { type: "application/pdf" });
  Object.defineProperty(file, "size", { value: sizeBytes });
  return file;
}

function mp4File(name: string, sizeBytes: number): globalThis.File {
  const file = new File(["x".repeat(Math.min(sizeBytes, 10))], name, { type: "video/mp4" });
  Object.defineProperty(file, "size", { value: sizeBytes });
  return file;
}

beforeEach(() => {
  MockXHR.instances = [];
  vi.stubGlobal("XMLHttpRequest", MockXHR);
  useAppStore.getState().clearUploads();
});

describe("WorkspaceFiles — Requirement 5.4 / Property 8 (validate before initiating upload)", () => {
  it("rejects an oversized PDF client-side and never opens an XHR request", async () => {
    const user = userEvent.setup();
    render(<WorkspaceFiles workspaceId="ws-1" initialMaterials={[]} />);

    await user.click(screen.getByRole("button", { name: "Add Material" }));
    const input = screen.getByLabelText("PDF file");
    const oversized = pdfFile("huge.pdf", MAX_PDF_SIZE_BYTES + 1);
    await user.upload(input, oversized);
    await user.click(screen.getByRole("button", { name: "Add Material" }));

    expect(MockXHR.instances).toHaveLength(0);
    expect(screen.getByText("PDF must be 50MB or smaller.")).toBeInTheDocument();
  });

  it("rejects an oversized MP4 client-side and never opens an XHR request", async () => {
    const user = userEvent.setup();
    render(<WorkspaceFiles workspaceId="ws-1" initialMaterials={[]} />);

    await user.click(screen.getByRole("button", { name: "Add Material" }));
    await user.click(screen.getByRole("button", { name: "Upload MP4" }));
    const input = screen.getByLabelText("MP4 file");
    const oversized = mp4File("huge.mp4", MAX_VIDEO_SIZE_BYTES + 1);
    await user.upload(input, oversized);
    await user.click(screen.getByRole("button", { name: "Add Material" }));

    expect(MockXHR.instances).toHaveLength(0);
    expect(screen.getByText("Video must be 500MB or smaller.")).toBeInTheDocument();
  });

  it("does not initiate an upload with no file selected", async () => {
    const user = userEvent.setup();
    render(<WorkspaceFiles workspaceId="ws-1" initialMaterials={[]} />);

    await user.click(screen.getByRole("button", { name: "Add Material" }));
    await user.click(screen.getByRole("button", { name: "Add Material" }));

    expect(MockXHR.instances).toHaveLength(0);
    expect(screen.getByText("Choose a file first.")).toBeInTheDocument();
  });

  it("initiates a real upload for a valid PDF", async () => {
    const user = userEvent.setup();
    render(<WorkspaceFiles workspaceId="ws-1" initialMaterials={[]} />);

    await user.click(screen.getByRole("button", { name: "Add Material" }));
    const input = screen.getByLabelText("PDF file");
    await user.upload(input, pdfFile("notes.pdf", 1024));
    await user.click(screen.getByRole("button", { name: "Add Material" }));

    expect(MockXHR.instances).toHaveLength(1);
    expect(MockXHR.instances[0].sentBody?.get("type")).toBe("pdf");
  });
});

describe("WorkspaceFiles — Property 9 (live progress reflected in UI)", () => {
  it("shows the UploadTracker with live progress as xhr.upload.onprogress fires", async () => {
    const user = userEvent.setup();
    render(<WorkspaceFiles workspaceId="ws-1" initialMaterials={[]} />);

    await user.click(screen.getByRole("button", { name: "Add Material" }));
    await user.upload(screen.getByLabelText("PDF file"), pdfFile("notes.pdf", 1000));
    await user.click(screen.getByRole("button", { name: "Add Material" }));

    const xhr = MockXHR.instances[0];
    act(() => {
      xhr.upload.onprogress?.({ lengthComputable: true, loaded: 500, total: 1000 } as ProgressEvent);
    });

    // Property 9 requires all of: filename, percentage, progress bar, ETA.
    // Asserting only percentage (as a narrower earlier version of this
    // test did) would let a regression removing the filename, the
    // progressbar element, or the ETA text pass unnoticed.
    const tracker = await screen.findByTestId("upload-tracker");
    await waitFor(() => expect(tracker).toHaveTextContent("50%"));
    expect(tracker).toHaveTextContent("notes.pdf");
    expect(within(tracker).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "50");
    expect(tracker.textContent).toMatch(/Calculating…|remaining|Almost done/);
  });
});

describe("WorkspaceFiles — Property 18 (failed upload retention + retry without reselecting)", () => {
  it("keeps the File reference after a failed upload and Retry re-sends the same file without reopening the picker", async () => {
    const user = userEvent.setup();
    render(<WorkspaceFiles workspaceId="ws-1" initialMaterials={[]} />);

    await user.click(screen.getByRole("button", { name: "Add Material" }));
    await user.upload(screen.getByLabelText("PDF file"), pdfFile("notes.pdf", 1000));
    await user.click(screen.getByRole("button", { name: "Add Material" }));

    // Dialog closes immediately (upload proceeds in the background,
    // tracked by UploadTracker) — the file picker is gone at this point.
    expect(screen.queryByLabelText("PDF file")).not.toBeInTheDocument();

    const firstXhr = MockXHR.instances[0];
    act(() => {
      firstXhr.respondFailure(500, { error: "Something went wrong." });
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    });

    // The original File object must still be retained in the store for
    // Retry to work without the user reselecting anything.
    const uploadId = Object.keys(useAppStore.getState().uploads)[0];
    expect(useAppStore.getState().uploads[uploadId].fileRef?.name).toBe("notes.pdf");

    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(MockXHR.instances).toHaveLength(2);
    expect(MockXHR.instances[1].sentBody?.get("file")).toEqual(
      expect.objectContaining({ name: "notes.pdf" })
    );

    act(() => {
      MockXHR.instances[1].respondSuccess({
        id: "f1",
        originalName: "notes.pdf",
        type: "pdf",
        status: "uploading",
        processingError: null,
        createdAt: new Date().toISOString(),
        storageUrl: "https://example.test/notes.pdf",
        sizeBytes: 1000,
      });
    });

    await waitFor(() => {
      expect(screen.getByText("notes.pdf")).toBeInTheDocument();
      expect(screen.queryByTestId("upload-tracker")).not.toBeInTheDocument();
    });
  });
});

describe("WorkspaceFiles — Stage 9 (upload idempotency key)", () => {
  it("sends uploadIdempotencyKey (the upload's own tracker id) in the FormData for a new upload", async () => {
    const user = userEvent.setup();
    render(<WorkspaceFiles workspaceId="ws-1" initialMaterials={[]} />);

    await user.click(screen.getByRole("button", { name: "Add Material" }));
    await user.upload(screen.getByLabelText("PDF file"), pdfFile("notes.pdf", 1000));
    await user.click(screen.getByRole("button", { name: "Add Material" }));

    const uploadId = Object.keys(useAppStore.getState().uploads)[0];
    expect(uploadId).toBeTruthy();
    expect(MockXHR.instances[0].sentBody?.get("uploadIdempotencyKey")).toBe(uploadId);
  });

  it("Retry resends the SAME uploadIdempotencyKey as the original attempt, never a new one — this is what lets the server recognize a retry instead of creating a duplicate File", async () => {
    const user = userEvent.setup();
    render(<WorkspaceFiles workspaceId="ws-1" initialMaterials={[]} />);

    await user.click(screen.getByRole("button", { name: "Add Material" }));
    await user.upload(screen.getByLabelText("PDF file"), pdfFile("notes.pdf", 1000));
    await user.click(screen.getByRole("button", { name: "Add Material" }));

    const firstKey = MockXHR.instances[0].sentBody?.get("uploadIdempotencyKey");
    act(() => {
      MockXHR.instances[0].respondFailure(500, { error: "Something went wrong." });
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(MockXHR.instances).toHaveLength(2);
    const secondKey = MockXHR.instances[1].sentBody?.get("uploadIdempotencyKey");
    expect(secondKey).toBe(firstKey);
    expect(secondKey).toBeTruthy();
  });

  it("a transport-successful (2xx) response carrying status: 'failed' is never reported as a plain success — the material still appears, with its own Retry option, and the upload tracker is cleared", async () => {
    const user = userEvent.setup();
    render(<WorkspaceFiles workspaceId="ws-1" initialMaterials={[]} />);

    await user.click(screen.getByRole("button", { name: "Add Material" }));
    await user.upload(screen.getByLabelText("PDF file"), pdfFile("notes.pdf", 1000));
    await user.click(screen.getByRole("button", { name: "Add Material" }));

    act(() => {
      MockXHR.instances[0].respondSuccess({
        id: "f1",
        originalName: "notes.pdf",
        type: "pdf",
        status: "failed",
        processingError: "This file is already being processed. Please wait a moment, then refresh and try again.",
        createdAt: new Date().toISOString(),
        storageUrl: "https://example.test/notes.pdf",
        sizeBytes: 1000,
      });
    });

    await waitFor(() => {
      expect(screen.queryByTestId("upload-tracker")).not.toBeInTheDocument();
      expect(screen.getByText("notes.pdf")).toBeInTheDocument();
    });
    expect(screen.getByText(/already being processed/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});

describe("WorkspaceFiles — Stage 9 (retry ingestion for an already-uploaded failed material, no re-upload)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("clicking Retry on a failed material calls the retry endpoint (no bytes, no FormData) and updates its status on success", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "f1",
        originalName: "notes.pdf",
        type: "pdf",
        status: "ready",
        processingError: null,
        createdAt: "2026-01-15T00:00:00.000Z",
        storageUrl: "https://example.test/notes.pdf",
        sizeBytes: 1000,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <WorkspaceFiles
        workspaceId="ws-1"
        initialMaterials={[
          {
            id: "f1",
            originalName: "notes.pdf",
            type: "pdf",
            status: "failed",
            processingError: "Something went wrong while processing your file. Please try again.",
            createdAt: "2026-01-15T00:00:00.000Z",
            storageUrl: "https://example.test/notes.pdf",
            sizeBytes: 1000,
          },
        ]}
      />
    );

    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(fetchMock).toHaveBeenCalledWith("/api/workspaces/ws-1/files/f1/retry", { method: "POST" });
    await waitFor(() => expect(screen.getByText("Ready")).toBeInTheDocument());
  });

  it("disables the Retry button for the duration of the request, so a rapid double-click can't fire it twice", async () => {
    const user = userEvent.setup();
    let resolveFetch: (value: unknown) => void = () => {};
    const fetchMock = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <WorkspaceFiles
        workspaceId="ws-1"
        initialMaterials={[
          {
            id: "f1",
            originalName: "notes.pdf",
            type: "pdf",
            status: "failed",
            processingError: "Something went wrong while processing your file. Please try again.",
            createdAt: "2026-01-15T00:00:00.000Z",
            storageUrl: "https://example.test/notes.pdf",
            sizeBytes: 1000,
          },
        ]}
      />
    );

    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(screen.getByRole("button", { name: "Retrying…" })).toBeDisabled();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFetch({
      ok: true,
      json: async () => ({
        id: "f1",
        originalName: "notes.pdf",
        type: "pdf",
        status: "ready",
        processingError: null,
        createdAt: "2026-01-15T00:00:00.000Z",
        storageUrl: "https://example.test/notes.pdf",
        sizeBytes: 1000,
      }),
    });

    await waitFor(() => expect(screen.getByText("Ready")).toBeInTheDocument());
  });
});

describe("WorkspaceFiles — Requirement 5.6 (file list metadata)", () => {
  it("displays name, type, size, upload date, and status for an existing material", () => {
    render(
      <WorkspaceFiles
        workspaceId="ws-1"
        initialMaterials={[
          {
            id: "f1",
            originalName: "Lecture12.pdf",
            type: "pdf",
            status: "ready",
            processingError: null,
            createdAt: "2026-01-15T00:00:00.000Z",
            storageUrl: "https://example.test/lecture12.pdf",
            sizeBytes: 2 * 1024 * 1024,
          },
        ]}
      />
    );

    expect(screen.getByText("Lecture12.pdf")).toBeInTheDocument();
    expect(screen.getByText("PDF")).toBeInTheDocument();
    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.getByText("2.0 MB")).toBeInTheDocument();
    expect(screen.getByText("Jan 15, 2026")).toBeInTheDocument();
  });

  it("does not render a size for a YouTube URL material, which has no local bytes", () => {
    render(
      <WorkspaceFiles
        workspaceId="ws-1"
        initialMaterials={[
          {
            id: "f2",
            originalName: "https://youtu.be/dQw4w9WgXcQ",
            type: "youtube_url",
            status: "ready",
            processingError: null,
            createdAt: "2026-01-15T00:00:00.000Z",
            storageUrl: "https://youtu.be/dQw4w9WgXcQ",
            sizeBytes: null,
          },
        ]}
      />
    );

    expect(screen.getByText("YouTube")).toBeInTheDocument();
    expect(screen.queryByText(/MB|KB|B$/)).not.toBeInTheDocument();
  });
});

/**
 * Stage 10 — regression tests for the reported "Learning Materials panel
 * refresh" bug. Root cause (confirmed by reading the component): `materials`
 * is seeded once from `initialMaterials` via a plain `useState` initializer,
 * which React never re-runs on a later prop change, so a material whose
 * ingestion finishes asynchronously in the background stayed stuck showing
 * "Processing…" forever — no `router.refresh()` call anywhere in this file
 * actually reached this component's own state. The fix polls
 * `GET /api/workspaces/{id}/files` while any material is non-terminal.
 * 4000 here matches `LEARNING_MATERIALS_POLL_INTERVAL_MS` in the component
 * (not exported — these tests treat it as an implementation detail and just
 * advance past it).
 */
describe("WorkspaceFiles — Stage 10 (Learning Materials panel refresh)", () => {
  const POLL_INTERVAL_MS = 4000;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("picks up a processing -> ready transition on its own, with no router.refresh()-triggering action", async () => {
    const processingMaterial = {
      id: "f1",
      originalName: "Lecture.pdf",
      type: "pdf" as const,
      status: "processing" as const,
      processingError: null,
      createdAt: "2026-01-15T00:00:00.000Z",
      storageUrl: "https://example.test/lecture.pdf",
      sizeBytes: 1024,
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ ...processingMaterial, status: "ready" }],
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<WorkspaceFiles workspaceId="ws-1" initialMaterials={[processingMaterial]} />);
    expect(screen.getByText("Processing…")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/workspaces/ws-1/files");
    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.queryByText("Processing…")).not.toBeInTheDocument();
  });

  it("never polls when every material is already in a terminal state", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(
      <WorkspaceFiles
        workspaceId="ws-1"
        initialMaterials={[
          {
            id: "f1",
            originalName: "Lecture.pdf",
            type: "pdf",
            status: "ready",
            processingError: null,
            createdAt: "2026-01-15T00:00:00.000Z",
            storageUrl: "https://example.test/lecture.pdf",
            sizeBytes: 1024,
          },
          {
            id: "f2",
            originalName: "Broken.pdf",
            type: "pdf",
            status: "failed",
            processingError: "Corrupt file.",
            createdAt: "2026-01-15T00:00:00.000Z",
            storageUrl: "https://example.test/broken.pdf",
            sizeBytes: 1024,
          },
        ]}
      />
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stops polling once the last non-terminal material settles", async () => {
    const processingMaterial = {
      id: "f1",
      originalName: "Lecture.pdf",
      type: "pdf" as const,
      status: "processing" as const,
      processingError: null,
      createdAt: "2026-01-15T00:00:00.000Z",
      storageUrl: "https://example.test/lecture.pdf",
      sizeBytes: 1024,
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ ...processingMaterial, status: "ready" }],
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<WorkspaceFiles workspaceId="ws-1" initialMaterials={[processingMaterial]} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 4);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a transient poll failure does not crash the panel and the next tick still resolves it", async () => {
    const processingMaterial = {
      id: "f1",
      originalName: "Lecture.pdf",
      type: "pdf" as const,
      status: "processing" as const,
      processingError: null,
      createdAt: "2026-01-15T00:00:00.000Z",
      storageUrl: "https://example.test/lecture.pdf",
      sizeBytes: 1024,
    };
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("network blip"))
      .mockResolvedValueOnce({ ok: true, json: async () => [{ ...processingMaterial, status: "ready" }] });
    vi.stubGlobal("fetch", fetchMock);

    render(<WorkspaceFiles workspaceId="ws-1" initialMaterials={[processingMaterial]} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    });
    expect(screen.getByText("Processing…")).toBeInTheDocument(); // first tick failed, still pending

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    });
    expect(screen.getByText("Ready")).toBeInTheDocument();
  });
});

/**
 * Stage 10 — regression tests for a live-reproduced bug: clicking "Add
 * Material" as the very first interaction on a freshly-loaded workspace
 * page silently did nothing (opened only on a second click) — a
 * hydration race where the native DOM click event could arrive before
 * React finished attaching this button's handler. Fixed via
 * `useHydrated()` (hooks/useHydrated.ts), which disables the trigger
 * until hydration is guaranteed complete. Mocked here for the same
 * reason as workspace-dashboard.test.tsx's own version of this test.
 */
describe("WorkspaceFiles — Stage 10 (first-click hydration race)", () => {
  it("disables Add Material before hydration completes, so a too-early click cannot be silently lost", () => {
    vi.mocked(useHydrated).mockReturnValue(false);

    render(<WorkspaceFiles workspaceId="ws-1" initialMaterials={[]} />);

    expect(screen.getByRole("button", { name: "Add Material" })).toBeDisabled();
  });

  it("enables Add Material once hydration is complete", () => {
    vi.mocked(useHydrated).mockReturnValue(true);

    render(<WorkspaceFiles workspaceId="ws-1" initialMaterials={[]} />);

    expect(screen.getByRole("button", { name: "Add Material" })).toBeEnabled();
  });
});
