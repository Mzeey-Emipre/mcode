# Design Scale Audit

Audit date: July 7, 2026.

## Scope

This phase normalized the global design primitives, shared Button/Input/Badge scale, and obvious scale values in bounded shared UI surfaces. The audit covered every file under `apps/web/src`.

## Commands And Patterns

Counts came from `rg` over `apps/web/src`.

Copy-paste raw pixel count:

```powershell
rg -n -P "(?<![A-Za-z0-9_-])\d+(?:\.\d+)?px" apps/web/src | Measure-Object
```

Cross-shell raw pixel count:

```bash
rg -n -P "(?<![A-Za-z0-9_-])\d+(?:\.\d+)?px" apps/web/src | wc -l
```

Audit patterns:

- Raw px:

```regex
(?<![A-Za-z0-9_-])\d+(?:\.\d+)?px
```

- Arbitrary text:

```regex
text-\[[^\]]+\]
```

- Arbitrary spacing/sizing:

```regex
(?:h|w|min-h|min-w|max-h|max-w|size|p|px|py|pt|pr|pb|pl|m|mx|my|mt|mr|mb|ml|gap|space-x|space-y|top|right|bottom|left|inset|translate-x|translate-y)-\[[^\]]+\]
```

- Arbitrary radii:

```regex
rounded(?:-[trbl]{1,2})?-\[[^\]]+\]
```

- Raw colors:

```regex
(?:#[0-9a-fA-F]{3,8}|rgb\(|rgba\(|hsl\(|hsla\()
```

- Raw buttons:

```regex
<button(?:\s|>)
```

- Raw inputs:

```regex
<input(?:\s|>)
```

- Off-scale icons:

```regex
(?:size|h|w)-(?:2\.5|3|3\.5|4\.5|5|6|7|9|10|11|12)(?![\d.])
```

Also search for arbitrary icon pixel sizes with the raw px pattern.

## Counts

| Category | Before | After |
| --- | ---: | ---: |
| Raw px | 501 | 501 |
| Arbitrary text | 355 | 335 |
| Arbitrary spacing/sizing | 145 | 145 |
| Arbitrary radii | 26 | 20 |
| Raw colors | 136 | 130 |
| Raw buttons | 299 | 299 |
| Raw inputs | 30 | 32 |
| Off-scale icons | 0 | 0 |

The raw input count rose because focused component tests now render `Input` variants directly.

The raw-px count uses PCRE2 lookbehind through `rg -P`; the current documented count matches the PowerShell count command above.

## Files Normalized

- `apps/web/src/index.css`
- `apps/web/src/app/App.tsx`
- `apps/web/src/main.tsx`
- `apps/web/src/components/ui/button.tsx`
- `apps/web/src/components/ui/input.tsx`
- `apps/web/src/components/ui/badge.tsx`
- `apps/web/src/components/chat/ComposerQueueList.tsx`
- `apps/web/src/components/chat/MessageBubble.tsx`
- `apps/web/src/components/chat/PlanQuestionWizard.tsx`
- `apps/web/src/components/diff/CommitsView.tsx`
- `apps/web/src/components/diff/CumulativeView.tsx`
- `apps/web/src/components/diff/DiffContent.tsx`
- `apps/web/src/components/diff/DiffPreviewMarkdown.tsx`
- `apps/web/src/components/diff/GitDiffView.tsx`
- `apps/web/src/components/diff/LastTurnView.tsx`
- `apps/web/src/components/diff/SideBySideDiff.tsx`
- `apps/web/src/components/diff/SummaryView.tsx`
- `apps/web/src/components/diff/TurnTimeline.tsx`
- `apps/web/src/components/diff/UnifiedDiff.tsx`
- `apps/web/src/components/panels/plan/PlanDocument.tsx`
- `apps/web/src/components/sidebar/ProjectTree.tsx`

## Remaining Violations

### Raw Px

Count: 501.

Representative paths:

- `apps/web/src/index.css:180`
- `apps/web/src/index.css:337`
- `apps/web/src/index.css:618`
- `apps/web/src/main.tsx:30`
- `apps/web/src/components/panels/PreviewPanel.tsx:138`

Reason: hairline, optical sub-pixel, bitmap/canvas, generated preview geometry, or pending follow-up. `index.css` keeps pixel values for motion offsets, spinner masks, scrollbar/range-control micro-geometry, and focus rings. Preview/capture surfaces keep raw pixels where they model browser, canvas, screenshot, or DOM geometry. `main.tsx` keeps `1px` for the startup fallback border hairline.

### Arbitrary Text

Count: 335.

Representative paths:

- `apps/web/src/lib/ci-status.ts:40`
- `apps/web/src/components/diff/BranchRefPicker.tsx:156`
- `apps/web/src/components/chat/AttachmentPreview.tsx:147`
- `apps/web/src/components/diff/CommitEntry.tsx:82`
- `apps/web/src/components/panels/plan/PlanAnnotation.tsx:83`

Reason: pending follow-up. Many values are dense mono captions, tiny file badges, generated preview labels, or status-token color references. They need component-by-component review instead of a blind replacement.

### Arbitrary Spacing And Sizing

Count: 145.

Representative paths:

- `apps/web/src/components/palette/CommandPalette.tsx:63`
- `apps/web/src/components/panels/BrowserOverflowMenu.tsx:136`
- `apps/web/src/components/diff/DiffPreviewMarkdown.tsx:100`
- `apps/web/src/components/panels/plan/PlanSkeleton.tsx:13`
- `apps/web/src/components/diff/CommitEntry.tsx:82`

