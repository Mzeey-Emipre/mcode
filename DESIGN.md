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
  cool-link: "oklch(0.7 0.14 260)"
  cool-link-light: "oklch(0.5 0.16 260)"
  patina-sage: "oklch(0.78 0.13 145)"
  oxide-clay: "oklch(0.78 0.13 25)"
  destructive: "oklch(0.65 0.2 25)"
typography:
  h1:
    fontFamily: "Public Sans, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "4.8rem"
    fontWeight: 600
    lineHeight: "5.6rem"
    letterSpacing: "-0.03em"
  h2:
    fontFamily: "Public Sans, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "4rem"
    fontWeight: 600
    lineHeight: "4.8rem"
    letterSpacing: "-0.025em"
  h3:
    fontFamily: "Public Sans, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "3.2rem"
    fontWeight: 600
    lineHeight: "4rem"
    letterSpacing: "-0.02em"
  h4:
    fontFamily: "Public Sans, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "2.8rem"
    fontWeight: 600
    lineHeight: "3.2rem"
    letterSpacing: "-0.015em"
  h5:
    fontFamily: "Public Sans, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "2.4rem"
    fontWeight: 600
    lineHeight: "2.8rem"
    letterSpacing: "-0.01em"
  h6:
    fontFamily: "Public Sans, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "2rem"
    fontWeight: 600
    lineHeight: "2.4rem"
    letterSpacing: "normal"
  body-md:
    fontFamily: "Public Sans, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "1.6rem"
    fontWeight: 400
    lineHeight: "2rem"
    letterSpacing: "normal"
  body-md-semibold:
    fontFamily: "Public Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.6rem"
    fontWeight: 600
    lineHeight: "2rem"
    letterSpacing: "normal"
  body-sm:
    fontFamily: "Public Sans, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "1.4rem"
    fontWeight: 400
    lineHeight: "1.6rem"
    letterSpacing: "normal"
  body-sm-semibold:
    fontFamily: "Public Sans, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "1.4rem"
    fontWeight: 600
    lineHeight: "1.6rem"
    letterSpacing: "normal"
  body-lg:
    fontFamily: "Public Sans, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "2rem"
    fontWeight: 400
    lineHeight: "2.4rem"
    letterSpacing: "normal"
  body-lg-semibold:
    fontFamily: "Public Sans, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "2rem"
    fontWeight: 600
    lineHeight: "2.4rem"
    letterSpacing: "normal"
  button-link:
    fontFamily: "Public Sans, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "1.6rem"
    fontWeight: 500
    lineHeight: "2rem"
    letterSpacing: "normal"
  button-link-sm:
    fontFamily: "Public Sans, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "1.4rem"
    fontWeight: 500
    lineHeight: "1.6rem"
    letterSpacing: "normal"
  button-link-lg:
    fontFamily: "Public Sans, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "2rem"
    fontWeight: 500
    lineHeight: "2.4rem"
    letterSpacing: "normal"
  caption:
    fontFamily: "Public Sans, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "1.2rem"
    fontWeight: 400
    lineHeight: "1.6rem"
    letterSpacing: "normal"
  mono-data:
    fontFamily: "SF Mono, Cascadia Code, Consolas, monospace"
    fontSize: "1.2rem"
    fontWeight: 400
    lineHeight: "1.6rem"
    letterSpacing: "normal"
rounded:
  sm: "0.375rem"
  md: "0.5rem"
  lg: "0.625rem"
  xl: "0.875rem"
  2xl: "1.125rem"
spacing:
  1: "0.4rem"
  2: "0.8rem"
  3: "1.2rem"
  4: "1.6rem"
  5: "2rem"
  6: "2.4rem"
  8: "3.2rem"
  10: "4rem"
  12: "4.8rem"
  14: "5.6rem"
components:
  button-primary:
    backgroundColor: "{colors.amber-primary}"
    textColor: "{colors.ink}"
    typography: "{typography.button-link-sm}"
    rounded: "{rounded.lg}"
    padding: "0 1.2rem"
    height: "3.2rem"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.button-link-sm}"
    rounded: "{rounded.lg}"
    padding: "0 1.2rem"
    height: "3.2rem"
  input:
    backgroundColor: "{colors.slate-accent}"
    textColor: "{colors.ink}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.lg}"
    padding: "0 1.2rem"
    height: "3.2rem"
  panel:
    backgroundColor: "{colors.slate-bg}"
    textColor: "{colors.ink}"
    rounded: "0"
    padding: "0"
  floating-panel:
    backgroundColor: "{colors.slate-card}"
    textColor: "{colors.ink}"
    rounded: "{rounded.xl}"
    padding: "1.2rem"
