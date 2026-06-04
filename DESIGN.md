---
name: Mcode
description: Orchestration surface for running many coding agents at once — glanceable, editorial, dark by default.
colors:
  amber-primary: "oklch(0.72 0.17 75)"
  amber-primary-light: "oklch(0.52 0.17 75)"
  ink: "oklch(0.93 0 0)"
  muted-ink: "oklch(0.65 0.005 260)"
  slate-page: "oklch(0.12 0.005 260)"
  slate-bg: "oklch(0.16 0.005 260)"
  slate-card: "oklch(0.19 0.005 260)"
  slate-muted: "oklch(0.22 0.005 260)"
  slate-accent: "oklch(0.24 0.005 260)"
  slate-border: "oklch(0.28 0.005 260)"
  cool-ring: "oklch(0.62 0.19 264)"
  patina-sage: "oklch(0.78 0.13 145)"
  oxide-clay: "oklch(0.78 0.13 25)"
  destructive: "oklch(0.65 0.2 25)"
typography:
  heading:
    fontFamily: "SF Mono, Cascadia Code, Consolas, monospace"
    fontSize: "0.65rem"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "0.16em"
  body:
    fontFamily: "Public Sans, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "normal"
  title:
    fontFamily: "Public Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.01em"
  label:
    fontFamily: "SF Mono, Cascadia Code, Consolas, monospace"
    fontSize: "0.625rem"
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: "0.18em"
  mono:
    fontFamily: "SF Mono, Cascadia Code, Consolas, monospace"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "normal"
rounded:
  sm: "0.375rem"
  md: "0.5rem"
  lg: "0.625rem"
  xl: "0.875rem"
  2xl: "1.125rem"
components:
  button-primary:
    backgroundColor: "{colors.amber-primary}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "0 0.625rem"
    height: "2rem"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "0 0.625rem"
    height: "2rem"
  input:
    backgroundColor: "{colors.slate-accent}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "0 0.625rem"
    height: "2rem"
  panel:
    backgroundColor: "{colors.slate-card}"
    textColor: "{colors.ink}"
    rounded: "{rounded.xl}"
    padding: "0.75rem"
---

# Design System: Mcode

## 1. Overview

**Creative North Star: "The Quiet Workbench"**

Mcode is the surface a developer keeps open all evening on a second monitor while five agents run in parallel. It is not a destination; it is an instrument panel that sits next to the editor, the terminal, and the browser. So the whole system is built for the *glance*, not the read. The user is rarely studying the agent's prose; they are flicking their eyes to the sidebar to see what finished, what errored, and what branch each run is on. Everything here optimizes that one-second scan: a status dot read at flick-speed is worth more than a paragraph.

The register is editorial and typeset, closer to a well-made code editor or a terminal than a CRM or a SaaS dashboard. Density is a feature. Developers tolerate and prefer tight layouts with monospaced, tabular numerics; we do not pad with marketing whitespace. Color is rationed: a warm amber primary on a matte cool-slate canvas, with sage for additions and clay for removals. The amber is the workbench lamp, the slate is the room around it after dark. Dark is the default canvas because the product is used in the evening; a warm light counterpart exists for daytime, built on near-white warm neutrals.

This system explicitly rejects the consumer-app reflexes: no softened "Oops, something went wrong" copy (we say "Errored", "Idle", "Empty"), no emoji decoration, no colorful status chips, no glassmorphism, no gradient hero metrics, no marketing voice in the diff. If it looks like it wants to convert a visitor, it is wrong. It should look like it wants to get out of the way.

**Key Characteristics:**
- Glance-first: status communicated by tinted dots and small monochrome glyphs, never paragraphs.
- Dark-primary, warm-amber accent on cool-slate surfaces; light theme is the warm-neutral counterpart.
- Tonal lift instead of divider lines: panels float a few percent off the page.
- Monospace carries machine facts (SHAs, counts, timestamps, status labels); Public Sans carries human prose.
- Keyboard-first: shortcuts are first-class, not hidden.
- Information-dense by intent: tight, tabular, no decorative padding.

## 2. Colors

A warm amber accent rationed over a matte cool-slate canvas, with a sage/clay pair reserved exclusively for diff and run-state semantics.

