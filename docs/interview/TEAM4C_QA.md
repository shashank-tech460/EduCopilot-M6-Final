# Team4C Q&A — Frontend & Product

Deep-answer format. For narrative-depth reading, see
[TEAM4C_DEEP_DIVE.md](../learning/TEAM4C_DEEP_DIVE.md).

---

**Q1. Why does Team4C exist as a separate layer instead of the browser calling Team4A/Team4B
directly?**

**Short answer:** The service JWT that authenticates calls to Team4A/Team4B is signed with a
private key that must never reach browser code — only a server can safely mint it.

**Detailed explanation:** If the browser called Team4A/Team4B directly, either those services
would need to trust the browser's own session cookie (a very different, weaker trust model), or
the signing key would need to ship to the client, which defeats the entire point of asymmetric
signing. Team4C's server-side API routes are the only place the private key ever exists.

**Example:** `services/teamA/client.ts` and `services/teamB/client.ts` mint a fresh token per
call, server-side, and attach it as a bearer token — this code never runs in the browser.

**Code reference:** `team4c/lib/serviceJwt.ts`.

**Possible follow-up:** *"Could Team4C leak the key some other way?"* Only if server-side code
were mistakenly bundled for the client — Next.js's server/client module boundary is what
prevents this by default.

---

**Q2. Why does `assertOwnership()` return the identical 404 for "doesn't exist" and "isn't
yours"?**

**Short answer:** So the workspace-ID space isn't probeable — a different response for each
case would let an attacker learn which IDs are in use even without ever seeing their content.

**Detailed explanation:** This is a deliberate, documented security choice, not an
oversimplification. If "not yours" returned a 403 (implying existence) while "doesn't exist"
returned 404, an attacker could enumerate valid workspace IDs belonging to other users purely
from the response code, without ever gaining access to the data itself.

**Example:** Guessing a random ObjectId and a real-but-someone-else's ObjectId both produce the
exact same 404 response.

**Code reference:** `team4c/lib/ownership.ts:24-47`.

**Possible follow-up:** *"Is this pattern used anywhere else in the codebase?"* Yes —
`assertConversationOwnership()` layers the identical pattern for conversation-scoped resources.

---

**Q3. If `proxy.ts` already redirects unauthenticated users away from protected pages, why does
every API route check the session again?**

**Short answer:** `proxy.ts`'s route matcher only covers page routes, not the API layer — an
API route hit directly (not via page navigation) would otherwise have no protection at all.

**Detailed explanation:** This is a real, important distinction: page-level and API-level
protection are two separate mechanisms, and the API-level one is the actual authorization
boundary for data access, since an API route can always be called directly (by a script, a
replayed request, a bug in the UI) regardless of what page the user is nominally on.

**Example:** A `curl` request straight to `/api/workspaces` with no session cookie gets
rejected by the route's own `auth()` check, independent of whatever `proxy.ts` would have done
for a page navigation.

**Code reference:** `team4c/proxy.ts`, and the repeated `auth()` check at the top of every
protected `app/api/*` route.

**Possible follow-up:** *"So what does `proxy.ts` actually protect against, then?"* A logged-out
user directly navigating to `/dashboard` in a browser — it's a UX-level redirect, not the data
security boundary.

---

**Q4. Explain the stuck "Thinking..." bug: root cause and fix.**

**Short answer:** Next.js's dev-mode Fast Refresh can remount the chat component mid-stream,
orphaning the `useChat()` instance that was listening for the answer — fixed with a
client-side 240-second watchdog that recreates the instance.

**Detailed explanation:** The key insight in the root-cause investigation: the backend
(Team4B) actually finished and produced a real answer in these cases — the failure was purely
that nothing on the frontend was still listening for it, because the component instance that
initiated the request no longer existed after the remount. This is dev-mode-only, since Fast
Refresh doesn't exist in a production build. The fix uses the AI SDK's own documented
mechanism for abandoning a stream: changing `useChat()`'s `id` option forces a fresh instance.

**Example:** A developer edits and saves a file while a chat response is streaming in — without
the fix, the UI would show "Thinking..." forever even though the answer was actually generated.

**Code reference:** `team4c/hooks/useChatStream.ts` (the watchdog `useEffect`).

**Possible follow-up:** *"Does this mean a production user could hit this bug too?"* No — since
the root cause is specifically a dev-server hot-reload behavior that doesn't exist in a
production build, this exact failure mode is dev-only, though the watchdog itself still runs
in production as a general safety net for any stream that genuinely hangs for other reasons.

---

