import { expect, test } from "@playwright/test";

import { createWorkspace, signUp, uniqueTestAccount } from "./helpers";

/**
 * Phase 6D — YouTube real E2E (Journey B, video/transcript variant).
 *
 * Uses an ALREADY-VALIDATED, previously-used stable YouTube source
 * (`https://youtu.be/wdaBwIv7Jso`) rather than an arbitrary video merely
 * because it's available — this exact URL was already used successfully
 * in an earlier real product-level validation round
 * (`team4b/data/m6_product_level_rag_validation_report.json`, subject
 * classified there as Trigonometry/Mathematics), per this phase's own
 * instruction to prefer an already-validated/stable source.
 *
 * Same environment gate as core-rag.spec.ts: requires real, live
 * Team4A/Team4B. This is TRANSCRIPT-derived RAG only — no claim is made
 * about visual-frame/video understanding anywhere in this test or its
 * assertions, consistent with docs/RAG_ARCHITECTURE.md's own explicit
 * scope statement.
 */
async function isReachable(url: string, timeoutMs = 3000): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(url, { signal: controller.signal }).catch(() => null);
    clearTimeout(timer);
    return response !== null;
  } catch {
    return false;
  }
}

const STABLE_YOUTUBE_URL = "https://youtu.be/wdaBwIv7Jso";

test.describe("Journey B (variant) — YouTube transcript RAG", () => {
  test.beforeEach(async () => {
    const teamAUrl = process.env.TEAM_A_API_URL ?? "http://localhost:8001";
    const teamBUrl = process.env.TEAM_B_API_URL ?? "http://localhost:8002";
    const [teamAUp, teamBUp] = await Promise.all([isReachable(teamAUrl), isReachable(teamBUrl)]);

    test.skip(
      !teamAUp || !teamBUp,
      `Team4A (${teamAUrl}, reachable=${teamAUp}) and/or Team4B (${teamBUrl}, reachable=${teamBUp}) ` +
        "are not running in this environment. This journey requires both live for real transcript " +
        "ingestion + real RAG query, and deliberately does not fall back to a mock."
    );
  });

  test("add a YouTube URL, wait for ready, ask a question, get a grounded transcript-based answer with a citation", async ({
    page,
  }) => {
    // YouTube ingestion additionally depends on network reachability to
    // YouTube itself (transcript fetch) -- a real external dependency
    // this test cannot control, unlike the local PDF fixture. Generous
    // budget, same reasoning as core-rag.spec.ts.
    test.setTimeout(300_000);

    const account = uniqueTestAccount("yt");
    await signUp(page, account);

    const workspaceHref = await createWorkspace(page, `YouTube E2E ${Date.now()}`);
    await page.goto(workspaceHref);

    await page
      .getByRole("tab", { name: "Materials" })
      .click({ timeout: 2000 })
      .catch(() => undefined);

    await page.getByRole("button", { name: "Add Material" }).click();
    await page.getByRole("button", { name: "Add YouTube URL" }).click();
    await page.getByLabel("YouTube URL").fill(STABLE_YOUTUBE_URL);
    await page.getByRole("dialog").getByRole("button", { name: "Add Material" }).click();

    // Real Team4A transcript fetch + extraction + chunking + embedding +
    // Qdrant publish, running synchronously -- poll for real "Ready".
    await expect(page.getByText("Ready")).toBeVisible({ timeout: 180_000 });

    await page
      .getByRole("tab", { name: "AI Tutor" })
      .click({ timeout: 2000 })
      .catch(() => undefined);
    const chatInput = page.getByLabel("Chat message");
    await chatInput.waitFor({ state: "visible" });
    await expect(chatInput).toBeEnabled({ timeout: 30_000 });

    // Deliberately structural, not an exact-sentence assertion (this
    // phase's own instruction) -- this project does not have prior
    // verified knowledge of this specific video's exact transcript
    // wording, only that it is a real, previously-ingested, real subject
    // video, so the question is intentionally general.
    await chatInput.fill("What is this video about?");
    await page.getByRole("button", { name: "Send" }).click();

    await expect(page.getByText("Thinking…")).toBeVisible();
    await expect(page.getByText("Thinking…")).not.toBeVisible({ timeout: 150_000 });

    const assistantBubble = page.locator(".mr-auto.max-w-\\[80\\%\\]").last();
    await expect(assistantBubble).not.toHaveText("", { timeout: 5000 });

    // At least one citation renders, identified by its real accessible
    // name -- the same role-based pattern already proven correct in
    // core-rag.spec.ts and tests/component/ChatPanel.test.tsx, rather
    // than a brittle CSS-class substring match. (An earlier version of
    // this assertion also tried to fall back to a generic
    // `[aria-disabled="true"]` locator for the "correctly disabled"
    // case -- removed after discovering it also matches an unrelated
    // video.js Picture-in-Picture control button, which made Playwright's
    // strict mode reject the combined locator as ambiguous even when the
    // real citation was genuinely present and visible.)
    //
    // Stage 10 FIX: this asserted on `/Trigonometry/i`, assuming a
    // citation button's accessible name would contain the video's
    // TOPIC. Confirmed live it never does -- SourceAttribution.tsx
    // renders a video citation's accessible name as
    // `{sourceFile} · {timestamp}` where `sourceFile` is the workspace's
    // own stored material name, which for a YouTube material is the
    // URL itself (e.g. "https://youtu.be/wdaBwIv7Jso · 50:11") -- "the
    // video appears to be about trigonometry" only ever appears in the
    // ANSWER TEXT, never in a citation button. The real flow worked
    // perfectly (a grounded answer with "Sources (5)" citations
    // rendered); this was purely a wrong test expectation. The "· "
    // separator (present on every real citation, absent from the
    // Materials panel's own unrelated "Play <url>" button) distinguishes
    // a real citation from that other same-URL-substring button.
    await expect(page.getByRole("button", { name: /youtu\.be\/wdaBwIv7Jso.*·/i }).first()).toBeVisible({
      timeout: 5000,
    });
  });
});