### Primary
- **Filament Amber** (`oklch(0.72 0.17 75)` dark / `oklch(0.52 0.17 75)` light): The single accent. Primary buttons, active selection fill, focus pulse, running-indicator dots, the typing cursor color stop. Hue 75 reads as a warm workbench lamp, not a brand purple. The same hue and chroma shift only in lightness between themes so identity holds across both.

### Secondary
- **Cool Ring** (`oklch(0.62 0.19 264)`): The dark-theme focus ring and sidebar-primary tint. A cooler blue-violet used only for focus affordance and charts, never as a second brand voice.

### Tertiary
- **Patina Sage** (`oklch(0.78 0.13 145)` strong): Additions and completed/idle-good state. Diff add gutters, add text, the "succeeded" reading of a status dot.
- **Oxide Clay** (`oklch(0.78 0.13 25)` strong): Removals and the errored reading. Diff remove gutters and remove text. Closely related to `destructive` (`oklch(0.65 0.2 25)`) but desaturated for inline diff legibility.

### Neutral
- **Ink** (`oklch(0.93 0 0)` dark / `oklch(0.18 0.005 75)` light): Primary text. Near-white in dark, near-black-warm in light. Never pure `#fff` or `#000`.
- **Muted Ink** (`oklch(0.65 0.005 260)`): Secondary text, meta, captions. Holds ≥4.5:1 on slate surfaces; do not push muted text lighter "for elegance."
- **Slate Page** (`oklch(0.12 0.005 260)`): The darkest layer, page chrome. Panels sit *above* it.
- **Slate Background** (`oklch(0.16 0.005 260)`): App background, one step up from page.
- **Slate Card** (`oklch(0.19 0.005 260)`): Floating panels, popovers, cards — lifted off the background by tone, not by shadow.
- **Slate Muted / Accent** (`oklch(0.22–0.24 0.005 260)`): Hover fills, secondary surfaces, input wells, selection backgrounds.
- **Slate Border** (`oklch(0.28 0.005 260)`): The rare explicit hairline, only where tonal lift cannot carry the separation.

Light theme mirrors this on warm neutrals: page `oklch(0.955 0.005 75)`, background `oklch(0.99 0.005 75)`, card `oklch(0.985 0.005 75)`, all at hue 75 with 0.005 chroma so the surfaces harmonize with the amber rather than read as cream.

### Named Rules
**The One Lamp Rule.** Filament Amber is the only brand color. It appears on a small fraction of any screen — the active row, the primary action, the live dot. Its rarity is what makes a glance land. Adding a second accent for variety breaks the instrument.

**The Semantic-Only Sage/Clay Rule.** Sage and clay are never decoration. They mean addition/good and removal/error. A green that does not mean "added or succeeded" and a red that does not mean "removed or errored" are forbidden.

**The Tinted-Neutral Rule.** Neutrals are never pure gray. Dark surfaces carry 0.005 chroma toward cool hue 260; light surfaces carry 0.005 toward warm hue 75. The tint is subliminal and load-bearing for cohesion.

## 3. Typography

**Display / Body Font:** Public Sans (with `ui-sans-serif, system-ui, -apple-system, sans-serif`)
**Label / Mono Font:** SF Mono (with `Cascadia Code, Consolas, monospace`)

**Character:** A single humanist sans does the human-facing work — prose, titles, controls — at a calm 14px baseline. Monospace is not a "developer vibe"; it is reserved for facts a machine produced. The contrast between the two is the entire type system: if it came from a person, it is Public Sans; if it is a SHA, a count, a timestamp, or a status label, it is mono.

### Hierarchy
- **Title** (Public Sans, 600, 1rem, line-height 1.3, letter-spacing -0.01em): Panel and dialog titles. The largest type in the app; this is product UI, not a hero — there is no display scale above ~1rem.
- **Body** (Public Sans, 400, 0.875rem / 14px, line-height 1.55): Agent prose, descriptions, the Whisper narrative timeline. Cap prose at 65–75ch.
- **Heading / Eyebrow** (mono, 600, ~0.65rem, letter-spacing 0.16em, uppercase small-caps): Section headings inside panels. Wide-tracked mono small-caps, used sparingly as structure, not on every block.
- **Label** (mono, 500, 0.625rem / 10.5px, letter-spacing 0.18em, uppercase): Status labels ("ERRORED", "IDLE"), empty-state captions, micro-meta.
- **Mono Data** (mono, 400, 0.75rem, tabular-nums): SHAs, file counts, timestamps, durations. Always `tabular-nums` so columns of numerals align.