**Q5. How does citation re-verification work, and why does it exist if Team4B already scopes
by workspace?**

**Short answer:** Team4C independently re-fetches the active workspace's own file list and
disables any citation whose file isn't in it, before ever rendering it to the student — a
second, defense-in-depth check, not a replacement for Team4B's own scoping.

**Detailed explanation:** The code's own comment calls this exactly what it is: a UI-layer
safety net. The real authorization boundary is enforced earlier (JWT `workspace_id`, Team4B's
retrieval scoping); this check exists so that even if something went wrong upstream, an
out-of-scope citation is caught before a student ever sees it, rather than trusting a single
layer to be perfect.

**Example:** If Team4B's response somehow included a citation for a file outside the current
workspace, Team4C would mark that specific citation `disabled: true` rather than rendering it
as a clickable source.

**Code reference:** `team4c/app/api/chat/route.ts` (`finalizeAnswer`),
`team4c/lib/workspaceFilter.ts`.

**Possible follow-up:** *"What's the difference between disabling a citation and removing it
entirely?"* A disabled citation renders as a non-interactive, visually muted chip rather than
disappearing — the student sees that a source was suppressed rather than the answer silently
looking like it has fewer citations than it actually generated.

---

**Q6. Walk through the upload flow, Team4C's side.**

**Short answer:** Session + ownership check → store bytes (or reference a YouTube URL) →
create a `File` record → mint a scoped retrieval URL → call Team4A → update `File.status` based
on the result.

**Detailed explanation:** The retrieval URL minted for Team4A's fetch is deliberately separate
from the permanent URL used for citation clicks — it's short-lived and capability-scoped,
because Team4A fetches it server-to-server with no browser session available to authenticate
that request any other way.

**Example:** A PDF upload creates a `File` with `status: "uploading"`, then `"processing"`
once Team4A accepts it, then `"ready"` or `"failed"` based on the actual result — never a
generic "uploaded" state in between.

**Code reference:** `team4c/lib/ingestion.ts:103-149`, `team4c/services/storage.ts`.

**Possible follow-up:** *"What happens to the UI while a file is processing?"* `StatusBadge`
shows a pulsing indicator only for the two active states (`uploading`/`processing`) — a
resolved state (`ready`/`failed`) shows no pulse.

---

**Q7. How does retry work, and what stops a retry from racing a still-in-flight attempt?**

**Short answer:** Retry only accepts a File already in `failed` status (409 otherwise), reuses
the same File record, and relies entirely on Team4A's own lock/generation mechanism for
concurrency safety.

**Detailed explanation:** The retry route's own code comment is explicit that it deliberately
does not reimplement or weaken Team4A's locking — it trusts the canonical ingestion path's
existing per-document lock to make a concurrent retry safe, rather than adding a second,
possibly-inconsistent locking mechanism on Team4C's side.

**Example:** Clicking "Retry" on a failed upload twice in quick succession — the second click,
if the first retry is already in flight, would be handled by Team4A's own lock rejecting the
overlapping attempt, not by any special logic in the retry route itself.

**Code reference:** `team4c/app/api/workspaces/[id]/files/[fileId]/retry/route.ts`.

**Possible follow-up:** *"Why not just create a new File record for the retry?"* Reusing the
same record keeps the material's identity (and any existing `document_id` relationships)
stable — a retry is conceptually "try this same upload again," not "upload a new thing."

---

**Q8. Why does the Zustand store persist only part of its state?**

**Short answer:** Only `workspace`, `ui`, and a narrowed slice of `video` state get saved to
localStorage — session data, full chat history, and in-flight uploads are deliberately
excluded.

**Detailed explanation:** Persisting session data would be a security concern (a stale session
token surviving in localStorage); persisting full chat history would duplicate what MongoDB
already durably stores, for no benefit; persisting in-flight upload state doesn't make sense
across a page reload since the underlying upload itself doesn't survive one either.

**Example:** Reloading the page preserves which workspace was open and whether the sidebar was
collapsed, but not an in-progress chat stream (which the stuck-stream watchdog logic would need
to re-establish anyway).

**Code reference:** `team4c/store/appStore.ts` (`partialize`).

**Possible follow-up:** *"Why does `logout()` reset most state but not `ui`?"* A sidebar-open
preference isn't tied to who's logged in — resetting it on every logout would be a pointless UX
regression for no security benefit.

---

**Q9. How does mobile-responsive sidebar collapse avoid conflicting with a user's manual
preference?**

