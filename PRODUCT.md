# Product

<!-- impeccable:product-schema 1 -->

> Inferred from the build brief while the owner was away; they told me to proceed and log every decision. Lines marked (assumption) are not in the brief.

## Platform

web

## Stack

Fixed by the brief: one static HTML page with plain JavaScript and CSS, no framework, served by the Express app from `public/`. It must work under a strict Content-Security-Policy (`script-src 'self'; style-src 'self'`), so no inline scripts or styles and no external fonts or CDNs.

## Users

People asking factual questions about Bonaire Bites (a chain of three casual restaurants in Kralendijk, Bonaire) and about PDFs they upload: staff or guests checking a policy, and engineers evaluating the build (assumption: reviewers of this build are a primary audience).

## Product Purpose

Answer questions only from the loaded documents: a built-in FAQ plus PDFs uploaded at runtime. Every answer cites the document, the page or section, and a verbatim quote. When the documents do not cover the question, the app says so instead of guessing. Success means a user can trust an answer because they can see exactly where it came from, and model general knowledge never reaches them.

## Positioning

The mechanism is verification, not generation: plain code checks that every quote appears verbatim in a passage that was actually retrieved for the question, and anything it cannot verify becomes a fixed refusal.

## Operating Context

One page. An ask box with a few example questions; the answer with its citations (document, location, passage text with the quote highlighted); a side panel listing loaded documents with their chunk counts and an "Add a PDF" upload; the retrieved passages with similarity scores in a collapsed details element. Answers take about 1 to 4 seconds on a local model.

## Capabilities and Constraints

- Answers are 1 to 3 sentences in the question's language; the refusal is one fixed English sentence.
- Questions up to 500 characters. PDFs up to 10 MB with a text layer (no OCR).
- In-memory store: uploaded PDFs disappear on restart. No auth, no persistence, no streaming.
- PDF text is untrusted: the DOM is built with `textContent` only.

## Brand Commitments

The built-in source is titled "Bonaire Bites — Company FAQ". No logo or brand assets were supplied (assumption: none exist).

## Evidence on Hand

The FAQ text in `src/faq.ts`; fixture PDFs in `test/fixtures/`. No testimonials, metrics or customer claims exist; never invent them.

## Product Principles

1. Show the receipt: an answer is never shown apart from its source.
2. Refusing is a feature: an honest "not in the documents" beats a plausible guess.
3. Untrusted text stays inert.

## Accessibility & Inclusion

WCAG 2.1 AA (assumption): keyboard operable, visible focus, a live region for answers, sufficient contrast, usable at 320 px wide.
