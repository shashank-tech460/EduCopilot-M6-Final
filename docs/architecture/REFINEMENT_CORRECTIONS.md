# EduCopilot M6 — Diagram Refinement: Corrections Made

This refinement pass took the two diagrams produced in the earlier "Final Complete System
Architecture Documentation" task (`EduCopilot_M6_Complete_System_Architecture.*` and
`EduCopilot_M6_Detailed_Technical_Architecture.*`, first-pass files, since superseded and
removed) as a starting reference and corrected their layout, content, and export quality. No
architectural facts were changed to make the diagrams look cleaner — only how those facts are
presented.

## Layout and readability corrections

1. **Removed all long/diagonal arrows.** Every connector in the refined diagrams is either a
   short orthogonal line routed through the gap between boxes (never through a box's
   interior), or a numbered flow reference resolved in a legend, per the instruction to avoid
   arrows crossing text, cards, or other components.
2. **Fixed a real overlap bug in Diagram 1**: the "Request Flow Reference" legend box used a
   hardcoded left-edge position left over from an earlier, narrower draft of the Team4C box.
   After the Team4C box was widened, the legend box rendered on top of the "AI Tutor Chat"
   card. Fixed by computing the legend's position and every dependent right-column offset
   (External Systems / Legend / Known Limitations boxes) from the Team4C box's actual
   dimensions instead of a fixed number.
3. **Restructured Diagram 2 from a single dense panel into six clearly separated panels**:
   Local Development Ports, Service-to-Service Security, Team4A Endpoints, Team4A Ingestion
   Configuration, Team4B Endpoints, and Team4B Retrieval Configuration — so the security
   section no longer competes visually with either team's endpoint list, per the explicit
   requirement to separate these.
4. **Fixed excessive empty whitespace in Diagram 2**: the first draft's canvas height was
   sized before the panel content was finalized, leaving roughly two-thirds of each panel
   empty. Reduced the canvas from 2200×1500 to 2200×900, which brings the panels' visual
   weight in line with their actual content.
5. **Verified, panel by panel, that no text or box extends past its parent panel's border** —
   including the dashed "legacy path" boxes, the reranker status box, and the citation-fields
   list — by rendering each region at native resolution and inspecting it directly, not by
   inference from a scaled-down view.

## Content corrections — removed commentary, kept neutral technical notes

6. **Removed session-narrative text.** The first pass's Diagram 1 included a "Known
   Limitations" note written as first-person process commentary (e.g. "CONFIRMED LIVE: the
   local model still fully obeyed a direct attack after the fix. NOT a solved guarantee —
   disclosed limitation."). This has been replaced with three short, neutral, technically
   necessary status lines:
   - "Prompt-injection mitigation is partial: user-query text is sanitized, but model
     compliance with the system prompt is not guaranteed (Team4B)."
   - "Reranker is implemented but disabled by default (Team4B)."
   - "Legacy ingestion endpoints remain reachable but are not used by the current upload flow
     (Team4A)."
7. **Kept the prompt-injection limitation out of the main request-flow area** of Diagram 1,
   confined to the Known Limitations panel and one short pointer line inside the Team4B box,
   rather than embedded in the flow diagram itself.
8. **No fabricated or invented components.** Endpoint lists, ports, and configuration values
   in both diagrams were re-checked against the current source (`team4a/app/config/
   settings.py`, `team4b/app/core/config.py`, and the live `/openapi.json` responses used in
   the original documentation pass) rather than assumed to still be correct; see
   `ARCHITECTURE_REFERENCE.md` for the specific source of each fact.

## Export corrections

9. **Produced genuinely distinct presentation (PPT 16:9) layouts, not resized copies.** Both
   PPT versions drop most of the fine-grained detail (per-item sub-bullets, mono-spaced
   endpoint descriptions) in favor of fewer, larger-type headline facts, consistent with the
   requirement that a presentation layout must be deliberately re-composed for legibility at
   slide scale, not a shrunk documentation image.
10. **Split Diagram 2's PPT version into two slides** — a main overview slide
    (`EduCopilot_M6_Detailed_Architecture_PPT_16x9.png`) and a companion technical-details
    slide (`EduCopilot_M6_Detailed_Architecture_PPT_16x9_TechnicalDetails.png`) — because the
    full endpoint and configuration reference does not fit legibly on one slide at
    presentation type sizes. This is an intentional, explicitly-permitted deviation from
    "one file per diagram" for the PPT version of Diagram 2 only; the documentation version of
    Diagram 2 remains a single image.
11. **All five final PNGs were rendered at 2x their target pixel dimensions** for crisper text
    (documentation versions at 4400px-wide source scale; PPT versions at 3840×2160, exactly
    double 1920×1080 while preserving the 16:9 ratio), then inspected in the browser at their
    actual export dimensions as part of final QC.
12. **PDF export was not produced.** No SVG-to-PDF converter is installed in this environment
    (`cairosvg`, `rsvg-convert`, and `inkscape` were all checked and are unavailable). This
    matches the same disclosed limitation from the first documentation pass. The SVG files are
    the vector source of record.

## What was intentionally left unchanged

- The overall system architecture, component responsibilities, and data flows are unchanged
  from the first documentation pass — this was a presentation and accuracy refinement, not a
  redesign.
- The color palette (green = Team4A, purple = Team4B, blue = Team4C, gray = shared, amber =
  external/limitations, red = security/protected) is the same across both diagrams and both
  export versions, for diagram-to-diagram consistency.
- **Update, post-refinement:** the first-pass files (`EduCopilot_M6_Complete_System_Architecture.*`,
  `EduCopilot_M6_Detailed_Technical_Architecture.*`, `ARCHITECTURE_NOTES.md`,
  `VERIFICATION_CHECKLIST.md`) were kept alongside these refined files for one review cycle, in
  a separate `docs/architecture-diagrams/` folder. Once the refined set here was confirmed
  final, that first-pass folder was removed as part of the 2026-09-28 repository documentation
  cleanup pass, and this became the single `docs/architecture/` package — see
  `../DOCUMENTATION_CLEANUP_2026-09-28.md` for that decision.