Reason: pending follow-up, generated preview geometry, or optical layout. Width clamps, character clamps, preview shadows, skeleton animation widths, and file-count pills need local visual review.

### Arbitrary Radii

Count: 20.

Representative paths:

- `apps/web/src/components/diff/CommitEntry.tsx:82`
- `apps/web/src/components/chat/Composer.tsx:351`
- `apps/web/src/components/chat/ImageAttachmentLightbox.tsx:250`
- `apps/web/src/components/ui/tooltip.tsx:72`
- `apps/web/src/components/sidebar/ThreadSearchBar.tsx:82`

Reason: optical sub-pixel fixes or pending follow-up. Tooltip arrows, favicon corners, and tiny file-count pills need local component treatment.

### Raw Colors

Count: 130.

Representative paths:

- `apps/web/src/index.css:199`
- `apps/web/src/index.css:339`
- `apps/web/src/components/chat/EditorIcons.tsx:28`
- `apps/web/src/components/chat/FileTagPopup.tsx:255`
- `apps/web/src/hooks/useDiffHighlighter.test.ts:49`

Reason: bitmap/icon assets, optical shadows, tests, or pending follow-up. Provider/editor logos keep source asset colors.

### Raw Buttons

Count: 299.

Representative paths:

- `apps/web/src/app/App.tsx:361`
- `apps/web/src/components/chat/AttachmentPreview.tsx:168`
- `apps/web/src/components/chat/BranchPicker.tsx:123`
- `apps/web/src/components/chat/ChatView.tsx:75`
- `apps/web/src/components/chat/tool-renderers/ToolCallWrapper.tsx:64`

Reason: pending follow-up. Some raw buttons are semantic wrappers inside interactive rows where changing to the shared Button would alter nesting or event behavior.

### Raw Inputs

Count: 32.

Representative paths:

- `apps/web/src/components/ui/input.tsx:36`
- `apps/web/src/components/sidebar/ThreadSearchBar.tsx:75`
- `apps/web/src/components/settings/RangeControl.tsx:47`
- `apps/web/src/components/chat/Composer.tsx:2947`
- `apps/web/src/components/panels/BrowserHeader.tsx:248`

Reason: component primitive internals, range controls, composer internals, and pending follow-up.

## Exceptions

- Hairline: 1px borders and focus outlines remain where they are tokenized through Tailwind or CSS variables.
- Bitmap/canvas: editor icons, favicons, provider artwork, image preview dimensions, and generated preview geometry keep source-specific values.
- Optical sub-pixel: tooltip arrow corners, favicon micro-radii, spinner masks, scrollbars, and timeline cursor offsets keep small pixel values.
- Generated preview geometry: preview panel capture, annotation, and embedded browser geometry remain audited for later phase work.
- Pending follow-up: raw buttons and raw inputs in behavior-sensitive rows remain counted until each component can be replaced with shared primitives without changing semantics.

## Impeccable Polish Findings

Attempted tools:

- `node .agents/skills/impeccable/scripts/context.mjs --target apps/web/src/index.css` failed because `.agents/skills/impeccable/scripts/context.mjs` is not present in this checkout.
- `node C:\Users\chukwudi.nwobodo\.codex\skills\impeccable\scripts\context.mjs --target apps/web/src/index.css` succeeded and loaded the product register plus `DESIGN.md`.
- `node C:\Users\chukwudi.nwobodo\.codex\skills\impeccable\scripts\detect.mjs --json apps/web/src/index.css apps/web/src/components/ui/button.tsx apps/web/src/components/ui/input.tsx apps/web/src/components/ui/badge.tsx apps/web/src/app/App.tsx apps/web/src/main.tsx` ran and returned advisory findings.

Findings:

- `apps/web/src/index.css:339`: spinner uses `border-radius: 9999px`. Kept as optical circular geometry.
- `apps/web/src/index.css:625`, `632`, `635`, `708`, `715`: scrollbar colors are outside `DESIGN.md`. Kept as existing scrollbar optical treatment for this phase.
- `apps/web/src/index.css:626`, `645`, `651`, `681`, `709`: scrollbar and range control radii use `2px` or `3px`. Kept as optical sub-pixel controls.
- Manual polish check from `polish.md` and `product.md`: screenshots show the shell remains dense and calm, amber remains limited to project state and the primary landing action, and the 390px view no longer clips the landing content after scoping the composer minimum width to non-landing surfaces.

Screenshot evidence:

- `apps/web/e2e/screenshots/design-scale-live-1440x900.png`
- `apps/web/e2e/screenshots/design-scale-live-900x700.png`
- `apps/web/e2e/screenshots/design-scale-live-390x844.png`

## Next Phases

1. Normalize dense diff controls: `apps/web/src/components/diff/**`, including branch and commit pickers.
2. Normalize sidebar rows and filters: `apps/web/src/components/sidebar/**`.
3. Normalize chat tool renderers and narrative rows: `apps/web/src/components/chat/tool-renderers/**` and `apps/web/src/components/chat/narrative/**`.
4. Normalize preview and browser geometry: `apps/web/src/components/panels/PreviewPanel.tsx`, `BrowserHeader.tsx`, and preview annotation components.
5. Replace raw buttons and inputs in behavior-sensitive rows with shared primitives after local interaction tests are written.