### Named Rules
**The Mono-Is-Machine Rule.** Monospace marks machine-authored facts only. Prose in mono, or numerals in Public Sans, is a category error. Counts and timestamps additionally take `tabular-nums`.

**The No-Hero Rule.** This is an app, not a landing page. Type tops out near 1rem. There is no `clamp()` display scale, no oversized headline; hierarchy comes from weight and mono/sans contrast, not size.

## 4. Elevation

Flat by default. Depth is conveyed by **tonal layering**, not shadows. The signature move: `--page` sits a few percent below (dark) or above (light) `--background`, and floating panels (`--card`, `--popover`) step further along the lightness ramp so they read as lifted off the chrome. This replaces inter-panel divider lines entirely. Reach for tonal separation before reaching for a `border`.

Shadows exist only as a response to interactive state, never as ambient decoration.

### Shadow Vocabulary
- **Focus ring** (`box-shadow: 0 0 0 3px oklch(0.62 0.19 264 / 0.2)`): The cool-ring focus affordance on inputs and buttons.
- **Focus ring, offset** (`box-shadow: 0 0 0 2px var(--background), 0 0 0 4px var(--ring)`): Keyboard focus on dense, adjacent controls where a flat ring would bleed into the neighbor.
- **Edge glow** (`box-shadow: -2px 0 8px -1px oklch(0.72 0.17 75 / 0.35)`): A single amber edge cue at a panel boundary; used once, deliberately, not as a card style.

### Named Rules
**The Tonal-Lift Rule.** Separation between surfaces is carried by a step on the lightness ramp, not by a line. A divider line is a failure of the tonal system. Use `--border` only where two surfaces share the same tone and must still be distinguished.

**The Shadow-Is-State Rule.** Surfaces are flat at rest. A shadow appears only on focus or as a one-off boundary cue. Resting drop shadows under cards are forbidden.

## 5. Components

### Buttons
- **Shape:** Gently rounded (`var(--radius-lg)`, 10px); smaller sizes step down to `min(var(--radius-md), 12px)`.
- **Primary:** Filament Amber fill, ink text, `h-8 px-2.5`, `text-sm font-medium`. Hover drops opacity to 80%.
- **Ghost / Secondary:** Transparent or slate-secondary fill; hover lifts to `--muted`. Ghost is the default for dense toolbars — most buttons are not primary.
- **Hover / Focus:** `transition-all`; `active:translate-y-px` for a tactile press; focus-visible draws `ring-3 ring-ring/50` plus a border shift. Destructive uses a 10% destructive tint, not a solid red fill.

### Inputs / Fields
- **Style:** Slate-accent well (`--input`), 10px radius, no heavy stroke; the well's tone separates it from the panel.
- **Focus:** Cool-ring glow (`0 0 0 3px ring/20%`) with a border shift to `--ring`. No bounce, no color flash.
- **Error / Disabled:** `aria-invalid` draws a destructive border and ring; disabled drops to 50% opacity and `pointer-events-none`.

### Cards / Panels
- **Corner Style:** 14px (`--radius-xl`) for primary floating panels.
- **Background:** `--card` / `--popover`, lifted off `--background` by tone.
- **Shadow Strategy:** None at rest (see Elevation). Separation is tonal.
- **Border:** Avoid. Only `--border` where tones match. Never a colored side-stripe.
- **Internal Padding:** 12px (`0.75rem`) typical; tighten for dense lists.

### Navigation (Sidebar)
- **Style:** Projects-and-threads tree, drag-reorderable, one status dot per thread. The first thing the user scans, every time.
- **States:** Selection is a full row-fill with `bg-accent` — never a left side-stripe. Indentation alone carries tree depth; no nested guide rails.
- **Status dot:** 1.5–2px tinted dot in a tokenized color (amber running, sage idle/ok, clay errored). Active/running dots pulse at 6px `bg-primary`.

