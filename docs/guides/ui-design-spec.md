# Mcode Design Specification

*For designers. This document tells you what Mcode should feel like and the principles that hold it together — not which tokens to use. Bring your own taste; the rules below are the floor, not the ceiling.*

---

## 1. What Mcode Is

Mcode is a tool where developers run AI coding agents in parallel — multiple agents, multiple branches, multiple projects, all in flight at once. It ships in two forms: a **desktop app** (the daily driver, kept open on a second monitor next to the editor) and a **web app** (same surface, reached from any browser when away from the primary machine).

Both surfaces share the same design language and the same workflows. The desktop shell adds native integrations — window chrome, OS file pickers, terminal access — but the visual system is identical. Design once, ship to both.

It is a **tool**, not a product page. It sits in the same family as a code editor, a terminal, a Git client, a database GUI. Not the same family as a CRM, a project management tool, or a SaaS dashboard.

## 2. The Person at the Keyboard

Picture a developer at 11pm, on their fourth coffee, with eight agents running across three projects. They have a Spotify window, a terminal, a browser with twenty tabs, and Mcode all visible on a single 27" monitor. They glance at Mcode every few minutes to see what's progressed. They expect to absorb the state of all that work in less than three seconds.

Design **for that glance.** Information must be readable at a flick of the eye, not after a beat of parsing. Decoration that competes with the data is hostile.

## 3. Brand Personality

If Mcode were a physical object, it would be:

- A **letterpress catalog of microscope slides** — quiet, indexed, intentional, every label set with care
- A **late-1970s mainframe operator's console** — utilitarian, dense, lit warmly, no apology
- A **museum exhibit caption** behind a vitrine — small type, generous spacing around it, you lean in to read

It would not be:

- A landing page for a developer-tools startup
- A control room from a sci-fi film
- A meditation app
- Any flavor of "designer dashboard" with a big chart and four KPI tiles

**Tone of voice** is technical and unsoftened. We say "Errored", not "Something went wrong." "Idle", not "Waiting for activity." "Empty", not "No items yet — get started!" Copy is small, lower-contrast than the data it describes, and never apologizes.

## 4. Visual Direction

### Warmth in the dark

Both themes (light and dark) are warm. The dark theme is **the primary canvas** because most users keep this app open in the evening. Lean into amber and clay; avoid the blue-cyan-on-black "AI dashboard" cliché at all costs.

The accent color is a **warm amber**, somewhere between brass and tobacco. It appears rarely — on the active state, the running indicator, the focus ring. When you see it, it should mean something. If amber is everywhere, amber is meaningless.

Sage green carries success and additions. Clay red carries removals and errors. Both are muted siblings of the amber, not bright signal lights. Color works because it is **rare and earned**, not distributed evenly.

### Tonal lift instead of lines

Panels float on a slightly darker page. They are separated by **tonal contrast**, not by border lines. This is the single most defining surface decision in the product. If you find yourself reaching for a divider line between two surfaces, ask whether the surfaces could just sit on different tones instead.

Shadows are subtle. Cards have a quiet inner ring rather than a heavy drop shadow. The interface should feel like it was *cut*, not *drawn on top of itself*.

### Typography is the design

There is no illustration in Mcode. There are no marketing graphics, no decorative shapes, no patterns, no gradients. The typographic system **is** the design. Choose body and mono families that feel like a well-typeset book, not like a default OS picker.

Section headings are tiny mono small-caps with wide letter-spacing — they read like a librarian's index labels. Numbers, hashes, timestamps are always tabular monospace so they line up vertically. Body text is set tight enough to be dense but loose enough to read in a long session.

### Empty states earn their place

When there's nothing to show, do not show an illustration of an empty box. Set a single typographic glyph — `◌`, `⊘`, `⊕`, `∅`, `⌂` — at low opacity, with a small-caps mono caption underneath. The glyph is a quiet anchor, not a mascot. The caption uses technical language: "Empty thread", "No active runs", "Awaiting agent."

## 5. Density Is a Feature, Not a Bug

Developers prefer information-dense interfaces. They tolerate small type, tight rows, and packed columns — because every pixel of whitespace is a pixel they have to scan past.

This means:

- Don't pad with marketing-style breathing room. Tight is correct.
- Don't blow up small data into big "stat tiles." Numbers can be 12px and tabular.
- Don't replace a row of text with a grid of cards. Rows scan faster than cards.
- Don't hide tertiary actions behind hovers if there's room to show them.

But **density is not chaos.** Hierarchy comes from weight, opacity tier, and tonal lift — not from boxing things in. A dense interface that uses three opacity levels (full, 70%, 40%) for primary/secondary/tertiary text is more readable than a sparse one with everything at full contrast.

## 6. Status, Motion, and Time

Mcode shows agents that are **alive** — they're working, thinking, writing files. The interface needs to make that legible without becoming a slot machine.

- Status is communicated by **dots**, not chips or pills. A 1.5–2px dot in the right tone tells you what you need to know.
- "Running" is a **slow pulse**, not a spinner. Spinners are for loading states under three seconds.
- "Errored" is a clay-red dot, not a red banner across the screen. The signal should match the severity.
- Avoid bouncing or elastic animations. Real things decelerate smoothly; bouncy easing reads as toy-like.
- One well-timed entrance is worth more than fifteen scattered micro-interactions.

