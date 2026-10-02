---
name: Grounded Q&A
description: A quiet dark workspace where documents live in a sidebar and every answer is a card that carries its sources.
colors:
  page-bg: "#0e1012"
  sidebar-bg: "#15181b"
  card-bg: "#1b1f23"
  border: "#2a2f35"
  text: "#e7eaee"
  text-secondary: "#9aa3ad"
  mint: "#5ef2b8"
  mint-text-on: "#0e1012"
  mint-quote-bg: "rgba(94, 242, 184, 0.16)"
  red: "#ff6b6b"
typography:
  display:
    fontFamily: "'Barlow Condensed', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
    fontSize: "2.074rem"
    fontWeight: 700
    lineHeight: 1.35
    letterSpacing: "0.01em"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "-0.01em"
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
    fontSize: "1.2rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 700
    letterSpacing: "0.06em"
  mono:
    fontFamily: "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "0.8rem"
    fontWeight: 400
rounded:
  sm: "4px"
  md: "8px"
  pill: "999px"
spacing:
  1: "0.25rem"
  2: "0.5rem"
  3: "0.75rem"
  4: "1rem"
  5: "1.5rem"
  6: "2rem"
  7: "3rem"
components:
  button-primary:
    backgroundColor: "{colors.mint}"
    textColor: "{colors.mint-text-on}"
    rounded: "{rounded.md}"
    padding: "0.75rem 2rem"
    typography:
      fontWeight: 700
      fontSize: "1rem"
  button-primary-hover:
    backgroundColor: "#7ef5c6"
  button-primary-disabled:
    backgroundColor: "{colors.border}"
    textColor: "{colors.text-secondary}"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "0.5rem 1rem"
    typography:
      fontWeight: 600
      fontSize: "0.9rem"
  button-ghost-destructive:
    backgroundColor: "transparent"
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.sm}"
    padding: "0.25rem 0.5rem"
  chip:
    backgroundColor: "{colors.card-bg}"
    textColor: "{colors.text}"
    rounded: "{rounded.pill}"
    padding: "0.5rem 1rem"
    typography:
      fontSize: "0.875rem"
  card:
    backgroundColor: "{colors.card-bg}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "1.5rem"
  input:
    backgroundColor: "{colors.card-bg}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "0.75rem 1rem"
    typography:
      fontSize: "1.2rem"
---

# Design System: Grounded Q&A

## Overview

**Creative North Star: "The Operator's Console"**

A near-black workspace built for someone verifying machine-generated answers against source documents, not a marketing surface. The sidebar is a document manifest, not a nav decoration; the main panel is a command bar feeding a stack of evidence cards. Density is calm and functional: one accent color, flat surfaces that step up in lightness (not shadow) to signal hierarchy, and a single quiet entrance animation reserved for new answers. This build replaced an earlier kitchen-ticket-rail direction entirely; it refuses chat-bubble threads, decorative accent bars, and anything that performs warmth instead of trust.

**Key Characteristics:**
- Three-step dark surface stack (page → sidebar/card → border) instead of shadows for separation.
- One mint accent used only for the primary action, focus rings, and quote highlighting — never decoration.
- Condensed display face reserved for the wordmark alone; every control uses the system sans stack.
- Monospace reserved for data (counts, source locations, retrieved-passage scores), never for prose.

## Colors

A restrained dark palette: near-black ground, two lifted surface tones, one accent, one destructive signal.

### Primary
- **Signal Mint** (`#5ef2b8`): the single accent. Used on the Ask button fill, the focus-visible ring (2px, 2px offset), textarea caret, and the quote highlight underline in source passages. Never used decoratively elsewhere.