---

# Design System: Mcode

## 1. Overview

**Creative North Star: "The Quiet Workbench"**

Mcode is the surface a developer keeps open all evening on a second monitor while five agents run in parallel. It is not a destination; it is an instrument panel that sits next to the editor, the terminal, and the browser. So the whole system is built for the *glance*, not the read. The user is rarely studying the agent's prose; they are flicking their eyes to the sidebar to see what finished, what errored, and what branch each run is on. Everything here optimizes that one-second scan: a status dot read at flick-speed is worth more than a paragraph.

The register is editorial and typeset, closer to a well-made code editor or a terminal than a CRM or a SaaS dashboard. Information density is a feature, but uniform compression is not. Repeated rows and tabular data stay compact. Groups, task stages, writing surfaces, and primary work areas use enough space to communicate hierarchy, focus, and ownership. Color is rationed: a warm amber primary on a matte cool-slate canvas, with sage for additions and clay for removals. The amber is the single point of warmth; the slate is the cool room around it after dark. Dark is the default canvas because the product is used in the evening; a cool light counterpart exists for daytime.

This system explicitly rejects the consumer-app reflexes: no softened "Oops, something went wrong" copy (we say "Errored", "Idle", "Empty"), no emoji decoration, no colorful status chips, no glassmorphism, no gradient hero metrics, no marketing voice in the diff. If it looks like it wants to convert a visitor, it is wrong. It should look like it wants to get out of the way.

**Key Characteristics:**
- Glance-first: status communicated by tinted dots and small monochrome glyphs, never paragraphs.
- Dark-primary, Filament Amber accent on cool-slate surfaces; light theme is the cool-neutral counterpart.
- Tonal lift instead of divider lines: panels float a few percent off the page.
- Monospace carries machine facts (SHAs, counts, timestamps, status labels); Public Sans carries human prose.
- Keyboard-first: shortcuts are first-class, not hidden.
- Information-dense by intent: compact related rows, clear group spacing, and no decorative padding.
- Four-point spacing: every layout gap, inset, control size, and icon size lands on a 4px step.
- Capability-preserving responsive layout: the same tool docks, floats, or
  collapses without losing state or actions.

## 2. Colors

A warm amber accent rationed over a matte cool-slate canvas, with a sage/clay pair reserved exclusively for diff and run-state semantics.

### Primary
- **Filament Amber** (`oklch(0.72 0.17 75)` dark / `oklch(0.52 0.17 75)` light): The single accent. Primary buttons, active selection fill, focus pulse, running-indicator dots, the typing cursor color stop. Hue 75 reads as a warm workbench lamp, not a brand purple. The same hue and chroma shift only in lightness between themes so identity holds across both. In dark theme the accent carries ink text (`oklch(0.15 0.005 260)`), not white, to hold 4.5:1.

### Secondary
- **Cool Ring** (`oklch(0.62 0.19 264)`): The dark-theme focus ring and sidebar-primary tint. A cooler blue-violet used only for focus affordance and charts, never as a second brand voice.
- **Cool Link** (`oklch(0.7 0.14 260)` dark / `oklch(0.5 0.16 260)` light): Hyperlinks and link-styled actions (`--link` / `text-link`). Links are navigational plumbing, not brand moments, so they take the surface's own cool hue at higher chroma rather than borrowing the amber lamp. Holds ≥4.5:1 on every slate surface including the accent message bubble.

### Tertiary
- **Patina Sage** (`oklch(0.78 0.13 145)` strong): Additions and completed/idle-good state. Diff add gutters, add text, the "succeeded" reading of a status dot.
- **Oxide Clay** (`oklch(0.78 0.13 25)` strong): Removals and the errored reading. Diff remove gutters and remove text. Closely related to `destructive` (`oklch(0.65 0.2 25)`) but desaturated for inline diff legibility.

