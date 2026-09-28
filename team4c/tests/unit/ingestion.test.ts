import { describe, expect, it } from "vitest";

import { describeIngestionFailure } from "@/lib/ingestion";
import { TeamASubmitError } from "@/services/teamA/client";

/**
 * Stage 9 — `describeIngestionFailure()` in isolation: the pure mapping
 * from a thrown ingestion error to a fixed, safe, user-facing message.
 * No route, no mocked FileModel/TeamA service — just the function.
 */
describe("describeIngestionFailure", () => {
  it("maps 409 (DocumentAlreadyLockedError) to a clear, actionable message", () => {
    expect(describeIngestionFailure(new TeamASubmitError(409))).toBe(
      "This file is already being processed. Please wait a moment, then refresh and try again."
    );
  });

  it("maps 404 (ABORTED_MISSING_FILE) to a clear, actionable message", () => {
    expect(describeIngestionFailure(new TeamASubmitError(404))).toBe(
      "We couldn't find your uploaded file to process it. Please try uploading it again."
    );
  });

  it("maps 422 (untrusted/invalid file_url) to a clear, actionable message", () => {
    expect(describeIngestionFailure(new TeamASubmitError(422))).toBe(
      "This file's source could not be validated. Please check it and try again."
    );
  });

  it("maps 401 and 403 (rejected internal service JWT) to the same clear message", () => {
    expect(describeIngestionFailure(new TeamASubmitError(401))).toBe(
      "We couldn't authorize this upload right now. Please try again shortly."
    );
    expect(describeIngestionFailure(new TeamASubmitError(403))).toBe(
      "We couldn't authorize this upload right now. Please try again shortly."
    );
  });

  it("maps 502 (source file/video could not be retrieved) to a clear, actionable message", () => {
    expect(describeIngestionFailure(new TeamASubmitError(502))).toBe(
      "We couldn't retrieve or process your file right now. Please try again in a few minutes."
    );
  });

  it("falls back to one generic message for an unrecognized status code", () => {
    expect(describeIngestionFailure(new TeamASubmitError(500))).toBe(
      "Something went wrong while processing your file. Please try again."
    );
  });

  it("falls back to the same generic message for a non-TeamASubmitError exception (e.g. a network failure)", () => {
    expect(describeIngestionFailure(new Error("fetch failed: ECONNREFUSED at 10.0.4.12:8080"))).toBe(
      "Something went wrong while processing your file. Please try again."
    );
  });

  it("falls back to the same generic message for a completely non-Error thrown value", () => {
    expect(describeIngestionFailure("a raw string throw")).toBe(
      "Something went wrong while processing your file. Please try again."
    );
    expect(describeIngestionFailure(undefined)).toBe(
      "Something went wrong while processing your file. Please try again."
    );
  });

  it("never includes the raw status number, a stack trace, or the original error message in any mapped message", () => {
    const sensitiveError = new Error("Connection refused to internal host 10.0.4.12:8080 (secret-service)");
    const message = describeIngestionFailure(sensitiveError);

    expect(message).not.toContain("10.0.4.12");
    expect(message).not.toContain("secret-service");
    expect(message).not.toContain("ECONNREFUSED");
  });
});
