# Mcode design system benchmark

Research date: 2026-07-22
Scope: identify high-value patterns for expanding Mcode's DESIGN.md toward the
Codex app's interaction style while keeping Mcode's warm amber and cool-slate
identity. This note is research input, not a replacement for DESIGN.md.

## Executive summary

Mcode already has a strong visual point of view: dark-primary cool slates,
Filament Amber as a scarce signal, glance-first status dots, tonal layering,
keyboard-first interaction, and a four-point rhythm ([DESIGN.md](../../DESIGN.md),
[PRODUCT.md](../../PRODUCT.md)). Its main gap is not a color palette. It is
coverage and explicitness: iconography, layout contracts, motion/state rules,
component anatomy, voice, accessibility, and review-loop behavior are spread
across prose or absent from the machine-readable frontmatter.

The Codex reference suggests a useful product posture: projects and threads as
the organizing model, isolated worktrees, visible progress, and a review pane
that keeps changed files and line-level feedback close to the run. Mcode should
adopt those interaction patterns as behavior, not copy Codex's visual tokens.
Phosphor is a suitable icon source because its official React package supports
tree-shakable individual imports, configurable weights, and an MIT license.

## Evidence from Mcode's current docs

### Observed

- `PRODUCT.md` defines Mcode as an orchestration surface for many concurrent
  coding agents. Its wedge is a first-class run object with branch, worktree,
  transcript, diff, status, and glanceable sidebar metadata.
- `PRODUCT.md` names Codex as a reference for calm run legibility and refusal to
  decorate, while explicitly diverging toward many-run scanning.
- `DESIGN.md` already defines color tokens, typography, elevation, buttons,
  fields, panels, sidebar/status dots, empty states, next-step slots,
  responsive posture, anti-patterns, and reduced-motion requirements.
- `docs/guides/ui-components.md` requires shared shadcn primitives, documents
  icon-button sizes, and requires live checks for interactive, responsive,
  accessibility, theme, overlay, and persisted-state changes.

### Inference

The next revision should preserve the current token values and brand rules, then
make the behavioral system easier for agents to apply. A long prose document
without explicit state tables or icon rules still leaves an agent to guess at
the most visible details.

## DESIGN.md format benchmark: VoltAgent examples

The linked repository is a useful schema benchmark, but its files are analyses
and inspirations, not official brand specifications. The Claude file is
available directly as Markdown; Cursor, Linear, and Raycast currently point to
their maintained `getdesign.md` pages.

### Claude

