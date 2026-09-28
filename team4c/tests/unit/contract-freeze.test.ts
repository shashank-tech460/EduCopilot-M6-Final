// @vitest-environment node
//
// realTeamA.submit() now performs real ES256 signing via `jose`
// (lib/serviceJwt.ts) -- confirmed elsewhere (tests/unit/serviceJwt.test.ts)
// that this fails under the project's default jsdom environment. This
// per-file override does not affect the realTeamB tests below, which do
// no crypto work and run identically under either environment.
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { generateKeyPair, exportPKCS8 } from "jose";

/**
 * Phase 2A/2D contract freeze — proves the REAL Team A/Team B clients
 * (services/teamA/client.ts, services/teamB/client.ts) serialize exactly
 * the canonical, frozen request bodies onto the wire, and nothing else.
 *
 * This is deliberately a serialization test against the REAL clients, not
 * the mocks (already covered by tests/unit/teamA-mock.test.ts and
 * tests/unit/teamB-mock.test.ts) — those exercise local simulation logic,
 * this exercises the exact bytes a real Team A/Team B backend would
 * receive over HTTP.
 */

const originalEnv = { ...process.env };
const TEST_IDENTITY = { sub: "user-1", workspace_id: "6aa1c4d537e42519bd73e1cc" };

beforeEach(async () => {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  process.env.TEAM_A_API_URL = "https://team-a.example.test";
  process.env.SERVICE_JWT_PRIVATE_KEY = await exportPKCS8(privateKey);
  process.env.SERVICE_JWT_KID = "test-kid-1";
  process.env.SERVICE_JWT_ISSUER = "https://educopilot.internal";
  process.env.TEAM_B_API_URL = "https://team-b.example.test";
  process.env.TEAM_B_API_KEY = "test-key-b";
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  process.env = { ...originalEnv };
});

describe("Team A canonical ingestion contract (POST /v1/ingest)", () => {
  it("serializes exactly {document_id, file_type, file_url} and nothing else", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ingestionId: "job-123" }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    const { realTeamA } = await import("@/services/teamA/client");

    await realTeamA.submit(
      {
        document_id: "6aa1c4d537e42519bd73e1cc",
        file_type: "pdf",
        file_url: "https://storage.example.test/lecture.pdf",
      },
      TEST_IDENTITY
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [calledUrl, options] = fetchSpy.mock.calls[0];
    const sentBody = JSON.parse(options.body as string);

    // Phase 2D: the real endpoint, and a real Bearer JWT (never a static API key).
    expect(calledUrl).toBe("https://team-a.example.test/v1/ingest");
    expect(options.headers.Authorization).toMatch(/^Bearer ey/); // a real JWT, not a static key
    expect(options.headers.Authorization).not.toContain("test-key-a");

    expect(sentBody).toEqual({
      document_id: "6aa1c4d537e42519bd73e1cc",
      file_type: "pdf",
      file_url: "https://storage.example.test/lecture.pdf",
    });

    // The specific, named tenant fields the architecture forbids in this body.
    expect(sentBody).not.toHaveProperty("workspaceId");
    expect(sentBody).not.toHaveProperty("workspace_id");
    expect(sentBody).not.toHaveProperty("userId");
    expect(sentBody).not.toHaveProperty("user_id");
    // The JWT-minting identity must never leak into the wire body either.
    expect(sentBody).not.toHaveProperty("sub");
  });

  it("serializes correctly for every canonical file_type value", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ingestionId: "job-x" }) });
    vi.stubGlobal("fetch", fetchSpy);

    const { realTeamA } = await import("@/services/teamA/client");

    for (const fileType of ["pdf", "mp4", "youtube"] as const) {
      await realTeamA.submit({ document_id: "doc-1", file_type: fileType, file_url: "https://x.test/f" }, TEST_IDENTITY);
    }

    const sentTypes = fetchSpy.mock.calls.map((call: unknown[]) => JSON.parse((call[1] as RequestInit).body as string).file_type);
    expect(sentTypes).toEqual(["pdf", "mp4", "youtube"]);
  });
});

describe("toCanonicalFileType — internal File.type -> canonical file_type mapping", () => {
  it("maps every internal File.type value to its canonical equivalent", async () => {
    const { toCanonicalFileType } = await import("@/types/teamA");

    expect(toCanonicalFileType("pdf")).toBe("pdf");
    expect(toCanonicalFileType("video")).toBe("mp4");
    expect(toCanonicalFileType("youtube_url")).toBe("youtube");
  });
});

