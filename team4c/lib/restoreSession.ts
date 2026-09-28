import { MessageModel } from "@/models/Message";
import type { TeamBAuthContext, TeamBSeedTurn, TeamBService } from "@/types/teamB";

/**
 * Restores Team 4B's Redis conversation session from Team 4C's own
 * durable MongoDB history when Redis's TTL (Settings.session_ttl_minutes,
 * team4b/app/core/config.py) has expired it, so a resumed conversation
 * doesn't silently lose LLM context (today, `RAGService.handle_query()`
 * treats a missing session as brand-new with empty history -- no error,
 * just quietly reduced context).
 *
 * STEP 8 CORRECTION: Step 7's version always swallowed every failure and
 * let the caller proceed to `teamB.query()` regardless -- meaning a
 * conversation that genuinely NEEDED restoration (real prior history
 * exists, the session is missing) but couldn't get it (Team B down, a
 * network blip) would silently continue with an empty-context query, the
 * exact silent-context-loss outcome this whole feature exists to
 * prevent. This version instead returns a `RestorationOutcome` the
 * caller (app/api/chat/route.ts) MUST inspect and act on:
 *
 *   - "not-needed": the session is alive, OR there is no persisted
 *     history to restore at all -- proceed exactly as before, unchanged.
 *   - "restored": missing session, real history existed, successfully
 *     seeded -- proceed.
 *   - "team-b-unavailable": restoration was necessary but Team B
 *     couldn't be reached/confirmed (the session-existence check or the
 *     seed call itself failed) -- the caller must NOT proceed to query
 *     with unknown/lost context; it returns a 502, mirroring the exact
 *     error contract already used for a Team B outage during the query
 *     call itself.
 *   - "internal-error": Team 4C's OWN read of its history (MongoDB)
 *     failed -- distinct from a Team B outage; the caller returns a 500.
 *
 * Still never THROWS -- every failure is caught and turned into one of
 * the outcomes above, never an unhandled rejection.
 *
 * Sends at most `RESTORE_MESSAGE_LIMIT` of the most recent messages, in
 * chronological order -- deliberately MORE than Team 4B's own configured
 * `conversation_window_size` (a value this module has no way to know,
 * and has no need to know): `ConversationManager.seed_history()` on the
 * 4B side truncates to its own configured window itself, so over-sending
 * here is harmless, and under-sending would silently restore less
 * context than a live session would actually have had.
 *
 * Called from app/api/chat/route.ts AFTER `ragSessionId` is resolved but
 * BEFORE `teamB.query()` -- at that point the CURRENT user message has
 * not yet been persisted to Mongo (persistence happens only after Team
 * 4B's answer comes back), so querying already-persisted `Message`
 * documents can never include it -- no special-casing needed to exclude
 * it, and returning early on failure here (before ANY persistence call)
 * means a failed restoration attempt never leaves a stray/duplicate
 * message behind, exactly like any other pre-query failure this route
 * already handles.
 */
const RESTORE_MESSAGE_LIMIT = 20;

export type RestorationOutcome =
  | { status: "not-needed" }
  | { status: "restored" }
  | { status: "team-b-unavailable" }
  | { status: "internal-error" };

export async function restoreSessionIfMissing(
  teamB: TeamBService,
  ragSessionId: string,
  conversationId: string,
  auth: TeamBAuthContext
): Promise<RestorationOutcome> {
  if (!teamB.hasSession || !teamB.seedSession) {
    // The active TeamBService implementation (e.g. the local mock, which
    // has no Redis-backed session/expiry concept at all) doesn't support
    // restoration -- nothing to do, and nothing that could have been
    // "necessary but incomplete" either.
    return { status: "not-needed" };
  }

  // Checked FIRST (before ever calling Team B) so that a Team B hiccup
  // never blocks a brand-new conversation that has nothing to restore in
  // the first place -- only a conversation with real, at-risk history
  // ever escalates a failure into an error response.
  let recentMessagesNewestFirst;
  try {
    recentMessagesNewestFirst = await MessageModel.find({ conversationId })
      .sort({ createdAt: -1 })
      .limit(RESTORE_MESSAGE_LIMIT)
      .select({ role: 1, content: 1, createdAt: 1 });
  } catch (error) {
    console.error(
      `[restoreSession] Failed to read history for conversation ${conversationId}:`,
      error instanceof Error ? error.message : "Unknown error"
    );
    return { status: "internal-error" };
  }

  if (recentMessagesNewestFirst.length === 0) {
    // Nothing to restore -- the upcoming /query call will create a
    // fresh session via its own normal append_turn path, identically
    // to what would happen without this feature at all.
    return { status: "not-needed" };
  }

  let exists: boolean;
  try {
    exists = await teamB.hasSession(ragSessionId, auth);
  } catch (error) {
    console.warn(
      `[restoreSession] Could not confirm session ${ragSessionId} exists (conversation ${conversationId}):`,
      error instanceof Error ? error.message : "Unknown error"
    );
    return { status: "team-b-unavailable" };
  }

  if (exists) {
    return { status: "not-needed" };
  }

  const turns: TeamBSeedTurn[] = recentMessagesNewestFirst
    .slice()
    .reverse() // oldest first -- Team 4B's append order determines restored order
    .map((message) => ({
      role: message.role,
      content: message.content,
      timestamp: message.createdAt ? message.createdAt.getTime() / 1000 : undefined,
    }));

  try {
    await teamB.seedSession(ragSessionId, turns, auth);
  } catch (error) {
    console.warn(
      `[restoreSession] Failed to seed session ${ragSessionId} for conversation ${conversationId}:`,
      error instanceof Error ? error.message : "Unknown error"
    );
    return { status: "team-b-unavailable" };
  }

  return { status: "restored" };
}