Observed in the [Claude DESIGN.md](https://raw.githubusercontent.com/VoltAgent/awesome-design-md/main/design-md/claude/DESIGN.md):

- YAML frontmatter names tokens for colors, typography, radii, spacing, and a
  component inventory before prose begins.
- The document states a clear visual thesis, then gives colors, typography,
  layout, elevation, shapes, components, responsive behavior, do/don't rules,
  iteration guidance, and known gaps.
- The analysis uses an explicit surface rhythm: tinted canvas, lighter cards,
  and dark product/code surfaces. It also records a 4px spacing unit, radius
  hierarchy, restrained shadows, and concrete component dimensions.
- Components are named and parameterized (`button-primary`, `code-window-card`,
  `text-input-focused`, tabs, badges, CTA bands), which makes the document
  actionable for an implementation agent.

### Cursor, Linear, and Raycast

Observed in the repository's [Cursor](https://github.com/VoltAgent/awesome-design-md/tree/main/design-md/cursor),
[Linear](https://github.com/VoltAgent/awesome-design-md/tree/main/design-md/linear.app),
and [Raycast](https://github.com/VoltAgent/awesome-design-md/tree/main/design-md/raycast)
directories: each directory contains a DESIGN.md pointer and identifies the
full analysis as maintained on `getdesign.md`. The maintained pages describe
Cursor as an AI-first dark editor with gradient accents, Linear as ultra-minimal
and precise with a purple accent, and Raycast as dark launcher chrome with
vibrant gradients ([Cursor](https://getdesign.md/cursor/design-md),
[Linear](https://getdesign.md/linear.app/design-md),
[Raycast](https://getdesign.md/raycast/design-md)). These are useful contrasts
for deciding what Mcode should *not* copy: neon gradients and broad marketing
surfaces conflict with Mcode's quiet, instrument-grade register.

### Format takeaway

The common pattern is a compact token header followed by a fixed, scannable
section set. For Mcode, the missing high-leverage sections are Iconography,
Layout contracts, Motion and state transitions, Component anatomy/state tables,
Voice and content, Accessibility, Responsive posture, and Known gaps.

## Codex interaction benchmark

The sources below are first-party OpenAI product or documentation pages.

### Observed

- The Codex app is framed as a command center where multiple agents run in
  separate threads organized by projects. Each run can use an isolated
  worktree, and the user can inspect changes in the thread, comment on diffs,
  open an editor, or continue without changing local Git state ([Introducing
  the Codex app](https://openai.com/index/introducing-the-codex-app/)).
- The Codex product page presents progress details beside changed-file review,
  a multi-agent workspace, connected context/output panels, an automation
  inbox, and review/quality surfaces ([Codex product page](https://openai.com/codex/)).
- Codex documentation describes Local, Worktree, and Cloud as explicit
  execution modes in the composer, with worktree handoff between local and
  isolated contexts ([environments and modes](https://developers.openai.com/codex/environments/modes),
  [Git worktrees](https://developers.openai.com/codex/environments/git-worktrees)).
- Long-running work exposes a goal/outcome and definition of done, a progress
  row above the composer, pause/resume/edit/clear controls, and continuation in
  the same chat for context ([long-running work](https://developers.openai.com/codex/long-running-work)).
- Code review keeps changed files, line-specific feedback, and actions such as
  stage, revert, commit, and push in one review pane; `/review` scopes a review
  without changing the working tree ([code review](https://developers.openai.com/codex/code-review)).
- OpenAI's desktop release notes describe a global ChatGPT/Codex switcher,
  Chat/Work posture, unified Recents filtering and pinning, inline diff edits,
  pull-request review side panels, and multi-repository projects ([release
  notes](https://help.openai.com/en/articles/6825453-chatgpt-release-notes)).

### Inference for Mcode

Codex's strongest transferable pattern is adjacency: run progress, context,
and review stay next to the thread instead of becoming separate destinations.
For Mcode this means the conversation remains primary, while the sidebar and
right panel keep project/worktree/status and changed-file review persistently
available. Mcode's existing next-step slot is a good place to encode the
curated follow-up action, while a progress row and review pane should expose
the same run state without adding dashboard chrome.

## User-supplied Codex desktop screenshots

Four full-window screenshots supplied on 2026-07-22 provide direct visual
evidence from the installed Codex/ChatGPT desktop app. They show an active
thread with review and environment surfaces, the composer command menu, the
Scheduled tasks page, and General settings.

### Observed

- The app uses a fixed left rail for global destinations, project groups, and
  compact thread rows. Selected navigation uses a low-contrast full-row fill.
  Strong color is absent from ordinary selection.
- The thread is a bounded reading column inside a wide work area. Assistant
  prose sits directly on the canvas; the user prompt uses a restrained tonal
  block aligned right.
- The composer matches the reading column and forms the strongest persistent
  contained surface. Its command menu opens immediately above it at the same
  width, with compact rows, left icons and labels, and right-aligned
  descriptions or values.
- A narrow floating environment inspector groups Changes, Worktree, Git
  actions, sub-agents, background processes, and sources with hairline
  separators. A review workspace can occupy a docked sibling region.
- Scheduled tasks uses a narrow centered column, a full-width search field,
  quiet segmented filters, flat rows, and sparse semantic color on suggestion
  icons. The unused canvas remains empty.
- General settings uses a fixed secondary navigation rail and a centered form
  column. Group labels sit outside tonal cards. Each card uses compact rows,
  left-aligned label and description, a stable right-aligned control, and
  hairline row separators.

### Inference for Mcode

Mcode should separate selection, focus, and activity more explicitly. Neutral
slate fill should identify the selected row, Cool Ring should identify keyboard
focus, and Filament Amber should identify a primary action or live work. The
screenshots also support a shared bounded rail for conversation, composer,
settings, and utility pages, plus an inspector that floats before it becomes a
docked sibling workspace.

## Phosphor icon benchmark

### Observed

- Phosphor describes a flexible icon family for interfaces, diagrams, and
  presentations and publishes open-source packages. The official React README
  documents per-icon imports, tree-shaking, `size`, `color`, and weight values
  (`thin`, `light`, `regular`, `bold`, `fill`, `duotone`) plus a context provider
  for defaults ([official React package](https://github.com/phosphor-icons/react)).
- The same README warns that importing the main package can transpile more than
  9,000 modules during development and recommends per-icon paths when needed.
- Phosphor's web package is MIT licensed. Its license requires retaining the
  copyright and permission notice in copies or substantial portions
  ([web license](https://github.com/phosphor-icons/web/blob/master/LICENSE)).

### Inference and proposed Mcode policy

Add an Iconography section to DESIGN.md with a small semantic mapping and a
single default treatment:

| Use | Proposed rule |
| --- | --- |
| Navigation and object identity | Phosphor React, `regular`, 16px or 20px, `currentColor` |
| Dense toolbar actions | `regular`, 16px, existing `Button` icon sizes |
| Status and semantic state | Keep the existing dot as the primary signal; use a Phosphor glyph only when shape adds meaning |
| Selected/active emphasis | Use `bold` or `fill` only for the selected object, never as decoration |
| Two-tone illustration | Reserve `duotone` for explanatory empty states or diagrams |

Require semantic names, `aria-hidden` for decorative icons, visible labels or
tooltips for icon-only actions, and no emoji or ad hoc SVG replacements. In
implementation, prefer named imports such as `import { GitBranchIcon } from
"@phosphor-icons/react"`; use per-icon paths only if dev transpilation becomes
a measured bottleneck. Preserve the MIT notice if icon source files are copied.

## Recommended DESIGN.md revision

1. Keep the current Mcode YAML tokens and brand rules. Add explicit tokens for
   `icon-size-*`, `motion-duration-*`, `motion-ease-*`, `focus-ring`, and the
   surface/semantic contrast pairs already implied by the prose.
2. Add a **Layout and responsive contracts** section: pane roles, min usable
   widths, docking/floating thresholds, resize behavior, and the state/actions
   that must survive each posture.
3. Add a **Run and review loop** section modeled on Codex's progress, worktree,
   goal, and changed-file adjacency. Define the anatomy and states of a thread
   row, progress row, narrative event, diff hunk, review comment, and next-step
   slot.
4. Add a **Component state matrix** for every shared primitive: default,
   hover, pressed, focus-visible, disabled, loading, error, selected, and
   reduced-motion behavior. Link each primitive to
   `docs/guides/ui-components.md`.
5. Add **Iconography** using the Phosphor policy above, including optical sizes,
   semantic mappings, accessibility, and import guidance.
6. Add **Motion, accessibility, and content voice** as explicit sections. Keep
   Mcode's quiet pulse, reduced-motion requirement, WCAG target, keyboard-first
   behavior, and technical copy in one place rather than relying on scattered
   notes.
7. Add **Known gaps and decision log**. Record unresolved questions such as
   light-theme parity, icon exceptions, and exact responsive thresholds so
   agents do not invent answers during implementation.

## Source list

- [Mcode PRODUCT.md](../../PRODUCT.md)
- [Mcode DESIGN.md](../../DESIGN.md)
- [Mcode UI component guide](../guides/ui-components.md)
- [VoltAgent awesome-design-md directory](https://github.com/VoltAgent/awesome-design-md/tree/main/design-md)
- [Claude DESIGN.md](https://raw.githubusercontent.com/VoltAgent/awesome-design-md/main/design-md/claude/DESIGN.md)
- [Cursor analysis](https://getdesign.md/cursor/design-md)
- [Linear analysis](https://getdesign.md/linear.app/design-md)
- [Raycast analysis](https://getdesign.md/raycast/design-md)
- [Anthropic Claude](https://www.anthropic.com/claude)
- [Cursor product](https://cursor.com/product)
- [Cursor agent overview](https://docs.cursor.com/en/agent/overview)
- [Linear design refresh](https://linear.app/now/behind-the-latest-design-refresh)
- [Linear UI redesign](https://linear.app/now/how-we-redesigned-the-linear-ui)
- [Raycast extension UI](https://developers.raycast.com/api-reference/user-interface)
- [Raycast keyboard shortcuts](https://manual.raycast.com/keyboard-shortcuts)
- [OpenAI: Introducing the Codex app](https://openai.com/index/introducing-the-codex-app/)
- [OpenAI Codex product](https://openai.com/codex/)
- [Codex projects](https://developers.openai.com/codex/projects)
- [Codex long-running work](https://developers.openai.com/codex/long-running-work)
- [Codex Git worktrees](https://developers.openai.com/codex/environments/git-worktrees)
- [Codex code review](https://developers.openai.com/codex/code-review)
- [OpenAI desktop release notes](https://help.openai.com/en/articles/6825453-chatgpt-release-notes)
- [Phosphor React package](https://github.com/phosphor-icons/react)
- [Phosphor Core](https://github.com/phosphor-icons/core)
- [Phosphor web license](https://github.com/phosphor-icons/web/blob/master/LICENSE)

## Source quality note

OpenAI and Phosphor links are first-party sources. VoltAgent's Claude file is
an open repository analysis, and the Cursor, Linear, and Raycast pages state
that they are independent analyses of publicly observable patterns. Treat
those design details as inspiration and schema evidence, not as official brand
rules.

## Post-revision benchmark

This comparison measures what the cited artifacts document, not the quality of
the products. `Explicit` means the source defines an implementation rule or
schema. `Partial` means it covers part of the criterion. `Observed` means the
evidence comes from product material or screenshots rather than a published
design contract. `Not evidenced` means the cited sources do not support a
claim. `Not publicly specified` means the cited official sources publish no
comparable contract. `Out of scope` means the artifact serves a narrower
purpose.

Visual details for Claude, Cursor, Linear, and Raycast come from independent
VoltAgent/getdesign.md analyses, not official specifications. Their first-party
product, design, or developer pages support only the product and component
claims named below. Codex evidence comes from first-party product pages and
documentation plus the user-supplied screenshots described above. Phosphor
evidence comes from its official React package and license.

| Criterion | Mcode after revision | Claude | Cursor | Linear | Raycast | Codex composition reference | Phosphor |
|---|---|---|---|---|---|---|---|
| Token/schema completeness | **Explicit:** frontmatter covers color, type, radius, spacing, icons, motion, layout, layers, and five component recipes; most component detail remains in prose. | **Explicit in the independent analysis:** color, type, radius, spacing, and component tokens. Anthropic publishes no comparable specification in the cited official source. | **Independent analysis only:** official sources publish product behavior, not a token schema. | **Partial official evidence:** Linear explains theme generation and contrast control, but does not publish a complete token schema. | **Independent analysis only:** the official extension API defines components, not brand tokens. | **Not evidenced:** the official sources show product composition, not a reusable token schema. | **Out of scope:** an icon API and asset family, not a complete product token schema. |
| Brand specificity | **Explicit:** Quiet Workbench, Filament Amber, cool slate, glance-first status, and technical voice form a product-specific system. | **Explicit in the independent analysis:** a visual thesis and named surface rhythm. Treat it as analysis, not Anthropic policy. | **Observed by independent analysis:** dark AI-editor identity and gradient accents; official sources establish the agent-editor product posture, not those visual rules. | **Explicit official rationale:** Linear describes calmer hierarchy, dense information, quieter navigation, and softer boundaries; exact visual rules in the independent analysis remain unofficial. | **Observed by independent analysis:** dark launcher identity and vibrant gradients; official sources establish its keyboard-first launcher posture. | **Observed:** calm, content-first agent work and adjacent review inform composition, not Mcode's visual identity. | **Explicit within iconography:** a coherent icon language with multiple weights; product brand decisions remain outside its scope. |
| Component/state coverage | **Explicit:** component anatomy, canonical compositions, loading and failure journeys, and a shared eight-state matrix. Per-component exhaustive tables remain a gap. | **Partial in the independent analysis:** named component recipes are actionable, but the cited evidence does not establish comparable state coverage. | **Partial official evidence:** agent, terminal, apply-change, and diff-review workflows expose product states without defining a general UI component contract. | **Not evidenced as a general contract:** the official design posts explain hierarchy, not exhaustive component states. | **Explicit for extensions:** the official API constrains extensions to List, Grid, Detail, Form, and ActionPanel and exposes loading and shortcut behavior; this is not a whole-product state matrix. | **Observed:** composer modes, progress, review, changed files, and worktree actions demonstrate key product states without defining a general component contract. | **Partial:** icon props, weights, defaults, and mirroring cover icon variants, not application component states. |
| Responsive/layout contract | **Explicit:** pane roles, persisted widths, minimum usable widths, layer order, and wide, constrained, and narrow postures define behavior during resize. | **Partial in the independent analysis:** layout and responsive behavior are discussed, but the cited evidence does not establish Mcode-level pane contracts. | **Not publicly specified:** official sources show editor and side-pane workflows without publishing responsive contracts. | **Not publicly specified:** official design posts explain hierarchy without publishing a responsive contract. | **Not publicly specified:** the extension API constrains surfaces but does not publish a whole-product responsive contract. | **Observed, not specified:** screenshots show rails, bounded reading columns, floating inspectors, and docked review; official sources do not publish breakpoint or persistence rules. | **Out of scope.** |
| Accessibility | **Explicit:** WCAG 2.1 AA targets, contrast thresholds, keyboard paths, focus, target sizes, live regions, zoom, labels, and non-color status cues. | **Not publicly specified by the cited official source.** | **Not publicly specified by the cited official sources.** | **Partial official evidence:** Linear discusses contrast control, but not a complete accessibility contract. | **Partial official evidence:** keyboard navigation and shortcuts are documented, but no full WCAG contract is cited. | **Not publicly specified by the cited product sources.** | **Partial:** the React API supports accessible labeling and mirroring; consuming products still own focus, target size, contrast, and state semantics. |
| Motion | **Explicit:** named durations and easings, product motion patterns, stable streaming behavior, and reduced-motion replacements. | **Not publicly specified by the cited official source.** | **Not publicly specified by the cited official sources.** | **Not publicly specified by the cited official sources.** | **Not publicly specified by the cited official sources.** | **Not publicly specified by the cited product sources.** | **Out of scope.** |
| Implementation readiness | **Design-ready with recorded gaps:** routine UI decisions are specified, but most component rules remain prose and Phosphor installation, token migration, and measured posture validation remain implementation work. | **Partial:** the independent analysis offers concrete recipes, but it is neither an official contract nor tailored to Mcode's runtime. | **Reference only:** official workflow evidence and independent visual analysis do not form an Mcode implementation contract. | **Reference only:** official rationale and independent visual analysis do not form an Mcode implementation contract. | **Ready for Raycast extensions, reference-only for Mcode:** the official API is executable within Raycast's constrained extension surface. | **Reference only:** strong evidence for interaction adjacency and composition, but no portable implementation specification. | **Ready for the icon layer:** official package APIs and licensing are clear; Mcode still needs the planned dependency, notice review, alias map, and region-by-region migration. |

### Post-revision finding

The revision closes the benchmark's main documentation gaps. Mcode documents
more implementation categories in one place than the cited public comparison
artifacts: product-specific visual rules, component states, responsive
behavior, accessibility, motion, and known migration gaps. Machine-readable
coverage still stops at five component recipes, and live implementation still
lags parts of the contract. This conclusion measures published coverage, not a
numeric design ranking. Claude, Cursor, Linear, and Raycast visual details
remain independent comparative analyses; Codex remains a first-party
interaction and composition reference; Phosphor remains the first-party source
for the icon layer.
