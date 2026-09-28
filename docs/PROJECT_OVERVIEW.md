# Project Overview

## Problem

Students accumulate course PDFs and recorded lectures but have no fast,
trustworthy way to ask "what does my own material say about X?" Re-reading
a 40-page PDF or re-watching an hour of lecture to find one answer is slow;
asking a general-purpose AI chatbot instead risks an answer that sounds
confident but isn't actually grounded in what the student was taught, and
that has no way to say "I don't know" instead of guessing.

## Why this problem matters

A wrong or ungrounded answer during study is worse than no answer — it
teaches something incorrect with the same confidence as something
correct, and the student has no way to tell the difference without
independently re-checking the source. Any tool that answers *from a
student's own material* has to be able to (a) actually find the right
passage and (b) admit when it can't, or it isn't trustworthy enough to
study from.

## Target users

Students studying from their own uploaded course material — lecture
slides (PDF), recorded classes (YouTube or uploaded video) — who want to
query that material conversationally rather than manually searching it.

## Proposed solution

EduCopilot: a workspace-based product where a student uploads their own
material, and an AI Tutor answers questions grounded *only* in that
material, with a citation to the exact page or timestamp for every claim.
If the material doesn't cover a question, the system says so rather than
guessing.

## Core features

- Account-isolated workspaces, one per course/subject.
- PDF and YouTube ingestion with live processing status.
- A streaming AI Tutor chat, with answer structure (prose, numbered
  steps, bullet lists) that adapts to the question rather than following
  a fixed template.
- Every answer's citations are independently re-verified against the
  caller's own workspace before being rendered — never trusted blindly
  from the retrieval layer.
- Hybrid retrieval (semantic + keyword), designed to improve coverage of both
  conceptual and exact-terminology questions — not a guarantee that every question
  retrieves the correct evidence; see [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) for
  measured, real gaps.

## User journey

1. Sign up / log in.
2. Create a workspace for a course.
3. Upload a PDF or add a YouTube link; wait for it to become "Ready."
4. Open the AI Tutor and ask a question.
5. Read the grounded answer; follow a citation to the exact source page
   or video moment if you want to verify it yourself.
6. Ask a follow-up — the conversation has real continuity, not just
   isolated one-shot answers.

## Main workflows

- **Ingestion**: upload/URL → extract → chunk → embed → publish to the
  vector store → ready. Full detail: [ARCHITECTURE.md](ARCHITECTURE.md),
  [INTEGRATION.md](INTEGRATION.md).
- **Query**: question → hybrid retrieval → generation-authority filter →
  grounded generation → citations → answer. Same references.

## Supported inputs

PDF documents, YouTube video URLs (transcript-based). MP4 file upload
exists in the ingestion pipeline's design but has no real-world tested
content in either Qdrant collection as of the last audit — see
[LIMITATIONS.md](LIMITATIONS.md).

## Expected outputs

One of three real, distinct outcomes, not a single guaranteed shape:

- **A grounded answer** — natural-language, with one or more citations pointing to a
  specific PDF page or video timestamp range within the student's own uploaded material.
  This is the common, intended case, not the only possible one.
- **An honest decline** — when retrieval finds no usable evidence for the question, the
  system says so rather than guessing, with no citations attached.
- **An incorrect or insufficiently-supported answer** — remains genuinely possible.
  Retrieval can miss relevant material, or the model can misapply retrieved content
  that is real and in-scope but not actually the right match for the question. Citation
  presence does not by itself guarantee the answer's correctness. See
  [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) for documented, evidenced examples of
  this third case.

## Product value

A student gets a fast, trustworthy way to query their own study material
instead of manually searching it, with visible evidence for every answer
rather than an opaque "trust me."

## Technical value

A real, working, end-to-end example of Retrieval-Augmented Generation
built as independently-developed, independently-tested services with a
genuine service-to-service authentication boundary — not a toy
single-file RAG demo. See [ARCHITECTURE.md](ARCHITECTURE.md) and
[PROJECT_QA.md](PROJECT_QA.md) for the reasoning behind every major
design decision.

## Educational value

Demonstrates hybrid retrieval (semantic + BM25 + RRF), workspace/document
isolation enforced at two independent layers, a generation-authority
mechanism for safe re-ingestion, prompt-injection defense reasoned from
real adversarial testing (not just claimed), and a fully tested product
UI (unit, E2E, accessibility) — a realistic cross-section of what a
production RAG product actually requires beyond "call an LLM with some
retrieved text."

## Project scope — what M6 actually delivers

- A complete, working, locally-runnable product: all three services,
  real auth, real ingestion, real retrieval, real generation, a tested
  and polished frontend.
- **Not** included: cloud deployment, horizontal scaling, production
  secret management, monitoring/observability, or load testing — see
  [ROADMAP.md](ROADMAP.md) for what a production deployment would add.

## Implemented vs. future — at a glance

| Implemented (M6) | Future (see ROADMAP.md) |
|---|---|
| PDF + YouTube ingestion | Additional file formats |
| Hybrid retrieval, grounded generation, citations | Cloud/hosted LLM option |
| Workspace/account/document isolation | Multi-tenant production hardening |
| Real auth, real product UI, full test suite | Object storage, horizontal scaling |
| Local Docker/native infrastructure | Cloud deployment, observability, system-wide rate limiting (Team4B's 3 most expensive routes already have it — see [SECURITY.md](SECURITY.md)) |

Full current-vs-deferred breakdown: [M6_STATUS.md](M6_STATUS.md) and
[ROADMAP.md](ROADMAP.md).
