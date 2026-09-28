# M6 Repository Cleanup Audit

**Date:** 2026-09-17
**Type:** Read-only audit. No files were deleted, moved, renamed, or modified other than this report.
**Scope:** `D:\Major_Project\project\EduCopilot-M6-Local\EduCopilot-M6-Local` (repository root — not yet a git repository).

This audit inventories the complete project tree ahead of its first
GitHub checkpoint and classifies every area into KEEP / IGNORE / DELETE
CANDIDATE / REVIEW REQUIRED / LARGE FILE / POSSIBLE SECRET. Nothing was
deleted, moved, renamed, or edited as part of this audit except the
creation of this report file itself.

---

## 1. Project Structure Summary

```
EduCopilot-M6-Local/                          (NOT a git repository — confirmed via `git status`)
├── .claude/                                  tool-local session state (not project content)
├── diagnose_youtube_doc.py                   loose root-level one-off diagnostic script
├── youtube-retrieval-diagnostic.txt          captured output of the above
├── docs/                                     project-level documentation (canonical)
├── infra/                                    placeholder infra docs (canonical, intentionally minimal)
├── scripts/                                  top-level orchestration scripts (canonical)
├── team4a/                                   CANONICAL — active ingestion service
├── team4a-backup-before-transcript-windowing/  non-canonical pre-change snapshot of team4a
├── team4a-before-youtube-hindi-fallback/       non-canonical pre-change snapshot of team4a
├── team4a-new/                               non-canonical — despite the name, an OLD duplicate (see §9)
├── team4b/                                   CANONICAL — active RAG/retrieval service
├── team4b-context-provenance-temp/           non-canonical pre-Phase-4B snapshot of team4b
└── team4c/                                   CANONICAL — active Next.js frontend/API
```