describe("Team B canonical query contract (POST /api/v1/query)", () => {
  it("serializes exactly {query, session_id, retrieval_config} and nothing else", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ answer: "an answer" }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    const { realTeamB } = await import("@/services/teamB/client");

    // Deliberately passes the mock-only fields too, to prove the real
    // client strips them rather than merely "happening" not to include
    // them because the caller omitted them.
    await realTeamB.query({
      query: "What is normalization?",
      session_id: "session-abc",
      retrieval_config: { top_k: 5 },
      workspaceId: "6aa1c4d537e42519bd73e1cc",
      videoTimestamp: 1935,
      sub: "user-1",
      workspace_id: "6aa1c4d537e42519bd73e1cc",
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [calledUrl, options] = fetchSpy.mock.calls[0];
    const sentBody = JSON.parse(options.body as string);

    expect(calledUrl).toBe("https://team-b.example.test/api/v1/query");
    expect(options.headers.Authorization).toMatch(/^Bearer ey/);
    expect(options.headers.Authorization).not.toContain("test-key-b");

    expect(sentBody).toEqual({
      query: "What is normalization?",
      session_id: "session-abc",
      retrieval_config: { top_k: 5 },
    });

    expect(sentBody).not.toHaveProperty("workspaceId");
    expect(sentBody).not.toHaveProperty("workspace_id");
    expect(sentBody).not.toHaveProperty("userId");
    expect(sentBody).not.toHaveProperty("user_id");
    expect(sentBody).not.toHaveProperty("videoTimestamp");
    expect(sentBody).not.toHaveProperty("sub");
  });

  it("serializes null session_id/retrieval_config correctly (no ragSessionId available yet)", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ answer: "hi" }) });
    vi.stubGlobal("fetch", fetchSpy);

    const { realTeamB } = await import("@/services/teamB/client");

    await realTeamB.query({
      query: "hello",
      session_id: null,
      retrieval_config: null,
      workspaceId: "ws-1",
      videoTimestamp: null,
      sub: "user-1",
      workspace_id: "ws-1",
    });

    const [, options] = fetchSpy.mock.calls[0];
    const sentBody = JSON.parse(options.body as string);
    expect(sentBody).toEqual({ query: "hello", session_id: null, retrieval_config: null });
  });
});

describe("Team B session-restoration contract (Step 7 — GET history / POST seed)", () => {
  it("STEP 2 REMEDIATION: hasSession() now sends a real Bearer JWT to the GET history endpoint", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ session_id: "s1", history: [] }) });
    vi.stubGlobal("fetch", fetchSpy);

    const { realTeamB } = await import("@/services/teamB/client");
    const exists = await realTeamB.hasSession!("s1", TEST_IDENTITY);

    expect(exists).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [calledUrl, options] = fetchSpy.mock.calls[0];
    expect(calledUrl).toBe("https://team-b.example.test/api/v1/sessions/s1/history");
    expect(options.method).toBe("GET");
    // The history endpoint now requires the same internal service JWT as
    // query()/seedSession() (previously the only unauthenticated
    // internal-service route on Team 4B -- fixed here).
    expect(options.headers.Authorization).toMatch(/^Bearer ey/);
  });

  it("hasSession() reports false for a 404 (missing/expired session)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) }));

    const { realTeamB } = await import("@/services/teamB/client");
    const exists = await realTeamB.hasSession!("expired-session", TEST_IDENTITY);

    expect(exists).toBe(false);
  });

  it("hasSession() fails safe to true (skip restoration) on a network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    const { realTeamB } = await import("@/services/teamB/client");
    const exists = await realTeamB.hasSession!("s1", TEST_IDENTITY);

    expect(exists).toBe(true);
  });

  it("STEP 2 REMEDIATION regression guard: hasSession() also fails safe to true on a 401/403 from Team 4B (e.g. a misconfigured signing key), never crashing or misreporting 'missing'", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ detail: "Invalid or missing authentication." }) }));

    const { realTeamB } = await import("@/services/teamB/client");
    const exists = await realTeamB.hasSession!("s1", TEST_IDENTITY);

    // Only a 404 means "missing" -- any other non-ok status (including an
    // unexpected 401/403 this client's own token should never actually
    // trigger) is treated the same as "cannot confirm", not "confirmed
    // missing" -- skipping restoration is always the safe direction.
    expect(exists).toBe(true);
  });

  it("seedSession() POSTs {turns} with a real Bearer JWT to the seed endpoint", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ session_id: "s1", seeded: true, turn_count: 1 }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    const { realTeamB } = await import("@/services/teamB/client");
    const result = await realTeamB.seedSession!("s1", [{ role: "user", content: "hi", timestamp: 1.0 }], TEST_IDENTITY);

    expect(result).toEqual({ session_id: "s1", seeded: true, turn_count: 1 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [calledUrl, options] = fetchSpy.mock.calls[0];
    expect(calledUrl).toBe("https://team-b.example.test/api/v1/sessions/s1/seed");
    expect(options.headers.Authorization).toMatch(/^Bearer ey/);
    expect(JSON.parse(options.body as string)).toEqual({ turns: [{ role: "user", content: "hi", timestamp: 1.0 }] });
  });

  it("seedSession() throws TeamBQueryError on a non-ok response, mirroring query()'s own error handling", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) }));

    const { realTeamB } = await import("@/services/teamB/client");
    const { TeamBQueryError } = await import("@/services/teamB/client");

    await expect(realTeamB.seedSession!("s1", [], TEST_IDENTITY)).rejects.toBeInstanceOf(TeamBQueryError);
  });
});
