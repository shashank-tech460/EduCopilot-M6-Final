import type {
  TeamBAuthContext,
  TeamBMockOnlyContext,
  TeamBQueryRequest,
  TeamBQueryResponse,
  TeamBSeedResponse,
  TeamBSeedTurn,
  TeamBService,
  TeamBStreamEvent,
} from "@/types/teamB";
import { loadServiceJwtSigningConfigFromEnv, mintServiceJwt } from "@/lib/serviceJwt";

/**
 * Real Team B ("Team 4b") client -- Phase 2E: authenticated canonical
 * wiring. Replaces the earlier stale, static-API-key placeholder.
 *
 * Every call mints a fresh, short-lived (Phase 2B default: 300s) ES256
 * internal service JWT from SERVER-VERIFIED identity (`request.sub`/
 * `request.workspace_id` -- see types/teamB.ts's `TeamBAuthContext`,
 * supplied by app/api/chat/route.ts from the authenticated session and
 * the already-authorized workspace, exactly mirroring
 * services/teamA/client.ts's Phase 2D pattern) -- never a client-
 * supplied or request-body value. The wire body sent to
 * `/api/v1/query` is EXACTLY `TeamBQueryRequest`
 * (`{query, session_id, retrieval_config}`) -- `workspaceId`/
 * `videoTimestamp` (TeamBMockOnlyContext, consumed only by the local
 * mock) and `sub`/`workspace_id` (TeamBAuthContext, consumed only to
 * mint the JWT) are both explicitly excluded from the serialized body
 * below, even though this function receives an object that may carry
 * all of them.
 */
