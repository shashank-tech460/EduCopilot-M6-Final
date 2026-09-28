import { randomUUID } from "crypto";

import type { TeamBQueryRequest, TeamBMockOnlyContext, TeamBService, TeamBSourceAttribution } from "@/types/teamB";
import { FileModel } from "@/models/File";
import { extractPdfPages } from "@/lib/pdfExtraction";
import { scorePages, scoreSegments, findSegmentAtTime, parseTimestampFromQuery } from "@/lib/pdfRetrieval";
import { readStoredFile } from "@/services/storage";
import { getTranscriptProvider } from "@/services/transcript";
import { formatTimestamp } from "@/lib/formatTimestamp";

/**
 * Mock Team B (RAG query) service — a deterministic, LOCAL mock, explicitly
 * not a real LLM/RAG backend. Makes no external network call.
 *
 * GROUNDING GUARANTEE: every citation this mock returns references a file
 * that genuinely exists in the requesting workspace. PDF page numbers come
 * from actually parsing that PDF's real text. Video timestamps come from
 * either (a) the real, client-reported current playback position, or (b) a
 * mock transcript segment's own start time (itself demo-seeded per file,
 * not a claim about the video's real audio — see services/transcript/mock.ts)
 * — never an invented number unrelated to either source. When nothing
 * matches, this mock says so honestly rather than attaching a citation.
 */
const MIN_RETRIEVAL_SCORE = 0.34;
const EXCERPT_MAX_LENGTH = 400;
const MAX_CITATIONS = 2;

const GREETINGS = new Set(["hi", "hello", "hey", "hiya", "yo", "sup"]);
const CURRENT_MOMENT_PHRASES = ["here", "this part", "right now", "currently", "at this point", "this moment"];
const VIDEO_REFERENCE_PHRASES = ["video", "lecture", "clip", "recording"];

function isGreeting(query: string): boolean {
  const normalized = query.trim().toLowerCase().replace(/[^a-z\s]/g, "");
  return GREETINGS.has(normalized);
}

function referencesCurrentMoment(query: string): boolean {
  const normalized = query.toLowerCase();
  return CURRENT_MOMENT_PHRASES.some((phrase) => normalized.includes(phrase));
}

function referencesVideo(query: string): boolean {
  const normalized = query.toLowerCase();
  return VIDEO_REFERENCE_PHRASES.some((phrase) => normalized.includes(phrase));
}

function excerpt(text: string): string {
  if (text.length <= EXCERPT_MAX_LENGTH) {
    return text;
  }
  return `${text.slice(0, EXCERPT_MAX_LENGTH).trimEnd()}…`;
}

/**
 * Lazily extracts and caches a PDF's text on the File document itself
 * (extractionAttempted/extractedPages — see models/File.ts). Ensures the
 * same PDF is never re-parsed for every question.
 */
async function getOrExtractPages(file: InstanceType<typeof FileModel>) {
  if (file.extractionAttempted) {
    return file.extractedPages ?? [];
  }

  const buffer = await readStoredFile(
    file.storageProvider ?? undefined,
    file.publicId ?? undefined,
    file.workspaceId.toString()
  );
  const pages = buffer ? await extractPdfPages(buffer) : [];

  file.extractedPages = pages as typeof file.extractedPages;
  file.extractionAttempted = true;
  await file.save();

  return pages;
}

interface PdfMatch {
  fileId: string;
  fileName: string;
  pageNumber: number;
  text: string;
  score: number;
}

interface VideoMatch {
  fileId: string;
  fileName: string;
  timestampSeconds: number;
  text: string | null;
}