### Neutral
- **Void** (`#0e1012`): page background; also the text color printed on mint (button text).
- **Raised Sidebar** (`#15181b`): sidebar background, one step lighter than the page.
- **Card Surface** (`#1b1f23`): answer cards, chips, the ask textarea — the most-lifted surface.
- **Hairline Border** (`#2a2f35`): all 1px borders/dividers; also the scrollbar track/thumb base.
- **Primary Text** (`#e7eaee`): body copy, headings, answer text.
- **Secondary Text** (`#9aa3ad`): labels, metadata, tagline, placeholder text, disabled states.

### Destructive
- **Muted Red** (`#ff6b6b`): reserved for the two-step remove-document confirm state and the ask-error message border/text. Never used for anything else.

### Named Rules
**The One Accent Rule.** Mint appears only on the Ask action, focus states, the caret, and the quote highlight. No other UI element borrows it for emphasis or decoration.

**The Tonal-Step Rule.** Depth comes from three ascending surface lightness steps (page → sidebar/card → nothing brighter), not from multiple shadow weights or colored overlays.

## Typography

**Display Font:** Barlow Condensed 700 (self-hosted, with system sans fallback)
**Body Font:** System sans stack (`-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif`)
**Label/Mono Font:** `ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace`

**Character:** A condensed, confident wordmark against an otherwise plain, legible system-sans interface — utilitarian everywhere it matters, with exactly one typographic flourish.

### Hierarchy
- **Display** (700, 2.074rem, 1.35 line-height, 0.01em tracking): the "Grounded Q&A" wordmark only, Barlow Condensed.
- **Title** (400, 1.2rem, 1.4 line-height): the ask textarea's entered text and answer-card body text size.
- **Body** (400, 1rem, 1.5 line-height, -0.01em tracking): running UI text, document names, chip labels.
- **Label** (700, 0.75rem, uppercase, 0.06em tracking): section labels inside answer cards ("Sources") and the built-in document badge.
- **Mono/Data** (400, 0.8rem–0.9rem): document chunk counts, source document · location headers, retrieved-passage table cells — tabular-nums enabled.

### Named Rules
**The One Display Face Rule.** Barlow Condensed renders the wordmark and nothing else. Every button, label, card, and data value uses the system sans or mono stack.

## Layout

Fixed 280px left sidebar (sticky, full viewport height, independently scrollable) beside a flexible main column capped at 72rem, both padded on a 1.5–2rem rhythm. The main column stacks the ask form, example chips, then the answer feed (newest card first) with 1.5rem gaps between cards. Below 900px the sidebar collapses to a static top section (document list capped at 240px with its own scroll) above the ask bar; main padding tightens from 2rem to 1.5rem. Spacing runs an 8-step rem scale (0.25rem → 3rem) used consistently for gaps and padding; no ad hoc pixel values outside this scale appear in components.

## Elevation & Depth

Flat by default; depth is tonal, not shadow-driven. The only shadow in the system is a soft, low-contrast ambient shadow under answer cards, kept subtle enough that the border still does most of the separation work.

### Shadow Vocabulary
- **Ambient Card** (`box-shadow: 0 1px 2px rgba(0,0,0,0.4), 0 8px 20px -10px rgba(0,0,0,0.5)`): under every answer card, lifting it slightly off the main column without a hard edge.

### Named Rules
**The No-Hard-Shadow Rule.** Shadows are diffuse and low-opacity. No offset "sticker" or hard-edge shadow appears anywhere in this system.

## Shapes

Two radii cover the whole system: a tight 4px (`--radius-sm`) for small controls (focus outline, remove button, skeleton lines) and 8px (`--radius-md`) for surfaces (cards, textarea, buttons). Fully round pill shape (999px) is reserved for the built-in-source badge and example-question chips — the only two "token" shaped elements in the system. All borders are 1px solid hairline (`#2a2f35`); no double borders or inset rings.

## Components

