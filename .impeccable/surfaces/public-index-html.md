---
version: 1
slug: "public-index-html"
primary_target: "public/index.html"
related_targets: ["public/app.js","public/styles.css"]
---

## Scope

`public/index.html` (+ `app.js`, `styles.css`): the whole single-page app. Visitor mode: Operate. Built code-led (no image generation; no comp).

## Audience and task

Developers, staff and build reviewers ask factual questions about Bonaire Bites and uploaded PDFs, read a 1-3 sentence answer and check its verbatim sources; they add and remove PDFs. Constraints: textContent only (PDF text is untrusted), strict CSP (no inline script/style, same-origin fonts), WCAG 2.1 AA, works from 320 px.

## Direction contract

THESIS: A quiet dark workspace where the documents are the sidebar and every answer is a card that carries its sources; the owner chose this over the earlier kitchen-ticket rail. It refuses the chat-bubble thread and decorative accent bars.

OWN-WORLD: Near-black page (#0e1012), a slightly lifted sidebar (#15181b) and cards (#1b1f23) with 1px borders (#2a2f35); light primary text and muted secondary text; ONE mint accent (about #5ef2b8) for the Ask action, focus, active states and the quote highlight (mint-tinted ground with a 1px mint underline); a muted red only for destructive confirm and errors. System sans for the UI, monospace only for data; Barlow Condensed for the wordmark.

STORY: The visitor scans the sidebar to see what the app knows, asks in the command bar (or taps an example), and reads the newest answer card at the top: answer, then "Sources" with "document · location" and the highlighted quote, with retrieved passages one click away. A refusal is a calm "Not in the documents" card. Removing a PDF is a two-step inline confirm.

FIRST VIEWPORT: Desktop: fixed left sidebar (~280 px) with the wordmark, one-line promise, "Documents" list (built-in badge, remove buttons) and "Add a PDF"; the main panel holds the ask command bar, the example chips, then the newest answer card. Phone: the sidebar becomes a top section above the ask bar.

FORM: Owner-pinned "Dark app" direction chosen through a structured question on 2026-10-01 (replaces seed f1073352's kitchen ticket rail). Signature interaction: new answer cards enter with a short fade and 6 px rise (instant under reduced motion); remove buttons turn into an inline "Confirm" for about 4 seconds.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Unresolved

The Claude Design mockup ("Grounded QA Mockups.dc.html") was never readable in this session; the owner chose the dark app direction instead.