### Neutral
- **Ink** (`oklch(0.93 0 0)` dark / `oklch(0.18 0.005 260)` light): Primary text. Near-white in dark, near-black-cool in light. Never pure `#fff` or `#000`.
- **Muted Ink** (`oklch(0.65 0.005 260)`): Secondary text, meta, captions. Holds ≥4.5:1 on slate surfaces; do not push muted text lighter "for elegance."
- **Slate Page** (`oklch(0.12 0.005 260)`): The darkest layer, page chrome. Panels sit *above* it.
- **Slate Background** (`oklch(0.16 0.005 260)`): App background, one step up from page.
- **Slate Card** (`oklch(0.19 0.005 260)`): Floating panels, popovers, cards — lifted off the background by tone, not by shadow.
- **Slate Muted / Accent** (`oklch(0.22–0.24 0.005 260)`): Hover fills, secondary surfaces, input wells, selection backgrounds.
- **Slate Border** (`oklch(0.28 0.005 260)`): The rare explicit hairline, only where tonal lift cannot carry the separation.

Light theme mirrors this on cool neutrals: page `oklch(0.955 0.005 260)`, background `oklch(0.99 0.005 260)`, card `oklch(0.985 0.005 260)`, all at hue 260 with 0.005 chroma so the lamp remains a point accent instead of tinting the surface system.

### Named Rules
**The One Lamp Rule.** Filament Amber is the only brand color. It appears on a small fraction of any screen: the active row, the primary action, the live dot. Its rarity is what makes a glance land. Adding a second accent for variety breaks the instrument.

**The Cold-Surface Rule.** Anything with area is cold; only points of light are warm. Surfaces, fills, and blocks of content, including the user's message bubble, are slate neutrals. Filament Amber is confined to point-scale accents: a dot, a button, a cursor, an active row. Functional affordances that are not brand moments, such as links, focus, and charts, take the cool family (`cool-link`, `cool-ring`). If a warm color covers more than a control's worth of pixels, it is wrong.

**The Semantic-Only Sage/Clay Rule.** Sage and clay are never decoration. They mean addition/good and removal/error. A green that does not mean "added or succeeded" and a red that does not mean "removed or errored" are forbidden.

**The Tinted-Neutral Rule.** Neutrals are never pure gray. Both themes carry 0.005 chroma toward cool hue 260. The tint is subliminal and load-bearing for cohesion.

## 3. Typography

**Display / Body Font:** Public Sans (with `ui-sans-serif, system-ui, -apple-system, sans-serif`)
**Label / Mono Font:** SF Mono (with `Cascadia Code, Consolas, monospace`)

**Character:** A single humanist sans does the human-facing work: headings, prose, controls, and captions. Monospace is not a "developer vibe"; it is reserved for facts a machine produced. The contrast between the two is the entire type system: if it came from a person, it is Public Sans; if it is a SHA, a count, a timestamp, or a status label, it is mono.

### Hierarchy
- **H1** (Public Sans, 600, `4.8rem / 5.6rem`): Rare screen-level or document-level heading. Use only when the surface has room to carry it.
- **H2** (Public Sans, 600, `4rem / 4.8rem`): Major panel heading or document section heading.
- **H3** (Public Sans, 600, `3.2rem / 4rem`): Section title inside a full surface.
- **H4** (Public Sans, 600, `2.8rem / 3.2rem`): Dialog title or high-emphasis panel title.
- **H5** (Public Sans, 600, `2.4rem / 2.8rem`): Compact panel title.
- **H6** (Public Sans, 600, `2rem / 2.4rem`): Dense subsection heading.
- **Body MD** (Public Sans, 400 or 600, `1.6rem / 2rem`): Default prose, forms, list rows, and primary readable UI copy.
- **Body SM** (Public Sans, 400 or 600, `1.4rem / 1.6rem`): Dense rows, helper text, compact controls, and secondary metadata.
- **Body LG** (Public Sans, 400 or 600, `2rem / 2.4rem`): High-emphasis readable copy where H6 would feel too structural.
- **Button Link** (Public Sans, 500, `1.6rem / 2rem`; small `1.4rem / 1.6rem`; large `2rem / 2.4rem`): Text inside buttons and link-styled actions.
- **Caption** (Public Sans, 400, `1.2rem / 1.6rem`): Fine print, timestamps, and low-emphasis labels.
- **Mono Data** (mono, 400, `1.2rem / 1.6rem`, tabular-nums): SHAs, file counts, timestamps, durations. Always `tabular-nums` so columns of numerals align.

