// @vitest-environment node
import { describe, expect, it, beforeEach, afterEach } from "vitest";

/**
 * Stage 2 — dedicated tests for `realTeamB.queryStream()`'s NDJSON
 * parsing (services/teamB/client.ts), a genuinely untested path before
 * this file (confirmed: no prior test file exercised it at all). Part of
 * Stage 2's investigation into the reported AI Tutor blank-response
 * issue — Step 3's own hypothesis list explicitly calls out "Incorrect
 * SSE or streaming event parsing" and "Malformed or missing text-delta
 * events" as candidates; this file rules them in or out for the REAL
 * client's own line-buffering/JSON-parsing logic specifically (Team4C's
 * route-level forwarding is already covered by
 * tests/unit/chat-api.test.ts's "Stage 9B" suite against a fake
 * `queryStream`).
 *
 * Drives a REAL `ReadableStream` (chunked exactly as specified, not one
 * chunk per line) through the REAL client, never a mock of the parsing
 * logic itself.
 */

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[index]));
      index += 1;
    },
  });
}

async function setupSigningEnv() {
  process.env.TEAM_B_API_URL = "https://team-b.example.test";
  const { generateKeyPair, exportPKCS8 } = await import("jose");
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  process.env.SERVICE_JWT_PRIVATE_KEY = await exportPKCS8(privateKey);
  process.env.SERVICE_JWT_KID = "k1";
  process.env.SERVICE_JWT_ISSUER = "https://educopilot.internal";
}

const baseRequest = {
  query: "hi",
  session_id: null,
  retrieval_config: null,
  sub: "u1",
  workspace_id: "w1",
};

describe("realTeamB.queryStream() — NDJSON parsing robustness", () => {
  const originalFetch = global.fetch;

  beforeEach(async () => {
    await setupSigningEnv();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("parses multiple real NDJSON events delivered across arbitrary chunk boundaries", async () => {
    const { realTeamB } = await import("@/services/teamB/client");

    // Deliberately split mid-line (not one chunk per line) -- proves the
    // client buffers a partial line across chunks rather than assuming
    // each chunk boundary aligns with a line boundary.
    const line1 = '{"type":"delta","text":"Hello "}\n';
    const line2 = '{"type":"delta","text":"world."}\n';
    const line3 = '{"type":"done","answer":"Hello world.","session_id":"s1","source_attributions":[],"retrieval_metadata":{}}\n';
    const fullBody = line1 + line2 + line3;
    const chunks = [fullBody.slice(0, 20), fullBody.slice(20, 55), fullBody.slice(55)];

    global.fetch = (async () => {
      return { ok: true, status: 200, body: streamFromChunks(chunks) } as unknown as Response;
    }) as typeof fetch;

    try {
      const events = [];
      for await (const event of realTeamB.queryStream!(baseRequest)) {
        events.push(event);
      }
      expect(events).toEqual([
        { type: "delta", text: "Hello " },
        { type: "delta", text: "world." },
        { type: "done", answer: "Hello world.", session_id: "s1", source_attributions: [], retrieval_metadata: {} },
      ]);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("propagates a malformed JSON line as a real, visible error rather than silently dropping it", async () => {
    const { realTeamB } = await import("@/services/teamB/client");

    const chunks = ['{"type":"delta","text":"partial"}\n', "not valid json at all\n"];
    global.fetch = (async () => {
      return { ok: true, status: 200, body: streamFromChunks(chunks) } as unknown as Response;
    }) as typeof fetch;

    try {
      const iterator = realTeamB.queryStream!(baseRequest)[Symbol.asyncIterator]();
      const first = await iterator.next();
      expect(first.value).toEqual({ type: "delta", text: "partial" });

      await expect(iterator.next()).rejects.toThrow();
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("a non-ok HTTP response throws TeamBQueryError before any event is ever yielded", async () => {
    const { realTeamB, TeamBQueryError } = await import("@/services/teamB/client");

    global.fetch = (async () => {
      return { ok: false, status: 503, body: null } as unknown as Response;
    }) as typeof fetch;

    try {
      const iterator = realTeamB.queryStream!(baseRequest)[Symbol.asyncIterator]();
      await expect(iterator.next()).rejects.toBeInstanceOf(TeamBQueryError);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("an empty stream body (zero lines) completes with zero events, not an error", async () => {
    const { realTeamB } = await import("@/services/teamB/client");

    global.fetch = (async () => {
      return { ok: true, status: 200, body: streamFromChunks([]) } as unknown as Response;
    }) as typeof fetch;

    try {
      const events = [];
      for await (const event of realTeamB.queryStream!(baseRequest)) {
        events.push(event);
      }
      expect(events).toEqual([]);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("a trailing line with no final newline is still parsed (not silently dropped)", async () => {
    const { realTeamB } = await import("@/services/teamB/client");

    // No trailing "\n" after the done event -- the real Team4B server
    // always terminates NDJSON lines, but the client must not depend on
    // that for the LAST line specifically.
    const chunks = ['{"type":"delta","text":"hi"}\n', '{"type":"done","answer":"hi","session_id":"s1","source_attributions":[],"retrieval_metadata":{}}'];
    global.fetch = (async () => {
      return { ok: true, status: 200, body: streamFromChunks(chunks) } as unknown as Response;
    }) as typeof fetch;

    try {
      const events = [];
      for await (const event of realTeamB.queryStream!(baseRequest)) {
        events.push(event);
      }
      expect(events).toHaveLength(2);
      expect(events[1]).toMatchObject({ type: "done", answer: "hi" });
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("blank lines between real events are skipped, not treated as malformed", async () => {
    const { realTeamB } = await import("@/services/teamB/client");

    const chunks = ['{"type":"delta","text":"a"}\n', "\n", "\n", '{"type":"done","answer":"a","session_id":"s1","source_attributions":[],"retrieval_metadata":{}}\n'];
    global.fetch = (async () => {
      return { ok: true, status: 200, body: streamFromChunks(chunks) } as unknown as Response;
    }) as typeof fetch;

    try {
      const events = [];
      for await (const event of realTeamB.queryStream!(baseRequest)) {
        events.push(event);
      }
      expect(events).toHaveLength(2);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