### Buttons
- **Shape:** 8px radius (`--radius-md`) for the primary Ask button and the ghost Add-a-PDF button.
- **Primary (Ask):** mint fill (`#5ef2b8`) with void text (`#0e1012`), bold 700 weight, `0.75rem 2rem` padding. Hover lightens to `#7ef5c6`; disabled (while answering) swaps to border-gray fill with secondary text and a `progress` cursor.
- **Secondary/Ghost (Add a PDF):** transparent background, 1px hairline border, primary text, 600 weight; hover brightens the border to secondary-text gray.
- **Destructive-inline (document remove):** starts as a small ghost icon-less button with hairline border and secondary text; on first click it becomes an inline "Confirm" label in muted red with a red border for about 4 seconds before reverting — a two-step confirm, not a modal.

### Chips
- **Style:** card-surface background, hairline border, pill radius, primary text, 0.875rem — used for the example-question suggestions.
- **State:** no selected/filter state; these are one-shot action chips that populate the ask textarea, not toggles.

### Cards / Containers
- **Corner Style:** 8px radius.
- **Background:** card surface (`#1b1f23`).
- **Shadow Strategy:** Ambient Card shadow (see Elevation & Depth); paired with a 1px hairline border, not shadow alone.
- **Border:** 1px solid `#2a2f35` throughout; sources and retrieved-passage sections use the same hairline as internal dividers.
- **Internal Padding:** 1.5rem (`--space-5`).
- **Signature behavior:** new answer cards enter with a 200ms fade + 6px rise (`card-enter` keyframe), instant under `prefers-reduced-motion: reduce`. A refusal card ("Not in the documents") uses the same card shell with a small inline SVG glyph and a calm secondary-text hint instead of an answer body.

### Inputs / Fields
- **Style:** card-surface background, 1px hairline border, 8px radius, 1.2rem text, mint caret.
- **Focus:** 2px solid mint outline with 2px offset (`:focus-visible`), applied system-wide, not just on the textarea.
- **Error:** a separate ask-error block (not an inline field state) — card-surface background, 1px solid red border, red bold text, hidden entirely when empty.

### Navigation
- Sidebar-as-navigation: wordmark (Barlow Condensed) + one-line secondary-text tagline, then a "Documents" list of hairline-divided rows (name, mono chunk count, optional pill "built-in" badge, ghost remove button), then the Add-a-PDF ghost button. No active/hover row state beyond the remove button's own states; this list is a manifest, not a link nav.

### Answer Card (signature component)
The structural unit of the whole app. Holds the asked question (secondary text, 0.875rem, muted), then either an answer (title-size primary text) or a refusal, then a "Sources" label and a list of source items (mono document·location header + passage text with a mint-highlighted verbatim quote), then a collapsible "Retrieved passages" `<details>` table (mono, tabular-nums, similarity scores). Newest card always renders first.

## Do's and Don'ts

### Do:
- **Do** keep mint to exactly one functional accent: the Ask button, focus rings, the caret, and quote highlights (`{colors.mint}` / `{colors.mint-quote-bg}`).
- **Do** use the ascending tonal stack (void → sidebar/card → hairline border) for all hierarchy and separation instead of adding new shadow weights.
- **Do** reserve Barlow Condensed for the wordmark only; every other text element uses the system sans or mono stack.
- **Do** use the two-step inline confirm pattern (button text swaps to red "Confirm" for ~4s) for any future destructive action instead of a modal dialog.
- **Do** disable the card-enter animation under `prefers-reduced-motion: reduce`; it is the only authored motion in the system and must stay optional.

### Don't:
- **Don't** introduce a second accent color or a decorative gradient; the One Accent Rule covers the whole system.
- **Don't** add hard-edged "sticker" shadows or offset borders; this is not a neobrutalist world, and the Ambient Card shadow is the only shadow token.
- **Don't** add kicker/eyebrow labels above headings as a decorative device; the uppercase Label style exists only as a functional section header ("Sources") inside a card, never as ornament.
- **Don't** reintroduce the earlier kitchen-ticket-rail visual language (paper texture, ticket perforation, warm palette); that world was explicitly replaced by this dark app shell.