### Named Rules
**The Mono-Is-Machine Rule.** Monospace marks machine-authored facts only. Prose in mono, or numerals in Public Sans, is a category error. Counts and timestamps additionally take `tabular-nums`.

**The Fixed-Type Rule.** Product UI uses fixed rem sizes, never fluid type. H1 through H6 are available for document and spacious panel hierarchy, but dense app chrome defaults to Body SM or Body MD. Do not invent in-between sizes.

**The Decimal Rem Rule.** The root font size is `62.5%`, making `1rem` equal to 10px in default browser settings. Express fixed dimensions in rem or em whenever practical, so `12px` becomes `1.2rem`, `32px` becomes `3.2rem`, and `48px` becomes `4.8rem`. Use raw px only for true hairlines, bitmap dimensions, canvas pixels, and sub-pixel optical fixes.

## 4. Elevation

Flat by default. Depth is conveyed by **tonal layering**, not shadows. The signature move: `--page` sits a few percent below (dark) or above (light) `--background`, and floating panels (`--card`, `--popover`) step further along the lightness ramp so they read as lifted off the chrome. Use tonal separation for macro surfaces. Use quiet hairlines for dense internal boundaries, toolbars, diff hunks, resize seams, and adjacent rows when tone alone does not make the structure clear.

Shadows exist only as a response to interactive state, never as ambient decoration.

### Shadow Vocabulary
- **Focus ring** (`box-shadow: 0 0 0 3px oklch(0.62 0.19 264 / 0.2)`): The cool-ring focus affordance on inputs and buttons.
- **Focus ring, offset** (`box-shadow: 0 0 0 2px var(--background), 0 0 0 4px var(--ring)`): Keyboard focus on dense, adjacent controls where a flat ring would bleed into the neighbor.
- **Edge glow** (`box-shadow: -2px 0 8px -1px color-mix(in oklch, var(--primary), transparent 65%)`): A single lamp edge cue at a panel boundary; used once, deliberately, not as a card style.

### Named Rules
**The Tonal-Lift Rule.** Separate major surfaces with a step on the lightness ramp. Use `--border` for compact internal structure where neighboring elements share a tone or where a resize, diff, toolbar, or row boundary must remain legible.

**The Shadow-Is-State Rule.** Surfaces are flat at rest. A shadow appears only on focus or as a one-off boundary cue. Resting drop shadows under cards are forbidden.

## 5. Components

### Buttons
- **Shape:** Gently rounded (`var(--radius-lg)`, 10px); smaller sizes step down to `min(var(--radius-md), 12px)`.
- **Control scale:** Small is `3.2rem` (32px), medium is `4.8rem` (48px), large is `5.6rem` (56px). Default dense toolbar buttons use small. Medium is for primary row actions and dialogs. Large is rare and belongs only to spacious confirmation or onboarding surfaces.
- **Icon-button scale:** Small is `3.2rem` (32px), medium is `4.8rem` (48px), large is `5.6rem` (56px). Icon-only buttons use the same outer box scale as text buttons so hit targets stay predictable.
- **Icon scale:** Small icons are `1.6rem` (16px), medium icons are `2.4rem` (24px), large icons are `3.2rem` (32px). Do not invent intermediate icon sizes unless the source artwork demands optical correction.
- **Primary:** Filament Amber fill, ink text, small height `3.2rem`, horizontal padding `1.2rem`, `text-sm font-medium`. Hover drops opacity to 80%.
- **Ghost / Secondary:** Transparent or slate-secondary fill; hover lifts to `--muted`. Ghost is the default for dense toolbars — most buttons are not primary.
- **Hover / Focus:** `transition-all`; `active:translate-y-px` for a tactile press; focus-visible draws `ring-3 ring-ring/50` plus a border shift. Destructive uses a 10% destructive tint, not a solid red fill.

