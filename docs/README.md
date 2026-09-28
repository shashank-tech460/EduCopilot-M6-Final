# Documentation Index

Full index of EduCopilot M6's documentation, organized by topic. Start at
the root [../README.md](../README.md) for a five-minute orientation, or
[DEVELOPER_HANDOFF.md](DEVELOPER_HANDOFF.md) if you're taking this project
over without prior context.

## Getting started

| Document | Covers |
|---|---|
| [../README.md](../README.md) | Project overview, features, quick setup, test commands |
| [SETUP.md](SETUP.md) | Full installation walkthrough, quick start to new-machine setup |
| [ENVIRONMENT.md](ENVIRONMENT.md) | Every environment variable, what it does, safe example values |
| [DEVELOPER_HANDOFF.md](DEVELOPER_HANDOFF.md) | What to read first, where code lives, what not to modify casually |

## Architecture

| Document | Covers |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | System-level design, data flow, isolation model, embedded final diagrams |
| [architecture/](architecture/) | Final architecture diagrams — documentation and 16:9 presentation quality, PNG + editable SVG, plus a text reference |
| [TEAM4A.md](TEAM4A.md) | Ingestion service in full |
| [TEAM4B.md](TEAM4B.md) | RAG/query service in full |
| [TEAM4C.md](TEAM4C.md) | Frontend/product in full |
| [INTEGRATION.md](INTEGRATION.md) | Exact service-to-service contracts, ingestion/query lifecycles |
| [RAG_ARCHITECTURE.md](RAG_ARCHITECTURE.md) | Team4B's frozen retrieval/generation pipeline, including every alternative investigated and rejected |

## Security

| Document | Covers |
|---|---|
| [SECURITY.md](SECURITY.md) | Product-wide security reference (auth, isolation, JWT, secrets) |
| [SECURITY_ARCHITECTURE.md](SECURITY_ARCHITECTURE.md) | Team4B's prompt-injection threat model and defenses, stated plainly (fixed vs. mitigated vs. open) |

## Learning — deep dives and full system understanding

For understanding the codebase deeply (not just looking something up), read these in order:
[SYSTEM_ARCHITECTURE_GUIDE.md](guides/SYSTEM_ARCHITECTURE_GUIDE.md) first, then whichever
service deep-dive matches what you're studying.

| Document | Covers |
|---|---|
| [guides/SYSTEM_ARCHITECTURE_GUIDE.md](guides/SYSTEM_ARCHITECTURE_GUIDE.md) | Full integration guide — why three services, sequence diagrams for upload/query/auth, isolation layers, sync vs. async, error/retry paths |
| [guides/TECHNOLOGY_DECISIONS.md](guides/TECHNOLOGY_DECISIONS.md) | Every major technology used — what, where, why, alternatives, trade-offs, interview answers |
| [guides/DATABASE_AND_API_REFERENCE.md](guides/DATABASE_AND_API_REFERENCE.md) | Every MongoDB/Qdrant/Redis field and every API endpoint's exact request/response shape |
| [guides/CODEBASE_NAVIGATION.md](guides/CODEBASE_NAVIGATION.md) | "I want to change X, where do I look" — a practical source-code map |
| [learning/TEAM4A_DEEP_DIVE.md](learning/TEAM4A_DEEP_DIVE.md) | Ingestion, chunking, embedding, the canonical lock/generation mechanism, code-verified with file:line citations |
| [learning/TEAM4B_DEEP_DIVE.md](learning/TEAM4B_DEEP_DIVE.md) | The full RAG pipeline — hybrid retrieval, RRF, prompt-injection defenses, generation-authority filtering |
| [learning/TEAM4C_DEEP_DIVE.md](learning/TEAM4C_DEEP_DIVE.md) | Auth, ownership, the upload flow, the stuck-stream watchdog, citation re-verification |

## Interview and viva preparation

Quick one-liners for rapid-fire questions, or the full Q/short-answer/explanation/example/
code-reference format for depth. See
[interview/QUICK_VIVA_QA.md](interview/QUICK_VIVA_QA.md) first.

| Document | Covers |
|---|---|
| [interview/QUICK_VIVA_QA.md](interview/QUICK_VIVA_QA.md) | One-line answers across every category — start here |
| [interview/TEAM4A_QA.md](interview/TEAM4A_QA.md) | Deep Q&A — ingestion |
| [interview/TEAM4B_QA.md](interview/TEAM4B_QA.md) | Deep Q&A — RAG/retrieval/generation |
| [interview/TEAM4C_QA.md](interview/TEAM4C_QA.md) | Deep Q&A — frontend/product |
| [interview/INTEGRATION_SECURITY_QA.md](interview/INTEGRATION_SECURITY_QA.md) | Deep Q&A — cross-service contracts, isolation, JWT |
| [interview/TECHNOLOGY_SCENARIO_QA.md](interview/TECHNOLOGY_SCENARIO_QA.md) | "Why this technology" + "what would you do if X broke" |
| [interview/ADVANCED_TECHNICAL_QA.md](interview/ADVANCED_TECHNICAL_QA.md) | Hard follow-ups probing the real boundary conditions of each design decision |

## Quality, testing, and validation

| Document | Covers |
|---|---|
| [TESTING.md](TESTING.md) | Test suites, expected baselines, what each category validates |
| [RAG_VALIDATION.md](RAG_VALIDATION.md) | Phase-by-phase RAG validation journey with evidence |
| [m6-product-validation-isolation-environment.md](m6-product-validation-isolation-environment.md) | The isolated environment design used for a live product-level validation exercise |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | Common problems, safe diagnostics, safe fixes |

## Project status and scope

| Document | Covers |
|---|---|
| [M6_STATUS.md](M6_STATUS.md) | Current, authoritative project status — read this first if another document conflicts with it |
| [PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md) | Problem, solution, features, and scope explained professionally |
| [PROJECT_QA.md](PROJECT_QA.md) | Full Q&A reference — architecture, RAG, security, deployment, interview-length explanations |
| [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) | Team4B's real, evidence-backed retrieval/generation limitations |
| [LIMITATIONS.md](LIMITATIONS.md) | Broader current limitations, test/dev-only limitations, and future improvements — links to KNOWN_LIMITATIONS.md rather than duplicating it |
| [ROADMAP.md](ROADMAP.md) | Completed vs. deferred vs. genuinely future work |
| [CHANGELOG.md](CHANGELOG.md) | High-level milestones |
| [DOCUMENTATION_CLEANUP_2026-09-28.md](DOCUMENTATION_CLEANUP_2026-09-28.md) | This pass's documentation audit, cleanup actions, and validation results |

## Historical record

| Document | Covers |
|---|---|
| [history/](history/) | Superseded process/audit reports, kept for the project's evidence trail rather than deleted |

---

**If two documents disagree on current status, [M6_STATUS.md](M6_STATUS.md)
is correct.** Documents under `history/` describe a point in time, not the
current state — read them as historical record, not as current fact.