`docs/EDUCOPILOT_MASTER_HANDOFF.md` (§"Canonical vs. non-canonical
directories", written 2026-09-17, prior to this audit) already
identifies the same four non-canonical directories independently. This
audit's own file-by-file diffing (§9) corroborates that documentation
exactly — a useful independent cross-check, not a coincidence.

**Total files inspected (excluding `node_modules`/`.next`/`.git`):** 1,342 files across 197 directories.
**Total files including `node_modules`:** 40,656 (node_modules alone accounts for ~39,300 of these — see §11).

---

## 2. KEEP List

### A. Source code (canonical)
- `team4a/app/**/*.py` — ingestion service source
- `team4b/app/**/*.py` — RAG/retrieval service source
- `team4c/app/**`, `components/**`, `hooks/**`, `lib/**`, `models/**`, `services/**`, `store/**`, `types/**` — Next.js frontend/API source

### B. Tests
- `team4a/tests/**/*.py`
- `team4b/tests/**/*.py` (includes the Phase 2/3/4E/4E-F1 test suites)
- `team4c/tests/**` (Vitest/Playwright)

### C. Documentation
- `docs/EDUCOPILOT_MASTER_HANDOFF.md`, `docs/M6-LOCAL-ENV.md`, `docs/M6-LOCAL-INTEGRATION-FINAL.md`
- `infra/README.md` (intentionally a placeholder — documents a real architectural decision, not filler)
- `team4a` — no dedicated docs dir; relevant decisions live in the master handoff
- `team4b/README.md`, `team4b/docs/CONTRACT_DECISIONS.md`
- `team4c/README.md`, `team4c/AGENTS.md`, `team4c/CLAUDE.md`, `team4c/docs/api-contracts.md`, `team4c/docs/decisions.md`

### D. Reproducible evaluation artifacts (Phase 2–4E-F1)
All of the following in `team4b/data/` are genuine, reproducible
engineering artifacts (final reports and their supporting raw data),
not throwaway debug output — **keep all of them**:
- `phase2_evaluation_report.json`, `phase2_ground_truth_candidate.json` + `_review.md`, `phase2_ground_truth_approved.json`
- `phase3_generalized_ground_truth_candidate.json` + `_review.md`
- `phase4a_generalized_embedding_evaluation_report.json`
- `phase4b_reranking_benchmark_report.json`
- `phase4c_candidate_recall_diagnosis.json` + `_review.md`, plus supporting raw data `_phase4c_mongo_alignment_raw.json`, `_phase4c_part_bcd_raw.json`
- `phase4d_cross_lingual_embedding_evaluation.json` + `_review.md`, plus supporting raw data `_phase4d_step123_raw.json`, `_phase4d_step4_reranker_raw.json`
- `phase4e_workspace_rag_safety_report.json` + `_review.md`
- `evaluation_results.jsonl`
- `team4b/scripts/phase2_multilingual_embedding_evaluation.py` (the reproducible harness itself)
- `team4b/scripts/fix_service_jwt_public_keys_json.py` (reproducible tooling, has its own test file)

The `_raw.json` files are intermediate data that the corresponding
final report was built from — keeping them preserves reproducibility of
how the aggregate numbers were derived, consistent with this audit's
own instruction not to delete evaluation artifacts merely because they
look like intermediate output.

### E. Configuration / templates
- `team4a/Dockerfile`, `docker-compose.yml`, `.dockerignore`, `requirements.txt`
- `team4b/Dockerfile`, `docker-compose.yml`, `docker-compose.dev.yml`, `.dockerignore`, `requirements.txt`, `requirements-dev.txt`, `pytest.ini`
- `team4b/.env.example`, `team4b/.env.docker.example` (placeholders only — safe)
- `team4c/.env.example` (placeholder only — safe)
- `team4c/package.json`, `package-lock.json`, `tsconfig.json`, `next.config.ts`, `eslint.config.mjs`, `postcss.config.mjs`, `playwright.config.ts`, `vitest.config.mts`, `components.json`
- `team4c/.gitignore` (already well-formed — see §13)
- `scripts/*.ps1` (top-level start-all/stop-all/health-check/e2e-smoke orchestration)
- `team4c/scripts/interop-generate-tokens.ts`, `seed.ts`
- `team4c/public/*.svg` (standard framework scaffold assets; harmless, low priority)

---

## 3. IGNORE List (keep locally, never commit)

| Path/pattern | Reason |
|---|---|
| `**/__pycache__/` (35 instances found) | Python bytecode cache, regenerated automatically |
| `team4a*/.pytest_cache/`, `team4b/.pytest_cache/` | pytest cache |
| `team4a*/.hypothesis/`, `team4b/.hypothesis/`, `team4a-new/.../.hypothesis/`, `team4b-context-provenance-temp/.../.hypothesis/` | Hypothesis property-testing example cache |
| `team4c/node_modules/` (464 top-level packages, ~1.4 GB total for team4c) | npm dependency tree, regenerated by `npm install` |
| `team4c/.next/` (362 MB) | Next.js build output, regenerated by `npm run build`/`dev` |
| `team4c/.local-uploads/` (4.9 MB, one real uploaded PDF) | Local dev file-upload storage — already correctly excluded by `team4c/.gitignore`'s own `/.local-uploads` entry |
| `team4c/tsconfig.tsbuildinfo`, `team4c/next-env.d.ts` | TypeScript/Next.js generated files |
| `.claude/scheduled_tasks.lock` | Claude Code tool's own local session-lock file — not project content at all |
| All `.env` / `.env.*` files except `*.example` | See §7, POSSIBLE SECRETS |
| `team4a-backup-before-transcript-windowing/`, `team4a-before-youtube-hindi-fallback/`, `team4a-new/`, `team4b-context-provenance-temp/` | Non-canonical backup/duplicate directories — see §9. Recommended to exclude from Git while optionally keeping locally for rollback comfort; see §5 for why DELETE was not chosen. |

No local Qdrant/MongoDB/Redis/Ollama data directories exist inside the
repository tree — all three docker-compose files use **named Docker
volumes** (`qdrant_storage`, `redis_data`, `team4b-dev-ollama-models`,
etc.), which Docker stores outside the project directory. There is
nothing to gitignore for these; they were never at risk of being
committed.

---

## 4. DELETE CANDIDATE List

| PATH | TYPE | REASON | REFERENCED? | SAFE TO DELETE? | CONFIDENCE |
|---|---|---|---|---|---|
| `diagnose_youtube_doc.py` | one-off diagnostic script (root) | Hardcoded specific video URL/document_id, connects directly to localhost Mongo/Qdrant; not part of the reproducible `team4b/scripts/` tooling; sits loose at repo root | NO | YES | High |
| `youtube-retrieval-diagnostic.txt` | captured script output (root) | Raw PowerShell-captured (UTF-16) console dump of running the script above | NO | YES | High |
| `team4b/m6-4b-503.log` | captured server-startup log | PowerShell-captured (UTF-16) uvicorn startup log from investigating a 503 error; pure debug output | NO | YES | High |
| `team4b/app/core/config.py.backup` | sibling backup file | Manual "just in case" copy made before an edit; git supersedes this going forward | NO | YES | High |
| `team4b/app/core/config.py.m6-before-num-predict` | sibling backup file | Same as above | NO | YES | High |
| `team4b/app/services/casual_intent.py.before-hinglish-fix` | sibling backup file | Same as above | NO | YES | High |
| `team4b/app/services/llm_generator.py.backup` | sibling backup file | Same as above | NO | YES | High |
| `team4b/app/services/llm_generator.py.m6-backup` | sibling backup file | Same as above | NO | YES | High |
| `team4b/app/services/llm_generator.py.m6-before-num-predict` | sibling backup file | Same as above | NO | YES | High |
| `team4b/app/services/rag_service.py.m6-backup` | sibling backup file | Same as above | NO | YES | High |
| `team4b/app/services/vector_store.py.bak` | sibling backup file | Same as above | NO | YES | High |
| `team4b/tests/fakes.py.bak` | sibling backup file | Same as above | NO | YES | High |
| `team4b/tests/fakes.py.m6-before-num-predict` | sibling backup file | Same as above | NO | YES | High |
| `team4b/tests/test_casual_intent.py.before-hinglish-fix` | sibling backup file | Same as above | NO | YES | High |
| `team4b/tests/test_llm_generator.py.m6-before-num-predict` | sibling backup file | Same as above | NO | YES | High |
| `team4b/tests/test_ragas_adapter.py.m6-before-ragas-fix` | sibling backup file | Same as above | NO | YES | High |
| `team4b/tests/test_vector_store.py.bak` | sibling backup file | Same as above | NO | YES | High |
| `team4c/hooks/useActiveConversation.ts.bak` | sibling backup file | Same pattern as the team4b `.bak` files | NO | YES | High |

All 15 `team4b` sibling backup files total ≈253 KB and were confirmed,
by grepping `app/`, `tests/`, and `scripts/` for their filenames, to be
referenced by **nothing** — no import, no test, no script. The single
`.bak` reference that does exist in the codebase
(`scripts/fix_service_jwt_public_keys_json.py`'s own runtime-generated
`.env.bak`) is an unrelated, intentional feature of that script, not a
reference to any file in this table.

None of these 18 items are large; they are flagged for cleanliness, not
storage size. **Recommendation: delete all 18 once approved** — their
history is fully recoverable from normal editor undo/git history going
forward, and none of them serve a documented purpose.

---

## 5. Backup Directory Analysis (Section 5 of the audit brief)

Per the audit's own instruction, backup **directories** are NOT
automatically classified as delete candidates — each was diffed against
its live counterpart.

| Directory | Diffed against | Unique source? | Verdict |
|---|---|---|---|
| `team4a-backup-before-transcript-windowing/` | `team4a/` | **No.** Only 2 files differ (`app/config/settings.py`, `app/pipeline/canonical_extraction.py`) and both are strictly older versions; `team4a` additionally has `app/pipeline/transcript_windowing.py` and 3 test files this backup lacks entirely. | Strict subset of current `team4a`. Safe to exclude from Git (**F. IGNORE**). Safe to delete entirely if the user does not want local rollback copies — but this audit does not delete it without explicit approval. |
| `team4a-before-youtube-hindi-fallback/` | `team4a/` | **No.** Same 2 files differ (older versions); missing only `tests/test_youtube_language_fallback.py` relative to current `team4a`. | Same as above — **F. IGNORE**, DELETE only with approval. |
| `team4b-context-provenance-temp/rag_service/` | `team4b/` | **No.** Missing `reranker.py` entirely (predates Phase 4B) and the whole `data/` directory (predates any Phase 2+ evaluation work); every file that differs is an older version of a file that still exists in current `team4b`. | Strict subset/predecessor of current `team4b`. **F. IGNORE**, DELETE only with approval. |
| `team4a-new/4a-service/` | `team4a-before-youtube-hindi-fallback/` and `team4a/` | **No — and notably misleading.** Byte-for-byte identical to `team4a-before-youtube-hindi-fallback` in both `app/` and `tests/` (zero diff output). Despite its name, this is **not** a newer reorganization attempt with any actual different content — it is a duplicate of an already-superseded backup, just relocated under a `4a-service/` subfolder. | Triple-redundant: a copy of a copy. **F. IGNORE** at minimum; the strongest delete candidate of the four non-canonical directories since it adds zero unique value even as a rollback point (the other backup already covers the same state). DELETE only with approval. |

**Cross-reference (Section 13 requirement):** none of these four
directories are referenced by any Python import, TypeScript import,
test, `package.json` script, shell/PowerShell script, Dockerfile, or
docker-compose file. The only reference anywhere in the repository is
descriptive: `docs/EDUCOPILOT_MASTER_HANDOFF.md`'s own "Canonical vs.
non-canonical directories" section, written to warn future sessions not
to edit them — which independently corroborates this audit's diff-based
findings.

**Recommendation:** classify all four as **F. IGNORE** for the initial
GitHub checkpoint (add to `.gitignore` by exact name, per §13 below).
Do not delete them in this pass. If the user later confirms rollback
safety is no longer needed, `team4a-new/` is the safest of the four to
delete outright (zero unique content, is itself a duplicate of another
backup already on this list).

---

## 6. Duplicate-Directory Analysis

This is the same finding as §5 from a different angle: the four
non-canonical directories above are the only duplicate source trees in
the repository. There are no other duplicate/extracted-ZIP/parallel
implementation copies anywhere else in the tree (no `team4b-backup`,
no `old-team4c`, no extracted archive folders were found).

---

## 7. Temporary-Script Analysis

| Script | Classification | Reasoning |
|---|---|---|
| `team4b/scripts/phase2_multilingual_embedding_evaluation.py` | **KEEP — reproducible evaluation infrastructure** | Actively used across Phases 2, 4A, and 4D; has its own test file (`test_phase2_evaluation_harness.py`); explicitly designed with canonical-collection write-safety guards. Not a one-off. |
| `team4b/scripts/fix_service_jwt_public_keys_json.py` | **KEEP — reproducible tooling** | Has its own test file (`test_fix_service_jwt_public_keys_json.py`); general-purpose `.env` repair tool, not phase-specific or one-off. |
| `diagnose_youtube_doc.py` (root) | **DELETE CANDIDATE** | Hardcoded to one specific video/document; a genuine one-off diagnostic, not reusable tooling; not located in any of the project's own `scripts/` directories (a structural tell that it was never intended as permanent tooling). See §4. |
| `scripts/*.ps1` (top-level) | **KEEP — project orchestration** | `start-all.ps1`/`stop-all.ps1`/`health-check.ps1`/`e2e-smoke.ps1` are general-purpose, reusable operational tooling, not phase-specific diagnostics. |
| `team4c/scripts/interop-generate-tokens.ts`, `seed.ts` | **KEEP — project tooling** | General-purpose dev tooling (token generation for interop testing, DB seeding), referenced by `package.json` scripts. |

No `patch_*`, `run_*` (beyond the ones above), or `build_*` scripts were
found committed anywhere in the tracked project tree. (Note: several
Phase 4A–4E-F1 driver/build scripts used during earlier phases of this
engagement were deliberately kept in this session's own scratchpad
temp directory outside the repository, per those phases' own documented
decisions — they are not part of this repository at all and are outside
this audit's scope.)

---

## 8. Build/Cache Analysis

| Item | Location(s) | Approx. size | Disposition |
|---|---|---|---|
| `__pycache__/` | 35 locations across `team4a*`, `team4a-new`, `team4b`, `team4b-context-provenance-temp` | small, several KB each | IGNORE |
| `.pytest_cache/` | `team4a/`, `team4a-backup-before-transcript-windowing/`, `team4a-before-youtube-hindi-fallback/`, `team4b/` | 81–155 KB each | IGNORE |
| `.hypothesis/` | `team4a/`, both `team4a` backups, `team4a-new/4a-service/`, `team4b/`, `team4b-context-provenance-temp/rag_service/` | 73–125 KB each | IGNORE |
| `team4c/node_modules/` | `team4c/` | ~1.4 GB (464 top-level packages) | IGNORE — regenerate via `npm install` |
| `team4c/.next/` | `team4c/` | 362 MB | IGNORE — regenerate via `npm run build`/`dev` |
| `team4c/tsconfig.tsbuildinfo` | `team4c/` | small | IGNORE |

No `.mypy_cache`, `.ruff_cache`, `.venv`/`venv`, `dist`, `coverage`, or
`htmlcov` directories were found anywhere in the tree. No local
Qdrant/MongoDB/Redis/Ollama data directories exist inside the repo (see
§3) — nothing was found or touched there.

---

## 9. Documentation Analysis

All documentation found is legitimate and current:
- `docs/EDUCOPILOT_MASTER_HANDOFF.md` (24 KB) — the authoritative
  cross-team handoff document; explicitly must be kept regardless of
  size, per this audit's own instructions.
- `docs/M6-LOCAL-ENV.md` (6.6 KB), `docs/M6-LOCAL-INTEGRATION-FINAL.md` (11 KB) — environment/integration reference docs.
- `team4b/README.md` (27 KB), `team4b/docs/CONTRACT_DECISIONS.md` (4.9 KB).
- `team4c/README.md`, `AGENTS.md`, `CLAUDE.md`, `docs/api-contracts.md`, `docs/decisions.md`.
- `infra/README.md` — a single-sentence placeholder, but a deliberate
  architectural statement (documents why infra config is *not*
  duplicated here), not filler — keep.

No documentation was found that is stale, orphaned, or safe to remove.
Nothing was removed for being "merely large."

---

## 10. Recommended `.gitignore` Entries

No root-level `.gitignore` currently exists (the repository is not yet
under version control). `team4c/.gitignore` already exists and is
well-formed — keep it as-is; it will continue to apply automatically to
everything under `team4c/` once a root `.gitignore` is added. Recommend
creating a root-level `.gitignore` with (at minimum):

```gitignore
# Python
__pycache__/
*.pyc
*.pyo
.pytest_cache/
.hypothesis/
.mypy_cache/
.ruff_cache/
*.egg-info/
.venv/
venv/

# Environment / secrets — never commit real values, only *.example
.env
.env.*
!.env.example
!.env.docker.example

# Sibling backup files created by hand during editing (superseded by git history)
*.backup
*.bak
*.m6-backup
*.m6-before-*
*.before-*

# Node / Next.js (team4c already has its own .gitignore covering this,
# kept here too in case the root becomes the effective git root for a
# tool that doesn't descend into nested .gitignore files)
node_modules/
.next/
*.tsbuildinfo
next-env.d.ts

# Captured/ad-hoc debug output
*.log

# Non-canonical backup/duplicate project-copy directories (see the
# audit report, §5/§6, for why these exist and why they are excluded
# rather than deleted)
/team4a-backup-before-transcript-windowing/
/team4a-before-youtube-hindi-fallback/
/team4a-new/
/team4b-context-provenance-temp/

# Tool-local session state (Claude Code), not project content
/.claude/
```

Do **not** add `team4b/data/` or any `*_raw.json`/`*.jsonl` pattern to
`.gitignore` — those are the reproducible evaluation artifacts this
audit explicitly keeps (§2.D).

---

## 11. Files That Must NOT Enter GitHub (§9 of the audit brief — Secrets)

**Filenames only — no values were read or printed.**

| Filename | Location | Classification |
|---|---|---|
| `.env` | `team4a/` | POSSIBLE SECRET — must not be committed |
| `.env.before-youtube-hindi-fallback` | `team4a/` | POSSIBLE SECRET (also a backup — double reason to exclude) |
| `.env` | `team4a-backup-before-transcript-windowing/` | POSSIBLE SECRET |
| `.env` | `team4a-before-youtube-hindi-fallback/` | POSSIBLE SECRET |
| `.env` | `team4b/` | POSSIBLE SECRET — must not be committed |
| `.env` | `team4c/` | POSSIBLE SECRET — must not be committed |
| `service-jwt-private-key.pem` | `team4c/` | **POSSIBLE SECRET — private key. Highest priority. Must never be committed.** |
| `service-jwt-public-key.pem` | `team4c/` | Lower risk (public key) but still excluded by convention (`team4c/.gitignore` already has `*.pem`) — keep excluded for consistency. |

Safe, non-secret templates that **should** be committed (already
correctly named to signal this):
- `team4b/.env.example`, `team4b/.env.docker.example`
- `team4c/.env.example`

`team4c/.gitignore` already excludes `*.pem` and `.env*` (except
`.env.example`) — good existing practice, worth mirroring at the root
for `team4a`/`team4b` (see §10's recommended entries above). No
`.env`/key file was opened or its contents printed during this audit.

---

## 12. Large Files (§8 of the audit brief)

| File | Size | Purpose | Classification |
|---|---|---|---|
| `team4c/.local-uploads/6a912a1883f46878932e0eec/8abe8b04-ca10-47f5-935d-a47ad7563c46-R20CSE2202-OPERATING-SYSTEMS.pdf` | 4.7 MB | A real user-uploaded course PDF, captured by Team4C's local dev upload storage | **IGNORE** — already excluded by `team4c/.gitignore`'s `/.local-uploads` entry; this is runtime data, not a project asset |
| `team4c/.next/` (build output) | 362 MB | Next.js build cache | IGNORE (see §8) |
| `team4c/node_modules/` | ~1.4 GB | npm dependencies | IGNORE (see §8) |

No other file outside `node_modules`/`.next` exceeds 1 MB anywhere in
the repository. No PDFs, videos, model files, ZIPs, or database files
were found in any canonical project directory. **Nothing requires Git
LFS** — no legitimate, must-commit asset in this repository is large
enough to need it, and none was introduced.

---

## 13. Files Safe for GitHub

Everything listed in §2 (KEEP, categories A–E) is safe to commit as-is.
This is the bulk of the 1,342 non-`node_modules`/`.next` files: all
`team4a/app`, `team4a/tests`, `team4b/app`, `team4b/tests`,
`team4b/scripts` (the two real scripts), `team4b/data` (all phase
artifacts), `team4c/app`, `components`, `hooks`, `lib`, `models`,
`services`, `store`, `types`, `tests`, `public`, plus all documentation
and configuration/template files named in §2.

---

## 14. Items Requiring User Approval Before Deletion

Nothing has been deleted. The following require an explicit go-ahead
before any destructive action is taken:

1. **18 items in §4** (loose root diagnostics + 15 `team4b` sibling
   backup files + 1 `team4c` sibling backup file) — high-confidence,
   unreferenced clutter. Recommended for deletion once approved.
2. **4 non-canonical directories in §5** (`team4a-backup-before-transcript-windowing`,
   `team4a-before-youtube-hindi-fallback`, `team4a-new`,
   `team4b-context-provenance-temp`) — recommended to **exclude from
   Git** (via `.gitignore`, not deletion) in this pass; deletion is a
   separate, optional decision the user can make later once comfortable
   they no longer need local rollback copies. `team4a-new` is the
   single strongest outright-deletion candidate among the four, being a
   duplicate of another duplicate with zero unique content.
3. **Whether to physically relocate `diagnose_youtube_doc.py` /
   `youtube-retrieval-diagnostic.txt`** instead of deleting, if the user
   wants to keep the forensic investigation for historical reference —
   an alternative to outright deletion, worth asking about explicitly
   since these did resolve a real bug investigation.

---

## 15. Review Required

No item could not be confidently classified. `team4c/public/*.svg`
(default Next.js scaffold icons) are borderline-unnecessary boilerplate
but harmless and tiny; left as KEEP rather than flagged, since removing
them would require confirming they're unreferenced in the UI, which is
outside this audit's inventory scope.

---

## 16. Final Summary

TOTAL FILES/FOLDERS INSPECTED:
    1,342 files across 197 directories (excluding node_modules/.next/.git); 40,656 files if node_modules is included.

KEEP:
    All canonical team4a/team4b/team4c source, tests, docs, and config — the large majority of the 1,342 files.

IGNORE:
    __pycache__ (35), .pytest_cache (4), .hypothesis (6), node_modules (~1.4 GB), .next (362 MB),
    .local-uploads (4.9 MB), tsconfig.tsbuildinfo, .claude/, all real .env files, the 4 non-canonical
    backup/duplicate directories (pending user decision — see item 2 above).

DELETE CANDIDATES:
    18 items — 2 loose root diagnostic files, 15 team4b sibling backup files (*.backup/*.bak/*.m6-*/*.before-*),
    1 team4c sibling backup file. Total ≈260 KB. All confirmed unreferenced by any code/test/script.

REVIEW REQUIRED:
    None outstanding.

POSSIBLE SECRETS:
    7 .env files (team4a x3 incl. one backup-named, team4b, team4c, plus 2 backup-dir copies) +
    1 private key (team4c/service-jwt-private-key.pem, highest priority) + 1 public key (team4c/service-jwt-public-key.pem).

LARGE FILES:
    1 real asset (4.7 MB uploaded PDF, already gitignored) + 2 regenerable build artifacts
    (node_modules ~1.4 GB, .next 362 MB). Nothing requires Git LFS.

DUPLICATE DIRECTORIES:
    4 — team4a-backup-before-transcript-windowing, team4a-before-youtube-hindi-fallback, team4a-new
    (itself a duplicate of the previous one — misleadingly named), team4b-context-provenance-temp.
    None contain unique source; all are strict historical subsets of their canonical counterparts.

BACKUP DIRECTORIES:
    Same 4 as above (backup directories and duplicate directories are the same finding here).

FILES THAT MUST NOT BE COMMITTED:
    All real .env files, team4c/service-jwt-private-key.pem (critical), team4c/service-jwt-public-key.pem.

FILES REQUIRING USER APPROVAL:
    The 18 delete candidates (§4/§14 item 1) and the disposition of the 4 non-canonical
    directories (§5/§14 item 2) — recommended as IGNORE-not-DELETE for this pass.

DELETIONS PERFORMED (AT THIS AUDIT'S ORIGINAL WRITING):
    NONE

MODIFICATIONS PERFORMED (AT THIS AUDIT'S ORIGINAL WRITING):
    Only this audit report (docs/M6_REPOSITORY_CLEANUP_AUDIT.md) was created. No other file was
    deleted, moved, renamed, or edited. Git was not initialized. No GitHub repository was created,
    committed to, or pushed to.

---

## 17. CLEANUP APPROVED AND EXECUTED (2026-09-17, follow-up to this audit)

The user reviewed this audit and explicitly approved a scoped cleanup.
The sections above are preserved unchanged as the historical audit
record; this section documents what was actually done afterward.

### 18 approved files deleted (exact paths, no wildcards used)

Each path was verified to exist and match this audit's own §4 list
immediately before deletion:

1. `diagnose_youtube_doc.py`
2. `youtube-retrieval-diagnostic.txt`
3. `team4b/m6-4b-503.log`
4. `team4b/app/core/config.py.backup`
5. `team4b/app/core/config.py.m6-before-num-predict`
6. `team4b/app/services/casual_intent.py.before-hinglish-fix`
7. `team4b/app/services/llm_generator.py.backup`
8. `team4b/app/services/llm_generator.py.m6-backup`
9. `team4b/app/services/llm_generator.py.m6-before-num-predict`
10. `team4b/app/services/rag_service.py.m6-backup`
11. `team4b/app/services/vector_store.py.bak`
12. `team4b/tests/fakes.py.bak`
13. `team4b/tests/fakes.py.m6-before-num-predict`
14. `team4b/tests/test_casual_intent.py.before-hinglish-fix`
15. `team4b/tests/test_llm_generator.py.m6-before-num-predict`
16. `team4b/tests/test_ragas_adapter.py.m6-before-ragas-fix`
17. `team4b/tests/test_vector_store.py.bak`
18. `team4c/hooks/useActiveConversation.ts.bak`

All 18 confirmed deleted; no other file was touched.

### 4 backup directories — retained locally, not deleted

- `team4a-backup-before-transcript-windowing/`
- `team4a-before-youtube-hindi-fallback/`
- `team4a-new/`
- `team4b-context-provenance-temp/`

Confirmed still present after cleanup. A root-level `.gitignore` was
created (none existed before) with exact-name entries for these four
directories (`/team4a-backup-before-transcript-windowing/`,
`/team4a-before-youtube-hindi-fallback/`, `/team4a-new/`,
`/team4b-context-provenance-temp/`) — no broad/wildcard ignoring of
unrelated directories was added.

### Secrets — retained locally, ignored, never printed or copied

- All real `.env` files (`team4a/.env`, `team4a/.env.before-youtube-hindi-fallback`,
  `team4a-backup-before-transcript-windowing/.env`,
  `team4a-before-youtube-hindi-fallback/.env`, `team4b/.env`, `team4c/.env`)
  confirmed still present. The new root `.gitignore` adds `.env` / `.env.*`
  (with `!.env.example` / `!.env.docker.example` exceptions), matching
  `team4c/.gitignore`'s existing pattern.
- `team4c/service-jwt-private-key.pem` and `team4c/service-jwt-public-key.pem`
  confirmed still present. The new root `.gitignore` adds `*.pem`
  (`team4c/.gitignore` already had this at the team4c level).
- No secret file's contents were read, printed, or copied into any
  other file at any point in this cleanup.

### Generated directories — retained/ignored, not deleted

`__pycache__/`, `.pytest_cache/`, `.hypothesis/`, `team4c/node_modules/`,
`team4c/.next/` were left completely untouched (nothing in the cleanup
targeted them for deletion). The new root `.gitignore` adds ignore
patterns for all of them so a future `git init` + first commit will not
pick them up; `team4c/.gitignore` already covered `node_modules` and
`.next` at the team4c level.

### Project artifacts — nothing removed

Team4A/Team4B/Team4C source, all tests, all documentation, and every
Phase 2 / Phase 3 / Phase 4A / Phase 4B / Phase 4C / Phase 4D / Phase 4E
/ Phase 4E-F1 artifact in `team4b/data/` (18 files, verified present by
count after cleanup) were left untouched. `team4b/scripts/`'s two
reproducible scripts, all package manifests
(`package.json`/`package-lock.json`/`requirements*.txt`), Docker/infra
configuration, and `.env.example`/`.env.docker.example` templates were
all left untouched.

### Verification performed

- `pytest --collect-only` in `team4b/`: **1277 tests collected, 0
  errors** (confirms no import breakage from the deletions — none of
  the 18 deleted files were importable Python modules in the first
  place, since none had a bare `.py` extension).
- `pytest --collect-only` in `team4a/`: **865 tests collected, 0
  errors**.
- `team4c/hooks/useActiveConversation.ts` (the real file, not its
  deleted `.bak` sibling) confirmed present and untouched.
- `team4c/tests/` directory confirmed present.
- `git status` at repository root: `fatal: not a git repository` —
  confirmed still not initialized, exactly as expected. Git was **not**
  initialized as part of this cleanup.
- No `git init`, `git add`, `git commit`, `git push`, branch creation,
  or GitHub repository creation was performed.

### Final safety check

APPROVED FILES DELETED:
    18/18 — see the exact path list above; all verified gone by re-check after deletion.

BACKUP DIRECTORIES RETAINED:
    4/4 — team4a-backup-before-transcript-windowing, team4a-before-youtube-hindi-fallback,
    team4a-new, team4b-context-provenance-temp — all verified present after cleanup.

SECRET FILES RETAINED:
    8 files retained (6 .env files + 2 .pem files). Contents never read, printed, or copied.

GENERATED DIRECTORIES:
    __pycache__, .pytest_cache, .hypothesis, team4c/node_modules, team4c/.next — all left in
    place, untouched, now covered by the new root .gitignore.

PROJECT SOURCE:
    Unchanged — team4a/team4b/team4c application source untouched; verified via clean pytest
    collection in team4a and team4b (no import errors) and direct inspection of team4c.

TESTS:
    Unchanged — no test file deleted or edited; both Python test suites collect cleanly.

DOCUMENTATION:
    Unchanged except this cleanup-audit file itself (this §17 addendum) and the new root
    .gitignore. No README/handoff/decision doc was touched.

GIT:
    Not initialized. `git status` at repo root still reports "not a git repository", as expected.
    No commit, push, branch, or GitHub repository was created.

Stopping here per this cleanup task's explicit instructions — waiting
for the next GitHub initialization instruction before any further
action.