### Inputs / Fields
- **Style:** Slate-accent well (`--input`), 10px radius, no heavy stroke; the well's tone separates it from the panel.
- **Typography:** Default inputs use Body SM (`1.4rem / 1.6rem`). Use Body MD (`1.6rem / 2rem`) for standard forms and dialogs. Use Body LG (`2rem / 2.4rem`) only when the input is the primary task on the surface.
- **Focus:** Cool-ring glow (`0 0 0 3px ring/20%`) with a border shift to `--ring`. No bounce, no color flash.
- **Error / Disabled:** `aria-invalid` draws a destructive border and ring; disabled drops to 50% opacity and `pointer-events-none`.

### Cards / Panels
- **Workspace panes:** Edge-to-edge, square to the app shell, and resizable where the user compares or inspects content. Do not wrap a primary work area in a decorative card.
- **Floating panels:** 14px (`--radius-xl`) for transient overlays, popovers, dialogs, and narrow layouts where a docked pane floats over the work area.
- **Background:** Workspace panes use the page/background layers. Floating panels use `--card` / `--popover`, lifted by tone.
- **Shadow Strategy:** None at rest (see Elevation). Separation is tonal.
- **Border:** Quiet hairlines are allowed for dense internal structure. Never a colored side-stripe.
- **Internal Padding:** 12px (`0.75rem`) typical. Repeated list rows may use less, while writing, reading, and decision surfaces should preserve comfortable structure.
- **Containment depth:** A discrete object may use one contained surface. Its
  headers, metadata, body, and actions stay flat inside it. Do not nest cards,
  tonal slabs, rings, and footers to restate the same boundary.

### Responsive Workspaces
- Preserve the component, its state, and its actions across widths.
- Prefer docked pane to floating pane to full-surface takeover. Use a modal only when the interaction itself is modal.
- Choose breakpoints from the component's usable content width, not a device label.
- Recompute posture while the user resizes. Do not require close and reopen.
- Keep one visible toggle for a panel. Do not add a second compact-only control that exposes a different version of the same tool.

### Action Hierarchy
- Give one task one visible control. Put alternate methods in an attached menu.
- Put persistent actions in persistent chrome. Do not create a second bottom toolbar for an action already available at the top.
- Keep primary color for the current selection or genuine primary action. Secondary toolbar actions stay neutral.
- Keep actions near the object they affect, without creating a panel solely to hold a button.

### Navigation (Sidebar)
- **Style:** Projects-and-threads tree, drag-reorderable, one status dot per thread. The first thing the user scans, every time.
- **States:** Selection is a full row-fill with `bg-accent` — never a left side-stripe. Indentation alone carries tree depth; no nested guide rails.
- **Status dot:** 1.5–2px tinted dot in a tokenized color (lamp running, sage idle/ok, clay errored). Active/running dots pulse at 6px `bg-primary`.

### Status Dot (signature)
The smallest and most important component. A 6px dot whose tokenized color is the entire status message. Running pulses lamp via `color-mix(in oklch, var(--primary), transparent 85%)`; idle is steady sage; errored is steady clay. It must be legible and distinguishable at flick-speed and at 100% zoom. It is never accompanied by a colored chip or a word when the dot alone suffices.

### Empty States (signature)
A single large glyph (28px `font-mono`, `text-muted-foreground/15`: ◌, ⊘, ⊕, ⌂) over a small-caps mono caption (10.5px, `tracking-[0.18em]`, `text-muted-foreground/40`). No illustrations, no "Nothing here yet!" hand-holding, no primary CTA. The glyph and the technical caption are the whole empty state.

### Next-Step Slot (signature)
The interface expression of the "Anticipate the next step" product principle. A thin slot at the seam between the narrative and the composer, in the same place in every thread. When the thread reaches a state with a likely next move, the slot shows it: a single Filament Amber primary action (`View diff`, `Re-run`, `Switch to Build`) with any other valid moves beside it as quiet ghost buttons. When there is no next move, the slot collapses to nothing, no empty chrome. The primary is bound to a consistent accept key (Tab) so the gesture is the same everywhere. Safe, single-outcome transitions (add project -> new chat) do not render here; they auto-advance, landing the user on the next surface with one quiet cue (the breadcrumb lights briefly), per Quiet-over-loud.

### Named Rules
**The One Next-Step Rule.** Each state elevates exactly one primary next action in Filament Amber. Everything else stays a quiet ghost. Never two competing primaries; the rarity of the lamp is what makes the suggestion legible at a glance.

