import type {
  TeamAService,
  TeamASubmitContext,
  TeamASubmitRequest,
  TeamASubmitResponse,
  TeamAStatusResponse,
} from "@/types/teamA";
import { loadServiceJwtSigningConfigFromEnv, mintServiceJwt } from "@/lib/serviceJwt";

/**
 * Real Team A client -- Phase 2D: authenticated canonical wiring.
 *
 * Replaces the earlier stale, static-API-key placeholder. Every call
 * mints a fresh, short-lived (Phase 2B default: 300s) ES256 internal
 * service JWT from SERVER-VERIFIED identity (`context`, supplied by the
 * caller -- see app/api/workspaces/[id]/files/route.ts's
 * `handOffToTeamA`, which only calls this after `assertOwnership()` has
 * already confirmed the authenticated user belongs to the target
 * workspace) -- never a client-supplied or request-body value. The JWT
 * is sent as `Authorization: Bearer <token>`; the wire body sent to
 * `/v1/ingest` is EXACTLY `TeamASubmitRequest` (`{document_id, file_type,
 * file_url}`) via `JSON.stringify(request)` -- no identity field is ever
 * added to it, by construction (the type itself has none, and this
 * function never spreads `context` into the body).
 *
 * `TEAM_A_API_URL` is the INTERNAL service URL (browsers never see or
 * call this) -- there is no API-key configuration anymore; the JWT IS
 * the authentication. The private signing key
 * (`SERVICE_JWT_PRIVATE_KEY`) is read only by `lib/serviceJwt.ts`, only
 * in this server-side module, and is never sent anywhere, logged, or
 * reachable from any client/browser code path.
 */
export const realTeamA: TeamAService = {
  async submit(request: TeamASubmitRequest, context: TeamASubmitContext): Promise<TeamASubmitResponse> {
    const url = requireUrl();
    const signingConfig = loadServiceJwtSigningConfigFromEnv();

    const token = await mintServiceJwt(signingConfig, {
      sub: context.sub,
      workspace_id: context.workspace_id,
      scope: "ingest",
      aud: "team4a-ingestion",
    });

    const response = await fetch(`${url}/v1/ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      // Exactly the three canonical fields -- `request` has no others,
      // and `context` (the JWT-minting identity) is never merged in here.
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      throw new TeamASubmitError(response.status);
    }

    const body = await response.json();
    // The real, synchronous canonical route (Phase 2C) has already run
    // the full Phase 1 pipeline to completion (or thrown a non-2xx
    // status, caught above) by the time this response arrives -- there
    // is no separate async job to track. `ingestionId` is synthesized
    // here purely to satisfy the existing `TeamAService`/caller contract
    // (which still calls `checkStatus(ingestionId)` afterward, per the
    // existing hand-off flow) -- it carries no meaning to 4A itself.
    return { ingestionId: `canonical-${body.document_id}-gen${body.generation ?? "0"}` };
  },

  async checkStatus(_ingestionId: string): Promise<TeamAStatusResponse> {
    // The real canonical `/v1/ingest` (Phase 2C) is synchronous: if
    // `submit()` above returned without throwing, the entire Phase 1
    // pipeline (retrieval, extraction, generation/lock, Mongo authority,
    // Qdrant publication) already completed successfully. There is
    // nothing further to poll -- this is an honest reflection of that
    // synchronous contract, not a simulated/fake status.
    return { status: "ready", error: null };
  },
};

/** Carries the real HTTP status from a failed Team A `/v1/ingest` call, so
 * callers (lib/ingestion.ts's `describeIngestionFailure()`) can map it to a
 * safe, user-facing message without this client inventing its own error
 * taxonomy — mirrors services/teamB/client.ts's existing `TeamBQueryError`. */
export class TeamASubmitError extends Error {
  constructor(public readonly status: number) {
    super(`Team A submit failed with status ${status}`);
  }
}

function requireUrl(): string {
  const url = process.env.TEAM_A_API_URL;

  if (!url) {
    throw new Error(
      "TEAM_A_API_URL must be set to use the real Team A client. Set USE_MOCK_TEAM_A=true for local development."
    );
  }

  return url;
}