Time is everywhere in this app — relative ("2m ago"), tabular, monospace. Never lose track of *when* something happened.

## 7. Surfaces

Mcode has three primary surfaces visible at most times:

- **Sidebar** (left): the index of projects, branches, threads. The thing the user scans first.
- **Conversation** (center): the agent's stream — messages, tool calls, diffs inline. The thing the user reads.
- **Panel** (right): tasks, changes, terminal output — secondary inspection. The thing the user opens when they want to dig in.

Each of these is a floating card. They are siblings, not nested children. They never crowd each other — when the right panel would squeeze the conversation too narrow, it pops out as a modal overlay instead.

A composer sits at the bottom of the conversation. It is the user's only direct input — everything else is review. Treat it with care: it should feel like a place the user *wants* to type into. Not a form field, not a chat box, not a search bar. A drafting surface.

## 8. Interaction Principles

### Keyboard first

Every action has a keyboard path. Cmd+1 through Cmd+9 jump between threads. F2 renames in place. Cmd+K opens a command palette. Slash commands trigger from the composer. **Mouse interactions are a fallback**, not the design center.

If you design a feature, ask immediately: *what's the keyboard path?* If there isn't one, you haven't finished.

### Inline, then popover, then dialog

When something needs editing, it gets edited **in place**. A name, a tag, a setting — the surface it lives on becomes editable. Modals are last resort, reserved for destructive confirmations and irreversible decisions.

When you must show secondary controls, prefer popovers anchored to the trigger. Don't introduce a modal because it's easier to design.

### Recognition over recall

If a setting affects what the next action will do — what mode, what permission level, what branch — its **current value must be visible**, not hidden behind a click. The user should never have to open a menu to find out what state they're in.

### Recoverable everything

Esc closes the thing in front of you. It does not silently mutate state. Destructive actions show what will cascade ("This deletes 4 threads and 1 worktree"). Errors surface next to the thing that failed, not in a banner across the page.

## 9. Things That Are Banned

These are the patterns that make an interface look AI-generated. None of them are negotiable.

- **Side-stripe accents** — the colored bar on the left edge of a card or alert. Banned. Use a tinted background and a leading glyph instead.
- **Gradient text** — the rainbow-fill heading. Banned. Use weight and size for emphasis.
- **Dark mode with neon glow** — the cyan-on-black "techy" look. Banned. We are warm.
- **Glassmorphism everywhere** — frosted blurs as decoration. Reserved for overlay backdrops only.
- **Hero metric layouts** — big number, small label, gradient accent. Banned. We don't have a marketing surface.
- **Identical card grids** — the same card repeated four times in a 2x2. If it's the same card, it should be a row.
- **Sparklines as garnish** — tiny chart that conveys nothing. If a chart is decoration, delete it.
- **Wrapping everything in a card** — not all content needs a container. Tonal lift and indentation work.
- **Centered everything** — left-aligned with intentional asymmetry feels designed; centered everything feels templated.
- **Marketing fonts** — Inter, DM Sans, Space Grotesk, Plus Jakarta, Outfit, Fraunces, Newsreader, IBM Plex, Crimson, Lora, Playfair, Cormorant. All banned. Reach further. Find the font that feels like the museum caption, the mainframe console, the letterpress label.
- **Emojis as decoration** — never. Typographic glyphs only.
- **"Get started!" empty states** — no exclamation marks, no marketing copy.

## 10. Where to Be Creative

The spec above is the **floor**. It tells you what to avoid and what holds the system together. Above that floor, there is enormous room to design.

Things you should bring fresh thinking to:

- **The transitions between states.** What does it feel like when an agent finishes a long run? When a thread becomes active? When the user switches projects? These moments can have texture without breaking the quiet register.
- **The composer as a drafting surface.** Right now it is a text input with controls below. What else could it be? A drafting board with chips and tags? A surface that responds visually to mode changes?
- **The visualization of long agent runs.** A 200-message thread is hard to navigate. Could there be a vertical rail showing the shape of the conversation — tool calls vs replies, errors vs successes, time gaps?
- **The empty states.** Each one is an opportunity for typographic personality, as long as it stays inside the register (mono, small-caps, technical copy, low contrast).
- **The "what's running" overview.** A bird's-eye glance at every active agent across every project. Could be a single thin row at the top. Could be a compressed sidebar mode. Up to you.
- **Dead time.** What does the app look like when nothing is happening? Most apps don't think about this. Mcode should reward inactivity with calm.
- **The web-only context.** When Mcode runs in a browser away from the user's main machine, what changes? What's the experience of checking on agents from a phone or a borrowed laptop? The desktop is the primary canvas, but the web shouldn't feel like an afterthought.

## 11. The Test

Before shipping any design, hold it up against this question:

> *If someone said "AI made this", would I believe them immediately?*

If yes, you've defaulted to the templates. Throw it out.

If no — if they'd push back, if they'd ask "wait, who actually designed this?" — that's the work.