export const mockTeamB: TeamBService = {
  async query({ query, workspaceId, videoTimestamp }) {
    if (workspaceId === undefined) {
      // TeamBMockOnlyContext is optional on the shared TeamBService
      // interface (a real backend never needs it), but this LOCAL
      // simulation has no other way to scope its Mongo queries -- a
      // caller omitting it is a programming error in this codebase, not
      // a valid "no workspace" request, so this fails loudly rather than
      // silently querying across all workspaces.
      throw new Error(
        "mockTeamB.query() requires workspaceId (TeamBMockOnlyContext) -- the local mock has no other way to scope its results."
      );
    }
    const activeVideoTimestamp = videoTimestamp ?? null;
    if (isGreeting(query)) {
      return {
        answer:
          "Hi! I'm your AI tutor. Ask me a question about the course material you've uploaded, and I'll help explain it.",
        session_id: randomUUID(),
        source_attributions: [],
        retrieval_metadata: { mock: true, chunks_retrieved: 0 },
      };
    }

    const readyFiles = await FileModel.find({ workspaceId, status: "ready" });

    if (readyFiles.length === 0) {
      return {
        answer:
          "I don't have any ready course material in this workspace yet, so I can't ground an answer in it. Upload a PDF, MP4, or YouTube video and I'll be able to reference it directly.",
        session_id: randomUUID(),
        source_attributions: [],
        retrieval_metadata: { mock: true, chunks_retrieved: 0 },
      };
    }

    // --- PDF retrieval (unchanged mechanism from the previous phase) ---
    const pdfFiles = readyFiles.filter((file) => file.type === "pdf");
    let pdfMatch: PdfMatch | null = null;

    for (const pdfFile of pdfFiles) {
      const pages = await getOrExtractPages(pdfFile);
      const top = scorePages(query, pages)[0];
      if (top && top.score >= MIN_RETRIEVAL_SCORE && (!pdfMatch || top.score > pdfMatch.score)) {
        pdfMatch = {
          fileId: pdfFile._id.toString(),
          fileName: pdfFile.originalName,
          pageNumber: top.pageNumber,
          text: top.text,
          score: top.score,
        };
      }
    }

    // --- Video/transcript retrieval ---
    const activeVideo = readyFiles.find((file) => file.type === "video" || file.type === "youtube_url");
    const explicitTimestamp = parseTimestampFromQuery(query);
    let videoMatch: VideoMatch | null = null;
    let videoTranscriptUnavailable = false;

    if (activeVideo) {
      const transcriptProvider = getTranscriptProvider();
      const segments = await transcriptProvider.getSegments({
        fileId: activeVideo._id.toString(),
        originalName: activeVideo.originalName,
      });
      videoTranscriptUnavailable = segments.length === 0;

      if (explicitTimestamp !== null) {
        // "What is explained around 1:30?" — look up that exact time,
        // never guess the nearest segment if none actually covers it.
        const segment = findSegmentAtTime(segments, explicitTimestamp);
        if (segment) {
          videoMatch = {
            fileId: activeVideo._id.toString(),
            fileName: activeVideo.originalName,
            timestampSeconds: segment.start,
            text: segment.text,
          };
        }
      } else if (referencesCurrentMoment(query) && activeVideoTimestamp !== null) {
        // "What is being explained here?" — ground it in the segment
        // covering the REAL current position, if one exists.
        const segment = findSegmentAtTime(segments, activeVideoTimestamp);
        videoMatch = {
          fileId: activeVideo._id.toString(),
          fileName: activeVideo.originalName,
          timestampSeconds: activeVideoTimestamp,
          text: segment?.text ?? null,
        };
      } else if (referencesVideo(query) || !pdfMatch) {
        // A general video-related (or cross-material) question — score
        // transcript segments the same way PDF pages are scored.
        const top = scoreSegments(query, segments)[0];
        if (top && top.score >= MIN_RETRIEVAL_SCORE) {
          videoMatch = {
            fileId: activeVideo._id.toString(),
            fileName: activeVideo.originalName,
            timestampSeconds: top.start,
            text: top.text,
          };
        }
      }
    }

    // --- Compose the response ---
    //
    // Phase 2E correction: the mock's OWN internal simulation/scoring
    // logic above is completely unchanged -- only the shape returned at
    // the end is corrected here, to match Team 4B's REAL
    // `source_attributions` contract (types/teamB.ts's
    // `TeamBSourceAttribution`) instead of the earlier, incorrect
    // `citations` shape. `chunk_id` has no real analogue in this mock
    // (it has no actual chunk store) -- synthesized as a stable,
    // clearly-mock-only placeholder string. `relevance_score` uses the
    // real score already computed for a PDF match; the video-match
    // branches above do not currently track a numeric score through to
    // this point, so a fixed, documented placeholder (0.75, comfortably
    // above `MIN_RETRIEVAL_SCORE`) is used for those -- this is a mock
    // simulation detail, not a claim about real retrieval quality.
    const sourceAttributions: TeamBSourceAttribution[] = [
      pdfMatch && {
        document_id: pdfMatch.fileId,
        document_title: pdfMatch.fileName,
        chunk_id: `${pdfMatch.fileId}-p${pdfMatch.pageNumber}-mock`,
        relevance_score: pdfMatch.score,
        page_number: pdfMatch.pageNumber,
      },
      videoMatch && {
        document_id: videoMatch.fileId,
        document_title: videoMatch.fileName,
        chunk_id: `${videoMatch.fileId}-t${Math.round(videoMatch.timestampSeconds)}-mock`,
        relevance_score: 0.75,
        start_timestamp: videoMatch.timestampSeconds,
        end_timestamp: videoMatch.timestampSeconds,
      },
    ]
      .filter((attribution): attribution is NonNullable<typeof attribution> => Boolean(attribution))
      .slice(0, MAX_CITATIONS);

    const answerParts: string[] = [];
    if (pdfMatch) {
      answerParts.push(`According to "${pdfMatch.fileName}" (page ${pdfMatch.pageNumber}): ${excerpt(pdfMatch.text)}`);
    }
    if (videoMatch?.text) {
      answerParts.push(
        `In "${videoMatch.fileName}" around ${formatTimestamp(videoMatch.timestampSeconds)}: ${excerpt(videoMatch.text)}`
      );
    } else if (videoMatch) {
      // A video citation exists (real current position) but no transcript
      // segment covers it — never invent what's being said.
      answerParts.push(
        `I don't have transcript information covering that exact point in "${videoMatch.fileName}", but I can point you back to it so you can review it directly.`
      );
    }

    if (answerParts.length > 0) {
      return {
        answer: answerParts.join("\n\n"),
        session_id: randomUUID(),
        source_attributions: sourceAttributions,
        retrieval_metadata: { mock: true, chunks_retrieved: sourceAttributions.length },
      };
    }

    // Distinct from "no relevant content found": this video exists and is
    // ready, but has no mock transcript coverage at all (its title didn't
    // match any seeded topic) — an honest, more specific message than the
    // generic fallback, matching the required "Transcript unavailable for
    // this video" pattern rather than implying nothing in the workspace
    // was relevant when the real issue is this video's transcript itself.
    if (videoTranscriptUnavailable && (referencesVideo(query) || referencesCurrentMoment(query))) {
      return {
        answer: `Transcript information isn't available for "${activeVideo?.originalName}", so I can't ground an answer in it directly. You can still watch the video for the full explanation.`,
        session_id: randomUUID(),
        source_attributions: [],
        retrieval_metadata: { mock: true, chunks_retrieved: 0 },
      };
    }

    return {
      answer:
        "I don't have enough indexed content from this material to answer that question yet.",
      session_id: randomUUID(),
      source_attributions: [],
      retrieval_metadata: { mock: true, chunks_retrieved: 0 },
    };
  },

  /**
   * Stage 9B — dev/test realism only. This mock has no real token
   * generation to stream from, so it runs its own existing, unchanged
   * `query()` above to completion first (the SAME grounded answer,
   * SAME citations, SAME retrieval_metadata a caller would get from
   * `query()` directly), then re-delivers that already-known answer as a
   * word-by-word "delta" sequence before a final "done" event carrying
   * the complete response — giving local development (`USE_MOCK_TEAM_B`
   * unset/true) the same genuinely-incremental rendering experience as
   * the real streaming backend, without inventing a second, divergent
   * answer-generation path. The per-word delay below exists only so a
   * human watching the UI can see it stream; it is not exercised by this
   * repo's own mocked-service unit tests, which replace `getTeamBService`
   * with their own double entirely (see tests/unit/chat-api.test.ts).
   */
  async *queryStream(request: TeamBQueryRequest & Partial<TeamBMockOnlyContext>) {
    const result = await mockTeamB.query(request);
    const words = result.answer.split(" ").filter((word) => word.length > 0);

    for (const word of words) {
      yield { type: "delta" as const, text: `${word} ` };
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    yield { type: "done" as const, ...result };
  },
};