export const realTeamB: TeamBService = {
  async query(
    request: TeamBQueryRequest & Partial<TeamBMockOnlyContext> & Partial<TeamBAuthContext>
  ): Promise<TeamBQueryResponse> {
    const url = requireUrl();

    if (!request.sub || !request.workspace_id) {
      // A real call MUST carry server-verified identity to mint a JWT --
      // unlike the mock-only fields (which the mock alone needs), this
      // is a hard requirement for the REAL client specifically.
      throw new Error(
        "realTeamB.query() requires sub and workspace_id (TeamBAuthContext) to mint the internal service JWT."
      );
    }

    const signingConfig = loadServiceJwtSigningConfigFromEnv();
    const token = await mintServiceJwt(signingConfig, {
      sub: request.sub,
      workspace_id: request.workspace_id,
      scope: "query",
      aud: "team4b-query",
    });

    // Explicitly serializes ONLY the three canonical fields.
    const canonicalBody: TeamBQueryRequest = {
      query: request.query,
      session_id: request.session_id,
      retrieval_config: request.retrieval_config,
    };

    const response = await fetch(`${url}/api/v1/query`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(canonicalBody),
    });

    if (!response.ok) {
      // Preserves the actual 4B status distinction (401/403/422/5xx)
      // for the caller to react to, without leaking response internals.
      throw new TeamBQueryError(response.status);
    }

    // Parses the actual 4B QueryResponse shape (answer, citations) --
    // no new response schema is invented here.
    return response.json();
  },

  /**
   * Stage 9B — real token streaming. Identical request construction and
   * JWT minting to `query()` above (same canonical body, same scope/
   * audience), calling Team 4B's additive `POST /api/v1/query/stream`
   * instead. `fetch()`'s own promise resolves as soon as HEADERS arrive
   * -- BEFORE the body is read -- so `!response.ok` here genuinely
   * detects any failure Team 4B reported before committing to a stream
   * (retrieval failure, conversation-store failure, or Ollama being
   * unreachable before the first token: all real 503s from Team 4B's own
   * priming mechanism), surfacing as a thrown `TeamBQueryError` from
   * this async generator's FIRST `.next()` call -- never silently
   * swallowed into an empty stream. A failure Team 4B reports AFTER
   * streaming has begun instead arrives as an in-band `{"type":"error"}`
   * NDJSON line, decoded and yielded like any other event (never thrown),
   * matching Team 4B's own disclosed HTTP-streaming trade-off exactly.
   *
   * Reads and decodes the response body incrementally via the Fetch
   * API's own streaming `ReadableStream` reader -- genuine byte-as-they-
   * arrive delivery, not buffering the whole body before parsing.
   */
  async *queryStream(
    request: TeamBQueryRequest & Partial<TeamBMockOnlyContext> & Partial<TeamBAuthContext>
  ): AsyncGenerator<TeamBStreamEvent> {
    const url = requireUrl();

    if (!request.sub || !request.workspace_id) {
      throw new Error(
        "realTeamB.queryStream() requires sub and workspace_id (TeamBAuthContext) to mint the internal service JWT."
      );
    }

    const signingConfig = loadServiceJwtSigningConfigFromEnv();
    const token = await mintServiceJwt(signingConfig, {
      sub: request.sub,
      workspace_id: request.workspace_id,
      scope: "query",
      aud: "team4b-query",
    });

    const canonicalBody: TeamBQueryRequest = {
      query: request.query,
      session_id: request.session_id,
      retrieval_config: request.retrieval_config,
    };

    const response = await fetch(`${url}/api/v1/query/stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(canonicalBody),
    });

    if (!response.ok || !response.body) {
      throw new TeamBQueryError(response.status);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex >= 0) {
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          if (line.trim().length > 0) {
            yield JSON.parse(line) as TeamBStreamEvent;
          }
          newlineIndex = buffer.indexOf("\n");
        }
      }
      if (buffer.trim().length > 0) {
        yield JSON.parse(buffer) as TeamBStreamEvent;
      }
    } finally {
      reader.releaseLock();
    }
  },

  /**
   * Step 7 / STEP 2 REMEDIATION — backed by
   * `GET /api/v1/sessions/{id}/history` (team4b/app/api/routes.py), which
   * now requires the same internal service JWT as `query`/`seedSession`
   * (previously the only unauthenticated internal-service route on Team
   * 4B — fixed here). A 404 means "no session" -> `false`; any other
   * successful response means the session exists -> `true`. Any network/
   * unexpected-status failure (including a 401/403, which should never
   * happen given a correctly-minted token, but is handled the same as
   * any other unreachable-service failure) is treated as "cannot confirm
   * the session is missing" -> `true` (the safe default -- see this
   * method's own callers: reporting a false "missing" would trigger a
   * needless/incorrect restoration attempt, while reporting a false
   * "exists" simply skips restoration and falls back to today's
   * existing, unchanged behavior).
   */
  async hasSession(sessionId: string, auth: TeamBAuthContext): Promise<boolean> {
    const url = requireUrl();
    const signingConfig = loadServiceJwtSigningConfigFromEnv();
    const token = await mintServiceJwt(signingConfig, {
      sub: auth.sub,
      workspace_id: auth.workspace_id,
      scope: "query",
      aud: "team4b-query",
    });

    let response: Response;
    try {
      response = await fetch(`${url}/api/v1/sessions/${encodeURIComponent(sessionId)}/history`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
    } catch {
      return true;
    }
    if (response.status === 404) {
      return false;
    }
    return true;
  },

  /**
   * Step 7 — calls the new, JWT-protected `POST /api/v1/sessions/{id}/seed`
   * (identical auth minting to `query()` above: same scope/audience,
   * same server-verified `sub`/`workspace_id`, never a client-supplied
   * identity).
   */
  async seedSession(sessionId: string, turns: TeamBSeedTurn[], auth: TeamBAuthContext): Promise<TeamBSeedResponse> {
    const url = requireUrl();
    const signingConfig = loadServiceJwtSigningConfigFromEnv();
    const token = await mintServiceJwt(signingConfig, {
      sub: auth.sub,
      workspace_id: auth.workspace_id,
      scope: "query",
      aud: "team4b-query",
    });

    const response = await fetch(`${url}/api/v1/sessions/${encodeURIComponent(sessionId)}/seed`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ turns }),
    });

    if (!response.ok) {
      throw new TeamBQueryError(response.status);
    }

    return response.json();
  },

  /**
   * STEP 5 — calls the new, JWT-protected `DELETE /api/v1/sessions/{id}`
   * (Step 3 remediation; identical auth minting to `seedSession()` above).
   * Best-effort: throws `TeamBQueryError` on a non-ok response so the
   * caller (`lib/deleteConversation.ts`) can log and swallow it, exactly
   * as documented on `TeamBService.deleteSession`'s own interface
   * docstring — never treated as fatal to the (authoritative) Team 4C-
   * side deletion.
   */
  async deleteSession(sessionId: string, auth: TeamBAuthContext): Promise<boolean> {
    const url = requireUrl();
    const signingConfig = loadServiceJwtSigningConfigFromEnv();
    const token = await mintServiceJwt(signingConfig, {
      sub: auth.sub,
      workspace_id: auth.workspace_id,
      scope: "query",
      aud: "team4b-query",
    });

    const response = await fetch(`${url}/api/v1/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      throw new TeamBQueryError(response.status);
    }

    const data: { deleted: boolean } = await response.json();
    return data.deleted;
  },
};

/** Carries the real HTTP status from a failed Team B call, so callers
 * (app/api/chat/route.ts) can distinguish auth/authorization/validation/
 * server failures without this client inventing its own error taxonomy. */
export class TeamBQueryError extends Error {
  constructor(public readonly status: number) {
    super(`Team B query failed with status ${status}`);
  }
}

function requireUrl(): string {
  const url = process.env.TEAM_B_API_URL;

  if (!url) {
    throw new Error(
      "TEAM_B_API_URL must be set to use the real Team B client. Set USE_MOCK_TEAM_B=true for local development."
    );
  }

  return url;
}
