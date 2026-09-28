# Project Q&A

A complete question-and-answer reference for explaining this project —
to an external developer, an interviewer, or an evaluator. Answers are in
plain English first, with technical detail where it matters. Cross-references
point to the document with full depth on that topic.

For a more structured, code-cited Q&A set organized by team and topic (with a short answer,
detailed explanation, example, and code reference for each), see
[docs/interview/](interview/), starting with
[interview/QUICK_VIVA_QA.md](interview/QUICK_VIVA_QA.md). For narrative deep-dives into how
each service actually works internally, see [docs/learning/](learning/).

---

## Basic

**What is EduCopilot?**
An educational RAG (Retrieval-Augmented Generation) product. A student
uploads their own course PDFs or lecture videos, organizes them into
workspaces, and asks an AI Tutor questions — the answers are grounded in
that student's own material, with citations back to the exact page or
timestamp.

**What problem does it solve?**
Students have PDFs and recorded lectures but no fast way to ask "what does
my own material say about X?" and get a trustworthy answer — one that
says "I don't know" when the material doesn't cover it, instead of
guessing from the model's general training data.

**Who is it for?**
Students studying from their own course material — lecture slides, notes,
recorded classes — who want to query that specific material conversationally
instead of re-reading or re-watching it to find one answer.

**Why did you build it?**
As a multi-team (three-service) capstone/project build exercising RAG
architecture, service-to-service authentication, and a full product UI —
see [ARCHITECTURE.md](ARCHITECTURE.md) for why it's split into three
services.

**What are the main features?**
Workspace-isolated material organization, PDF and YouTube ingestion, an
AI Tutor with grounded, cited answers, adaptive answer formatting
(numbered steps, bullet lists, or prose depending on the question),
hybrid semantic+keyword retrieval, and account/workspace isolation.

**What makes it different?**
It's designed not to answer from general knowledge — retrieval is scoped to the
student's own workspace, and answers are built to carry citations back to retrieval
metadata rather than invented ones. This is the intended, code-enforced behavior, not a
guarantee that every claim in every answer is correct or individually cited — retrieval
can miss relevant material, and the system is designed to decline honestly when the
material doesn't cover the question, but an incorrect or insufficiently-supported
answer remains possible. See [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md).

**What technologies are used?**
Next.js/React/TypeScript (Team4C), FastAPI/Python (Team4A, Team4B),
MongoDB, Qdrant, Redis, Ollama. Full stack: [TEAM4C.md](TEAM4C.md).

---

## Architecture

**Why three teams/services?**
So ingestion, retrieval/generation, and the product UI could each be
built and tested independently without one team's changes breaking
another's working code. See [ARCHITECTURE.md](ARCHITECTURE.md#why-three-services-instead-of-one).

**What is Team4A?** The ingestion service — turns a PDF or video into
embedded, searchable chunks in Qdrant. [TEAM4A.md](TEAM4A.md).

**What is Team4B?** The RAG/query service — retrieves relevant chunks and
generates a grounded, cited answer. [TEAM4B.md](TEAM4B.md).

**What is Team4C?** The Next.js frontend and product layer — auth,
workspaces, materials, the chat UI, and the MongoDB schemas for product
data. [TEAM4C.md](TEAM4C.md).

**How do they communicate?**
HTTP, authenticated with short-lived internal service JWTs Team4C mints
per request. Full contract: [INTEGRATION.md](INTEGRATION.md).

**Why not build everything in one service?**
See "Why three teams/services?" above — independent development/testing,
at the cost of an explicit integration surface (documented in
[INTEGRATION.md](INTEGRATION.md)) instead of in-process function calls.