### Status Dot (signature)
The smallest and most important component. A 6px dot whose tokenized color is the entire status message. Running pulses amber via `color-mix(in oklch, var(--primary), transparent 85%)`; idle is steady sage; errored is steady clay. It must be legible and distinguishable at flick-speed and at 100% zoom. It is never accompanied by a colored chip or a word when the dot alone suffices.

### Empty States (signature)
A single large glyph (28px `font-mono`, `text-muted-foreground/15`: ◌, ⊘, ⊕, ⌂) over a small-caps mono caption (10.5px, `tracking-[0.18em]`, `text-muted-foreground/40`). No illustrations, no "Nothing here yet!" hand-holding, no primary CTA. The glyph and the technical caption are the whole empty state.

### Next-Step Slot (signature)
The interface expression of the "Anticipate the next step" product principle. A thin slot at the seam between the narrative and the composer, in the same place in every thread. When the thread reaches a state with a likely next move, the slot shows it: a single Filament Amber primary action (`View diff`, `Re-run`, `Switch to Build`) with any other valid moves beside it as quiet ghost buttons. When there is no next move, the slot collapses to nothing — no empty chrome. The primary is bound to a consistent accept key (Tab) so the gesture is the same everywhere. Safe, single-outcome transitions (add project → new chat) do not render here; they auto-advance, landing the user on the next surface with one quiet cue (the breadcrumb lights briefly), per Quiet-over-loud.

### Named Rules
**The One Next-Step Rule.** Each state elevates exactly one primary next action, in amber. Everything else stays a quiet ghost. Never two competing primaries; the rarity of the amber is what makes the suggestion legible at a glance.

**The Curated-Not-Clever Rule.** The next step is a fixed function of state, the same every time. It does not learn, reorder, or guess. Predictability is the feature; a suggestion the user has to second-guess is worse than none.

## 6. Do's and Don'ts

### Do:
- **Do** ration Filament Amber. One accent, small footprint, reserved for the active row, the primary action, and live indicators.
- **Do** carry separation with tonal lift; step a surface along the lightness ramp before adding a line.
- **Do** set SHAs, counts, timestamps, and status labels in mono, with `tabular-nums` for any numerals.
- **Do** use full row-fill (`bg-accent`) for selection, and indentation alone for tree depth.
- **Do** write technical copy: "Errored", "Idle", "Empty". Match PRODUCT.md's voice.
- **Do** give every animation a `prefers-reduced-motion` alternative, and reuse the existing `wizard-*` and `narrative-*` curves (`cubic-bezier(0.25, 1, 0.5, 1)` and `cubic-bezier(0.22, 1, 0.36, 1)`) rather than inventing new ones.
- **Do** keep type capped near 1rem; build hierarchy from weight and mono/sans contrast.
- **Do** elevate exactly one next-step per state in amber, bound to the Tab accept key, and auto-advance only single-outcome transitions.

### Don't:
- **Don't** use `border-left` or `border-right` greater than 1px as a colored accent stripe on rows, cards, callouts, or alerts. Selection is a row-fill.
- **Don't** add nested guide rails (`border-l border-border/50 pl-2`) for tree indentation. Indentation alone.
- **Don't** use gradient text (`background-clip: text` over a gradient). Solid colors only.
- **Don't** use glassmorphism, decorative glow borders, or resting drop shadows on cards.
- **Don't** introduce a second brand accent, or use green/red for anything other than added-or-good / removed-or-errored.
- **Don't** soften copy into consumer language ("Oops, something went wrong"), add emoji decoration, or use colorful status chips where a tinted dot suffices.
- **Don't** use raw Tailwind state colors (`bg-yellow-500`, `bg-green-500`). Use the tokenized diff/status colors.
- **Don't** pad with marketing whitespace or build a hero-metric layout. This is a dense instrument, not a landing page.
- **Don't** show two competing primary next-steps, auto-advance a transition that has a real choice, or let the next-step suggestion learn or reorder itself. Curated and singular, or nothing.