**The Curated-Not-Clever Rule.** The next step is a fixed function of state, the same every time. It does not learn, reorder, or guess. Predictability is the feature; a suggestion the user has to second-guess is worse than none.

## 6. Do's and Don'ts

### Do:
- **Do** use the 4-point spacing scale: `0.4rem` (4px), `0.8rem` (8px), `1.2rem` (12px), `1.6rem` (16px), `2.4rem` (24px), `3.2rem` (32px), `4.8rem` (48px), and `5.6rem` (56px).
- **Do** write fixed dimensions in rem or em where practical. With the `62.5%` root, divide px by 10 to get the rem value.
- **Do** keep buttons, icon buttons, and icons on their named small, medium, and large scales.
- **Do** ration Filament Amber. One accent, small footprint, reserved for the active row, the primary action, and live indicators.
- **Do** carry separation with tonal lift; step a surface along the lightness ramp before adding a line.
- **Do** set SHAs, counts, timestamps, and status labels in mono, with `tabular-nums` for any numerals.
- **Do** use full row-fill (`bg-accent`) for selection, and indentation alone for tree depth.
- **Do** set hyperlinks and link-styled text in Cool Link (`text-link`), never amber. Cold for plumbing, warm for the lamp.
- **Do** write technical copy: "Errored", "Idle", "Empty". Match PRODUCT.md's voice.
- **Do** keep one alignment axis through headings, filters, tabs, and the content they control. A content column may be centered inside a pane while its text remains left-aligned.
- **Do** preserve the same reusable panel and its capabilities across responsive postures.
- **Do** show identity before state. Use the familiar object icon for files,
  people, and pull requests, then add a restrained semantic marker for added,
  modified, draft, merged, passing, or failing state.
- **Do** render the meaning of implementation metadata. Replace raw wire syntax
  with a familiar label, separator, diagram, disclosure, or status.
- **Do** give every animation a `prefers-reduced-motion` alternative, and reuse the existing `wizard-*` and `narrative-*` curves (`cubic-bezier(0.25, 1, 0.5, 1)` and `cubic-bezier(0.22, 1, 0.36, 1)`) rather than inventing new ones.
- **Do** use the documented type scale exactly; dense chrome defaults to Body SM or Body MD, while H1-H6 are reserved for document and spacious panel hierarchy.
- **Do** elevate exactly one next-step per state in Filament Amber, bound to the Tab accept key, and auto-advance only single-outcome transitions.

### Don't:
- **Don't** add off-scale gaps or control sizes for visual convenience. If a value is not a 4px step, it needs an optical reason.
- **Don't** mix px and rem for the same sizing system. Raw px is reserved for hairlines, bitmap dimensions, canvas pixels, and sub-pixel fixes.
- **Don't** use `border-left` or `border-right` greater than 1px as a colored accent stripe on rows, cards, callouts, or alerts. Selection is a row-fill.
- **Don't** add nested guide rails (`border-l border-border/50 pl-2`) for tree indentation. Indentation alone.
- **Don't** use gradient text (`background-clip: text` over a gradient). Solid colors only.
- **Don't** use glassmorphism, decorative glow borders, or resting drop shadows on cards.
- **Don't** introduce a second brand accent, or use green/red for anything other than added-or-good / removed-or-errored.
- **Don't** soften copy into consumer language ("Oops, something went wrong"), add emoji decoration, or use colorful status chips where a tinted dot suffices.
- **Don't** use raw Tailwind state colors (`bg-yellow-500`, `bg-green-500`). Use the tokenized diff/status colors.
- **Don't** fill a content surface with the lamp color (`bg-primary` on message bubbles, panels, or any block of prose). Lamp at area scale violates the Cold-Surface Rule; content surfaces are slate neutrals.
- **Don't** pad with marketing whitespace or build a hero-metric layout. This is a dense instrument, not a landing page.
- **Don't** interpret "centered everything" as a ban on centered content columns. The ban is about centered text and templated compositions, not a shared pane axis.
- **Don't** replace a resizable panel with a dropdown, picker, or modal as a responsive shortcut.
- **Don't** duplicate persistent actions in top and bottom chrome, or expose two controls for the same layout choice.
- **Don't** show two competing primary next-steps, auto-advance a transition that has a real choice, or let the next-step suggestion learn or reorder itself. Curated and singular, or nothing.