**Explain complete request flow.**
See [INTEGRATION.md](INTEGRATION.md#query-lifecycle--what-happens-when-a-student-asks-the-ai-tutor-a-question).

**Explain complete ingestion flow.**
See [INTEGRATION.md](INTEGRATION.md#ingestion-lifecycle--what-happens-when-a-user-uploads-a-pdf-or-adds-a-youtube-link).

---

## RAG

**What is RAG?**
Retrieval-Augmented Generation: instead of an LLM answering purely from
what it learned during training, the system first retrieves relevant real
text (from the student's own material), then generates an answer
constrained to that retrieved text.

**Why RAG?**
So an answer is traceable to a real source and current material, instead
of the model's frozen training data (which also wouldn't know anything
about a student's *own*, private course material at all).

**What is an embedding?**
A numeric vector representation of text such that texts with similar
meaning end up close together in that vector space — this is what makes
"search by meaning" possible.

**What is a vector?**
The embedding itself — a fixed-length array of numbers (384 numbers, in
this project's `all-MiniLM-L6-v2` model).

**What is chunking?**
Splitting a long document into smaller pieces (this project: ~512 tokens,
with 50 tokens of overlap between consecutive chunks) before embedding —
an embedding for an entire long document would blur together too many
different ideas to be useful for finding one specific relevant passage.

**Why chunk documents?**
So retrieval can return the *specific* few paragraphs relevant to a
question, not "the whole 40-page PDF is somewhat relevant."

**What is Qdrant?**
An open-source vector database — it stores embeddings and answers
"which stored vectors are closest to this query vector?" efficiently, at
scale, which a general-purpose database isn't built to do natively.

**Why Qdrant?**
Purpose-built vector search (approximate nearest neighbor, HNSW indexing)
with a straightforward API and self-hostable, no separate managed-service
dependency for local development.

**What is semantic search?**
Finding text based on *meaning* rather than exact keyword match — powered
by comparing embeddings.

**What is BM25?**
A classic keyword-ranking algorithm — scores documents by how well they
match a query's exact terms, weighted by term rarity. Strong on exact
terminology/acronyms; blind to paraphrase.

**Why BM25?**
Semantic search alone can miss exact-terminology questions (acronyms,
specific names) that a keyword match would catch instantly. Combining
both covers more question types than either alone.

**What is hybrid retrieval?**
Running both the semantic (embedding) search and the BM25 (keyword)
search, then merging their two ranked lists into one.

**What is RRF?**
Reciprocal Rank Fusion — the specific merging method used: a chunk's
fused score depends on its *rank position* in each list (not raw scores,
which aren't comparable between a cosine-similarity score and a BM25
score), so a chunk ranking well in either or both lists rises to the top.

**Why use RRF?**
It's a simple, well-established, parameter-light way to combine two
differently-scaled ranked lists without needing to hand-tune a weighting
formula between them.

**How are final chunks selected?**
Both retrieval legs run → generation-authority filter removes any
chunk from a superseded ingestion → RRF fuses the remaining candidates →
normalize → apply `score_threshold` (0.3) → take `top_k` (5). See
[TEAM4B.md](TEAM4B.md).

**How does grounding work?**
The retrieved chunks are inserted into the LLM's prompt, explicitly
delimited as untrusted *evidence to read*, with an instruction to answer
only from that evidence and say so honestly when it's insufficient.

**How are hallucinations reduced?**
By this grounding-instruction design plus never letting the model see the
whole corpus — only the retrieved chunks. This is a real, measured
mitigation (7/8, then 8/8, of Phase 5J/5K's live grounding test cases were
accurate), not a mathematical guarantee — see
[KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) for the one confirmed failure
mode (occasionally narrating lexically-adjacent-but-wrong-domain content).

**How are citations generated?**
Directly from the retrieval metadata already used for isolation (document
id, title, page/timestamp) — never re-derived from the model's free-text
output, so a citation can't point somewhere retrieval didn't actually pull
from. See [TEAM4B.md](TEAM4B.md) and [INTEGRATION.md](INTEGRATION.md#citation-flow).

---

## AI

**Why Ollama?**
A local LLM runtime — no external API dependency, no per-request cost, no
sending student material to a third-party API.

**Why local LLM?**
Keeps all student-uploaded material and questions on infrastructure this
project controls, and avoids external API costs/rate limits during
development and testing.

**Which model is used?**
`llama3` (8B parameters), via Ollama.

**What happens during generation?**
`LLMGenerator` builds one flat prompt string (system instructions +
delimited evidence + conversation history + the question), sends it to
Ollama's `/api/generate`, then an output-side check runs before the
answer is returned to the caller (see [TEAM4B.md](TEAM4B.md)/
[SECURITY_ARCHITECTURE.md](SECURITY_ARCHITECTURE.md)).

**What happens if context is insufficient?**
The model is instructed to say so honestly rather than guess — the system
has a defined `INSUFFICIENT_CONTEXT_MESSAGE` for this case.

**How does the system avoid answering unsupported questions?**
Primarily through the grounding prompt instruction (see "How does
grounding work?" above) — this is a real, tested mitigation, not an
absolute guarantee; see [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md).

---

## Security

**How does login work?**
Auth.js (NextAuth v5), Credentials provider, bcrypt-hashed passwords,
session cookie. [TEAM4C.md](TEAM4C.md#authentication-and-authorization).

**How does authentication work?**
See above — this answers "who is this browser session."

**How does authorization work?**
Separately from authentication: every workspace-scoped request re-verifies
server-side that the authenticated user *owns* the specific workspace
being accessed — a workspace belonging to someone else 404s exactly like
a nonexistent one.

**How are workspaces isolated?**
Two independent layers: Team4C's ownership check (only the owning user
can act on a workspace at all) and Team4B's mandatory `workspace_id`
scoping on every retrieval call (a cross-workspace document never
contributes to ranking, let alone appears in results). Neither depends on
the other to be correct. [ARCHITECTURE.md](ARCHITECTURE.md#isolation-model).

**How are accounts isolated?**
Every workspace has exactly one owner; every query is authenticated to
one user, whose workspaces are the only ones ever resolvable server-side.

**How are documents scoped?**
An optional `document_ids` filter narrows retrieval to specific material
within an already-authorized workspace; an empty list narrows to zero
results deliberately, never "no restriction."

**How are service requests authenticated?**
Short-lived, ES256-signed internal JWTs, minted server-side by Team4C
from verified identity immediately before each call — see
[INTEGRATION.md](INTEGRATION.md#authentication-between-services).

**Why should secrets never be committed?**
A committed secret in git history is effectively permanent (even after
"removal," it remains in prior commits/forks/clones) and can be scraped
by automated bots within minutes of a public push. See
[ENVIRONMENT.md](ENVIRONMENT.md) and the repository hygiene section of
the project's preparation report.

---

## Ingestion

**Explain PDF ingestion.** Upload → PyMuPDF text extraction → chunk →
embed → publish to Qdrant → write completion generation to MongoDB. See
[TEAM4A.md](TEAM4A.md).

**Explain YouTube ingestion.** URL submitted → transcript fetched
(default language, with one deterministic fallback language attempt) →
same chunk/embed/publish/authority-write pipeline as PDF.

**What happens after upload?** See
[INTEGRATION.md](INTEGRATION.md#ingestion-lifecycle--what-happens-when-a-user-uploads-a-pdf-or-adds-a-youtube-link)
for the full step-by-step.

**What is ingestion generation?** A number that increases each time an
ingestion attempt is authorized for a document — lets the system know
which attempt's chunks are current. [TEAM4A.md](TEAM4A.md#the-canonical-ingestion-path-and-the-ingestion-generationauthority-mechanism).

**Why do we need generation numbers?** So a slow, superseded ingestion
attempt finishing *after* a newer one doesn't have its stale chunks
treated as current by retrieval.

**What is the Redis lock?** A per-document lock ensuring only one
ingestion attempt runs at a time for that document.

**Why do we need concurrency protection?** Without it, two simultaneous
ingestion requests for the same document could interleave writes/publish
inconsistent chunk sets.

**What happens if two ingestion requests arrive together?** The lock
means only one proceeds at a time (the other waits or is rejected,
depending on how it's issued) — they never interleave.

**What happens if an old ingestion finishes after a newer one?** Its
generation number is lower than current; Team4B's authority filter
excludes its chunks regardless of Qdrant write order or timing.

---

## Frontend

**Why Next.js?** App Router gives server components for authenticated,
ownership-checked data fetching plus API routes in one framework, and
first-class React 19/TypeScript support.

**Why React?** Component-based UI, the de facto standard for this class
of application, and it's what Next.js is built on.

**Why TypeScript?** Compile-time type safety across a codebase this size
— citations, message shapes, and the Team4A/4B contract types in
particular benefit from being checked, not just documented.

**How is authentication handled?** See "How does login work?" above.

**How does workspace navigation work?** Sidebar persistent nav + a
contextual "Back to Workspaces" link on the workspace page; the active
workspace is shown in a switcher. [TEAM4C.md](TEAM4C.md).

**How does AI Tutor work?** See [TEAM4B.md](TEAM4B.md) (what decides the
answer) and [TEAM4C.md](TEAM4C.md#ai-tutor) (how it's rendered/streamed).

**How is Markdown rendered?** `react-markdown` + `remark-gfm`, never
raw-HTML rendering — literal HTML/script tags in an LLM's output render as
inert text. [TEAM4C.md](TEAM4C.md#ai-tutor).

**How are citations displayed?** Compact, truncating pill chips grouped
under a "Sources (n)" label when there's more than one; full title
available via tooltip. [TEAM4C.md](TEAM4C.md#ai-tutor).

**How is mobile responsiveness handled?** A distinct tab-based
single-panel layout below the `md` breakpoint, not a shrunk desktop grid
— verified at 375/390/768/1024/1280/1440px.

---

## Database / infrastructure

**Why MongoDB?** Flexible document schema, a natural fit for Users/
Workspaces/Files/Conversations/Messages, and Mongoose's TypeScript
integration.

**Why Redis?** Fast, ephemeral, key-based state — Celery's broker/result
backend and per-document ingestion locks (Team4A); conversation-history
storage (Team4B) — none of which needs MongoDB's durability/query
guarantees.

**Why Qdrant?** Purpose-built vector search — see "Why Qdrant?" in the
RAG section above.

**What data belongs in MongoDB?** Users, Workspaces, Files (including
the ingestion-generation field), Conversations, Messages — Team4C's
schema.

**What data belongs in Qdrant?** Chunk vectors and their payload (text,
`workspace_id`, `document_id`, `ingestion_generation`, page/timestamp
metadata).

**What does Redis store/control?** Team4A: Celery broker/result,
ingestion locks, generation counters. Team4B: conversation history.

**Why not store embeddings in MongoDB?** MongoDB has no comparable
native vector-search capability in this deployment; mixing a vector index
into the same store as transactional product data would couple two very
different scaling/access patterns. [ARCHITECTURE.md](ARCHITECTURE.md#storage).

---

## Testing

**What tests exist?** Team4A: a 913-test pytest suite. Team4B: a
1438-test pytest suite plus live scripted acceptance/security batteries.
Team4C: 669 Vitest tests, a 13-test Playwright E2E suite across 7 spec
files, axe-core accessibility checks, TypeScript and ESLint. Current,
authoritative counts: [M6_STATUS.md](M6_STATUS.md). Full detail:
[TESTING.md](TESTING.md).

**Why unit tests?** Fast, deterministic verification of individual
functions/components in isolation.

**Why integration tests?** Team4C's E2E suite includes specs that
exercise the real Team4A→Team4B→Team4C path — catching contract breaks
unit tests alone can't.

**Why E2E tests?** They verify what a real user actually experiences
through the browser, not just that individual functions return the right
value.

**Why accessibility tests?** WCAG compliance is a real product-quality
and legal-consideration bar, not an afterthought; automated axe-core
checks catch real regressions (one genuine contrast bug was caught and
fixed this way during development).

**What does the Playwright suite verify?** See
[TESTING.md](TESTING.md#what-team4cs-playwright-suite-actually-verifies).

**What does the build check?** Full TypeScript compilation and route
analysis — see [TESTING.md](TESTING.md#what-the-production-build-checks).

---

## Reliability

**What happens when a service is down?** The dependent request fails with
an error surfaced to the user (a 502/503-class response, not a silent
wrong answer) — see [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

**What happens when ingestion fails?** The `File` document's status is
set to `failed` with the real error message — never silently marked
`ready`.

**What happens when retrieval returns nothing?** Generation proceeds with
no evidence, and the grounding instruction leads the model to decline
honestly rather than fabricate an answer.

**What happens when the LLM cannot answer?** It returns the system's
defined insufficient-context message rather than guessing.

**How are stale ingestion attempts handled?** See "What happens if an old
ingestion finishes after a newer one?" above.

---

## Performance

**Where could the system become slow?** Local LLM generation is the
dominant cost — CPU-bound in this project's own environment, 30–140+
seconds per answer (see [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md)).
BM25's per-query index rebuild is also a real cost at larger workspace
sizes, though not separately benchmarked here.

**How is retrieval optimized?** Hybrid semantic+BM25 with RRF fusion
(rather than either alone), a fixed `top_k`/`score_threshold` tuned
through real evaluation (see [RAG_ARCHITECTURE.md](RAG_ARCHITECTURE.md)'s
"Investigated and rejected" table for what was tried and didn't help).

**Why BM25?** See the RAG section above.

**Why hybrid retrieval?** See the RAG section above.

**What happens with large documents?** Chunking keeps individual
retrieval units small regardless of source document length; a very long
video's transcript simply produces more chunks, not larger ones.

**How could the system scale?** See "Deployment" below.

---

## Deployment

**How would you deploy it?** Each service in its own container (Docker
images already exist for Team4A/Team4B; Team4C is a standard Next.js app
deployable to any Node host or Vercel), behind a reverse proxy, with
managed MongoDB/Redis/Qdrant instances and a GPU-backed Ollama host (or a
hosted LLM API swapped in behind `LLMGenerator`'s interface) instead of
local CPU inference.

**What would change for production?** Real secret management (not
`.env` files), HTTPS everywhere (`FILE_URL_REQUIRE_HTTPS=true`), GPU-backed
or hosted LLM inference for acceptable latency, and the production-hardening
items already noted as not yet done in [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md)
(no cloud deployment, no load/scale testing has been performed).

**What services would need separate deployment?** All three — they're
already architected as independent services with no shared process state.

**How would you handle secrets?** A real secret manager (cloud provider
KMS/secrets manager, or a self-hosted equivalent) — never `.env` files in
any deployed environment, only for local development.

**How would you handle monitoring?** Not implemented in this project;
each service already emits structured logs (see each service's
`log_level`/logging config) as a starting point for centralized log
aggregation.

**How would you handle backups?** Not implemented; MongoDB and Qdrant
both support standard backup/snapshot mechanisms that would need to be
scheduled in a real deployment.

**How would you scale Team4A?** Horizontally — the Celery worker count
(`celery_worker_concurrency`) is already configurable; multiple worker
processes/machines can share one Redis broker.

**How would you scale Team4B?** Horizontally behind a load balancer —
it's stateless per-request except for the shared Redis conversation store
and Qdrant, both of which already support multiple concurrent clients.

**How would you scale Qdrant?** Qdrant supports sharding/replication
natively; not configured in this local-development setup (single node,
`shard_number: 1`, `replication_factor: 1`).

---

## Limitations

Full, evidence-backed list: [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md).
Headline items, stated plainly:

- Hindi retrieval is phrasing-sensitive; cross-script (Hinglish/English↔Hindi)
  retrieval is measurably weaker than same-language retrieval — not fixed,
  documented as an open limitation.
- The LLM occasionally narrates lexically-adjacent-but-wrong-domain
  retrieved content instead of declining (bounded — never observed to leak
  across workspaces, only to misapply in-scope content from the wrong
  subject).
- Prompt injection is mitigated for one specific attack pattern, not eliminated: a
  forced-fixed-output pattern is fixed and validated (Phase 5K), but a later
  query-neutralization attempt was tested live and did **not** stop a direct
  instruction-override attack — it still fully succeeded against the running model.
  A separate, lower-severity residual also remains open
  (`REPRO-SPOOF-5` — prompt-scaffold disclosure, no real secret exists to
  leak). See [SECURITY_ARCHITECTURE.md](SECURITY_ARCHITECTURE.md).
- Local LLM generation is CPU-bound and slow in this environment (30–140+
  seconds per answer).
- No MP4-upload source-type content exists in either Qdrant collection as
  of the last audit — video-source evidence exists only via YouTube
  transcripts.
- No cloud deployment, load testing, or production-scale testing has been
  performed or is claimed anywhere in this project.

---

## Project explanation, at different lengths

**30 seconds:** "EduCopilot lets a student upload their own course PDFs
and lecture videos, then ask an AI tutor questions about that material —
answers are retrieved and cited from what they actually uploaded, back to
the exact page or timestamp, instead of the AI just guessing. It's a
design goal enforced by the pipeline, not a mathematical guarantee — real,
disclosed exceptions exist and are documented, not hidden."

**1 minute:** add — "It's built as three services: one handles turning
documents into searchable data (ingestion), one handles finding the
relevant pieces and generating the answer (RAG), and one is the actual
web app the student uses. The RAG piece combines two kinds of search —
meaning-based and keyword-based — because each catches questions the
other misses, and it's specifically designed to say 'I don't know' rather
than make something up when the material doesn't cover a question."

**2 minutes:** add — "Everything is isolated per student and per
workspace — a Data Structures workspace's material can never leak into an
Operating Systems workspace's answers, enforced independently at both the
product layer and the retrieval layer. The three services talk to each
other using short-lived signed tokens, not a shared password. And it's
been genuinely tested, not just built — real end-to-end tests that upload
a real file, wait for real ingestion, ask a real question, and check for a
real, correctly-cited answer, plus accessibility checks on every major
page."

**5 minutes (technical):** add — "The retrieval side uses hybrid search:
a vector database (Qdrant) for semantic/meaning-based matching, plus a
BM25 keyword index rebuilt fresh per workspace per query so results are
never contaminated across workspaces even at the statistics level, not
just filtered afterward. Both ranked lists get merged with Reciprocal
Rank Fusion. Before anything reaches the language model, there's also a
'generation authority' check — every document tracks which ingestion
attempt is current, so if you re-upload something, an old, slow ingestion
attempt finishing late can never overwrite the newer one's results. On
the security side, retrieved document content is treated as untrusted
data, not instructions — there's a two-layer defense against prompt
injection: delimiter-based framing plus a deterministic output-side guard
that was validated against real captured attack outputs, reducing a
specific forced-output attack pattern from 5-in-31 successful to 0-in-32,
with zero false positives on legitimate answers."

**Resume line:** "Built the frontend and product-integration layer of a
three-service RAG application (Next.js/TypeScript + two Python/FastAPI
services), including authentication, workspace/document isolation,
service-to-service JWT authentication, a streaming AI chat interface with
grounded citations, and a full automated test suite (unit, E2E,
accessibility)."

**Viva/interview explanation:** be ready to explain, in your own words,
without reading: what RAG is and why it beats a plain LLM call for this
use case (see the RAG section above); why isolation is enforced at two
independent layers, not one; what the generation-authority mechanism
solves and why a simple "latest write wins" approach would be wrong; and
one real limitation from [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) with
its actual evidence, not a vague "it's not perfect."

**Explain the architecture on a whiteboard**:

```
                              User (browser)
                                    |
                                    v
                    +-----------------------------+
                    |   Team4C (Next.js product)   |
                    |  auth, workspaces, chat UI   |
                    +---------------+---------------+
                    |  signed JWT               |  signed JWT
                    |  (upload / URL)            |  (question)
                    v                             v
        +-------------------+          +---------------------------+
        |  Team4A            |          |  Team4B                    |
        |  ingestion         |          |  retrieval + generation    |
        |  extract->chunk->  |          |  semantic + BM25 -> RRF -> |
        |  embed->publish    |          |  authority filter -> LLM   |
        +---------+----------+          +--------------+------------+
                  |                                     |
                  |  publish chunks                     |  read chunks
                  v                                     v
              +------------------------------------------+
              |               Qdrant (vectors)             |
              +------------------------------------------+

              +------------------------------------------+
              |  MongoDB — Team4C owns the schema;         |
              |  Team4A writes ONE field                   |
              |  (File.currentIngestionGeneration);        |
              |  Team4B reads that SAME field before        |
              |  trusting any retrieved chunk               |
              +------------------------------------------+

        Team4A also uses Redis (Celery + ingestion locks, port 6379)
        Team4B also uses Redis (conversation history, port 6380)
        Team4B also calls Ollama (local LLM) for generation

                                    ^
                                    |  answer + citations
                                    |
                              back to Team4C -> streamed to the browser
```

Walk through it left to right, then explain the one detail that makes
the whole system safe to re-ingest into: that single shared MongoDB
field. Team4A writes it once, on success; Team4B reads it before trusting
any chunk. That's the entire mechanism that stops a slow, superseded
ingestion attempt from overwriting a newer one's results — see the
Ingestion section above.

A Mermaid version of this same diagram (renders as a real flowchart on
GitHub) is in [ARCHITECTURE.md](ARCHITECTURE.md#system-diagram).

**Explain what happens when a user uploads a PDF** (step-by-step, for a
verbal walkthrough): "The browser sends the file to Team4C, which creates
a database record marked 'uploading' and hands the file off to Team4A
with a signed token proving who's asking. Team4A extracts the text,
splits it into chunks, turns each chunk into a vector embedding, and
writes those vectors into Qdrant, tagged with which workspace and
document they belong to. When that's done, Team4A writes one small
'generation' number back onto the same database record Team4C created —
that's the signal Team4C's UI is watching for to show 'Ready.'" Full
detail: [INTEGRATION.md](INTEGRATION.md#ingestion-lifecycle--what-happens-when-a-user-uploads-a-pdf-or-adds-a-youtube-link).

**Explain what happens when a user asks a question**: "Team4C sends the
question to Team4B, again with a signed token. Team4B searches two ways
at once — by meaning and by exact keyword — merges the results, throws
out anything from a since-superseded ingestion, and only then hands the
surviving evidence to the language model with an instruction to answer
only from that evidence. The model's answer comes back with citations
built from the same evidence metadata, not from anything the model wrote
freely. Team4C double-checks those citations belong to the asking user's
own workspace before showing them, then streams the answer to the
browser." Full detail: [INTEGRATION.md](INTEGRATION.md#query-lifecycle--what-happens-when-a-student-asks-the-ai-tutor-a-question).

---

## Professional project analysis

An honest engineering evaluation — not marketing. Every item below is
something actually true of the implementation, not an aspirational claim.

### Strengths

- **Modular, independently-testable architecture** — three services with
  a narrow, well-documented integration surface (service JWTs + one
  shared Mongo field), not a tangle of ad hoc calls.
- **Source-grounded answers with independently re-verified citations** —
  Team4C never trusts Team4B's citations blindly; it re-checks them
  against the caller's own workspace before rendering.
- **Isolation enforced at two independent layers** (product ownership +
  mandatory retrieval scoping), not one — a bug in either layer alone
  wouldn't be sufficient to leak data.
- **Hybrid retrieval**, not semantic-only — covers both conceptual and
  exact-terminology questions.
- **Prompt-injection defense reasoned from real adversarial testing**,
  with a specific, measured before/after result (5/31 → 0/32), not a
  vague "we handle that."
- **Comprehensive, currently-passing automated testing** across all three
  services, including real (not mocked) end-to-end flows and automated
  accessibility checks.
- **Responsive, accessible UI**, verified at six real breakpoints with
  actual screenshots and DOM geometry checks, not assumed.
- **Local LLM capability** — no per-request external API cost or
  third-party data exposure during development/testing.

### Weaknesses

- **Local infrastructure complexity** — seven distinct
  services/processes (MongoDB, two Redis instances, Qdrant, Ollama,
  Team4A + its worker, Team4B, Team4C) must all be running correctly for
  the full product to work; this is real operational overhead for local
  development.
- **Hardware-dependent generation latency** — CPU-bound local LLM
  inference (30–140+ seconds/answer) is a genuine UX cost in this
  environment.
- **Development-oriented deployment only** — no production hardening,
  cloud deployment, or load testing exists yet.
- **External YouTube dependency** — YouTube ingestion depends on a
  third-party transcript API that can fail for videos without an
  available transcript track.
- **Current scale is unproven** — nothing in this project's testing
  establishes how it behaves under concurrent multi-user load; all
  testing to date is single-developer, single-machine.

### Advantages / plus points

What makes this technically interesting rather than a minimal RAG demo:
the generation-authority/re-ingestion-safety mechanism (a real answer to
a real race-condition problem, not hand-waved), the two independently
enforced isolation layers, and the fact that the prompt-injection defense
was arrived at by testing and rejecting a weaker design first (see
[RAG_ARCHITECTURE.md](RAG_ARCHITECTURE.md)'s "Investigated and rejected"
table) rather than shipping the first idea that seemed to work.

### Risks

- **Technical**: the CPU-bound generation latency could make the product
  feel broken to a first-time user who isn't told to expect a wait.
- **Product**: Hindi/cross-script retrieval's weaker performance could
  disproportionately affect non-English-first users if deployed without
  clearly communicating this limitation.
- **Operational**: no monitoring exists — a silent failure in any of the
  seven local services would only be noticed when a user reports a
  problem, not proactively.

### Trade-offs

- **Local LLM (Ollama) vs. cloud LLM API**: chosen for no per-request
  cost and no third-party data exposure during development, at the cost
  of generation latency and a hard local-hardware dependency. A
  production deployment would likely revisit this (see
  [ROADMAP.md](ROADMAP.md)).
- **MongoDB vs. a SQL database**: chosen for schema flexibility across
  Users/Workspaces/Files/Conversations/Messages and native TypeScript
  integration via Mongoose: relational integrity constraints (e.g.
  foreign keys) are enforced in application code instead of the database
  layer.
- **Qdrant vs. storing vectors in the primary database**: chosen because
  MongoDB has no comparable native vector-search capability in this
  deployment; the cost is one more service to run and keep in sync.
- **Hybrid retrieval vs. semantic-only**: chosen after real evidence
  showed semantic-only search missed exact-terminology questions BM25
  catches — at the cost of maintaining two retrieval legs and a fusion
  step instead of one simpler code path.
- **Three services vs. a monolith**: chosen for independent
  development/testing (see [ARCHITECTURE.md](ARCHITECTURE.md#why-three-services-instead-of-one))
  at the cost of an explicit, narrow integration surface to maintain.

### Future improvements

Clearly separated from current functionality — see
[ROADMAP.md](ROADMAP.md) for the full list (cloud/hosted LLM option,
object storage, horizontal scaling, observability, system-wide/IP-level rate limiting
— Team4B's query endpoints already have identity-keyed limiting, see
[SECURITY.md](SECURITY.md) — additional file formats, richer learning tools).