**Short answer:** It's strictly one-directional — collapses automatically on a narrow viewport
at mount, but never force-expands, so a deliberately-collapsed sidebar on a wide screen stays
collapsed on a later visit.

**Detailed explanation:** This was a genuine design tension: an earlier, symmetric version
also auto-expanded on wide viewports, which broke an existing, intentional contract that a
manually-collapsed sidebar persists across reloads (since the preference is saved to
localStorage). The fix accepts an asymmetric rule rather than trying to distinguish
"auto-collapsed for mobile" from "manually collapsed" with a single boolean flag.

**Example:** A student on a laptop manually collapses the sidebar, then later opens the app on
the same laptop — it stays collapsed, exactly as they left it, not reset by any mobile-focused
logic.

**Code reference:** `team4c/components/shared/ConversationSidebar.tsx:100-105`.

**Possible follow-up:** *"Would a second flag (auto-collapsed vs. manually-collapsed) solve
this more cleanly?"* Possibly, but it was a heavier change under the constraint at the time
(and adds its own edge cases, e.g. what happens when an auto-collapsed sidebar is then
manually expanded) — the simpler one-directional rule was chosen as the pragmatic fix.

---

**Q10. What does the offline-message queue actually do, and how does it avoid sending messages
out of order?**

**Short answer:** A genuine network failure (no connection) queues the message for later; a
real application error (401/404/500) shows an immediate inline error instead. Queued messages
replay strictly one at a time, in order, with a guard against double-flushing.

**Detailed explanation:** The distinction between "network failure" and "application error"
matters because they call for different UX: a network failure is recoverable by simply waiting
and retrying automatically once connectivity returns; an application error (like a 401) won't
fix itself by waiting, so surfacing it immediately is more honest. The replay logic
specifically avoids a scenario where two "back online" events fire close together and cause the
same queued messages to be sent twice, or sent out of their original order.

**Example:** A student loses WiFi mid-question — the message queues silently; once connectivity
returns, it sends automatically, in the order it was originally asked.

**Code reference:** `team4c/components/chat/OfflineQueue.ts`.

**Possible follow-up:** *"What happens if a replay itself fails?"* The queue stops there,
leaving that message and everything after it still queued, rather than skipping the failed one
and sending the rest out of order.

---

**Q11. What's the actual accessibility work done, and how do you know it's real rather than
just claimed?**

**Short answer:** An automated `@axe-core/playwright` sweep checks 5 key pages for WCAG 2A/2AA
violations, and at least one specific fix is documented with its measured before/after contrast
ratio, not just an assumption that it's now fine.

**Detailed explanation:** A citation chip's text color was changed from a token measured at
roughly 2.7:1 contrast (failing the 4.5:1 AA threshold for small text) to a different token
verified at roughly 4.7:1, via what the code comment calls a "live contrast sweep" — a real,
tool-verified measurement, not a guess. Motion is also handled correctly: a pulsing
status-dot animation is explicitly suppressed under `prefers-reduced-motion`.

**Example:** Running the accessibility Playwright spec against the login page would fail the
build if a real WCAG violation were reintroduced, since it's a genuine automated check, not a
manual one-time audit.

**Code reference:** `team4c/tests/e2e/accessibility.spec.ts`,
`team4c/components/chat/SourceAttribution.tsx:66-71`.

**Possible follow-up:** *"Does passing automated axe checks guarantee full accessibility?"* No
— automated checks catch a meaningful subset of WCAG issues (contrast, ARIA attributes,
landmark structure) but not everything a manual screen-reader walkthrough would catch; this is
real, verified partial coverage, not a claim of complete accessibility certification.

---

**Q12. Why is there both a mock and a real client for Team4A/Team4B?**

**Short answer:** So Team4C's own development and tests can run without needing live Team4A/4B
services up, toggled by an environment flag (`USE_MOCK_TEAM_A`/`USE_MOCK_TEAM_B`).

**Detailed explanation:** This decouples Team4C's own iteration speed from the other two
services actually running — useful for frontend-only development, and for tests that want
deterministic, fast responses rather than a real multi-second LLM call.

**Example:** Running Team4C's Vitest suite doesn't require Ollama, Qdrant, or a live Team4B
process to be running at all — the mock client stands in.

**Code reference:** `team4c/services/teamA/{client.ts,mock.ts}`,
`team4c/services/teamB/{client.ts,mock.ts}`.

**Possible follow-up:** *"Does the Playwright E2E suite use the mocks too?"* No — the E2E
suite's whole point is exercising the real, running Team4A/Team4B path end-to-end; it uses the
real clients, not the mocks.
