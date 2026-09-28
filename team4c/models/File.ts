import { Schema, model, models, Types, type InferSchemaType, type Model } from "mongoose";

/**
 * Fields match docs/decisions.md §4 "files" exactly.
 *
 * MongoDB stores METADATA ONLY. `storageUrl` is a reference to where the
 * actual PDF/MP4 bytes live in object storage (or the YouTube URL itself for
 * `type: "youtube_url"`) — raw file bytes must never be written to this
 * collection (docs/decisions.md §8).
 *
 * `status` is intentionally restricted to the four locked lifecycle values
 * from docs/decisions.md §4 / docs/api-contracts.md §A.3. There is no
 * "uploaded" state — see the status lifecycle note there for why.
 */
export const FILE_STATUS_VALUES = ["uploading", "processing", "ready", "failed"] as const;
export type FileStatus = (typeof FILE_STATUS_VALUES)[number];

export const FILE_TYPE_VALUES = ["pdf", "video", "youtube_url"] as const;
export type FileType = (typeof FILE_TYPE_VALUES)[number];

const fileSchema = new Schema(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    // Denormalized alongside workspaceId (not derived via a join) so
    // ownership checks can run in a single query — see docs/decisions.md §3.
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    originalName: {
      type: String,
      required: true,
      trim: true,
    },
    type: {
      type: String,
      enum: FILE_TYPE_VALUES,
      required: true,
    },
    storageUrl: {
      type: String,
      required: true,
    },
    storageProvider: {
      type: String,
      required: false,
    },
    publicId: {
      type: String,
      required: false,
    },
    status: {
      type: String,
      enum: FILE_STATUS_VALUES,
      required: true,
      default: "uploading",
    },
    processingError: {
      type: String,
      required: false,
      default: null,
    },
    ingestionId: {
      type: String,
      required: false,
    },
    /**
     * Stage 9 — client-generated (crypto.randomUUID(), team4c/components/
     * shared/workspace-files.tsx's own existing per-upload `uploadId`,
     * reused as-is rather than inventing a second identifier) and stable
     * across every retry of the SAME logical upload attempt, never
     * regenerated on retry. Lets `POST /api/workspaces/[id]/files`
     * recognize "this is a retry of an attempt whose response the client
     * never received" and reuse the existing File (retrying ingestion on
     * its already-stored bytes) instead of creating a second File
     * document with a second stored copy of the same content — see
     * lib/ingestion.ts's `resolveUploadedFile()`.
     *
     * `unique: true` + `sparse: true` — same pattern as `Conversation.
     * ragSessionId` — enforces no two Files ever share a key once one is
     * assigned, while permitting any number of documents with no key at
     * all (a request that never sent one; every pre-Stage-9 document).
     */
    uploadIdempotencyKey: {
      type: String,
      required: false,
      unique: true,
      sparse: true,
    },
    // Rev.4.4 Phase 1 (authorized minimal schema addition): the
    // authoritative current ingestion generation for this File. Team 4A's
    // MongoAuthorityClient is the only external consumer that ever writes
    // this field, via a single atomic conditional update equivalent to
    // `currentIngestionGeneration <= candidateGeneration -> set to
    // candidateGeneration` (never any other comparison, never a broader
    // write) -- see the Phase 1 architecture correction report for the
    // full read/write contract. Team 4A never creates a File document to
    // populate this field; it only ever conditionally updates one that
    // already exists. `default: 0` applies to newly-created File
    // documents going forward only -- it does NOT retroactively add the
    // field to documents that already exist in the database (Mongoose
    // schema defaults are applied at document-creation time, not
    // reactively to already-persisted documents), so pre-existing File
    // records remain exactly as they are until an explicit, separate,
    // deliberately-authorized migration backfills them -- not performed
    // as part of this schema change.
    currentIngestionGeneration: {
      type: Number,
      required: false,
      default: 0,
    },
    pageCount: {
      type: Number,
      required: false,
    },
    durationSeconds: {
      type: Number,
      required: false,
    },
    // Added for Accion Labs Requirement 5.6 (File_Manager must display file
    // size) — no field previously existed to store this. Not applicable to
    // youtube_url materials (no local bytes), left undefined for those.
    sizeBytes: {
      type: Number,
      required: false,
    },
    // Mock Team B's PDF grounding (Accion Labs local-mock retrieval): real,
    // page-by-page extracted text, cached here so the same PDF is never
    // re-parsed on every chat question. Workspace isolation is inherited
    // for free — this field only ever exists on a File document that
    // already belongs to exactly one workspaceId, same as every other
    // field here. `extractionAttempted` distinguishes "not yet tried" from
    // "tried and genuinely found nothing/failed," so a PDF that fails to
    // parse isn't retried forever on every question.
    extractedPages: {
      type: [
        {
          _id: false,
          pageNumber: { type: Number, required: true },
          text: { type: String, required: true },
        },
      ],
      required: false,
    },
    extractionAttempted: {
      type: Boolean,
      required: false,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

export type File = InferSchemaType<typeof fileSchema> & {
  _id: Types.ObjectId;
};

export const FileModel: Model<File> = models.File ?? model<File>("File", fileSchema);
