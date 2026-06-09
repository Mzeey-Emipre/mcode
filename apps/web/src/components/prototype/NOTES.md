# Right-panel prototype — verdict

**Question:** what should the revamped right panel (ADR-0004) look and feel like —
empty-state presentation, tab navigation, the dynamic "+" menu, and the
coming-soon treatment.

## Chosen direction (a merge of two variants)

- **Tab navigation: the activity rail (variant C).** A vertical icon rail on the
  panel's edge. Singleton tabs as icons, active-tab indicator, **hover-revealed
  × on each icon to close**, "+" at the top of the rail (only when ≥1 tab is
  open), open-in / panel chrome at the bottom. The **Browser tab's rail glyph is
  the active page's favicon** (globe is the blank/new-tab fallback) — binds to
  the active preview tab's favicon in the real panel.
- **Empty state: the card grid (variant B).** When no tab is open the content
  area shows a 2-col grid of cards (icon + label + blurb + mcode keycap). The
  card grid is the create surface, so **there is no "+" in the empty state**.

Variant A (quiet list) was liked but the card grid won the empty state; variant
B's top pill tab-strip was dropped in favour of C's rail.

## Rules confirmed on the prototype

- Panel is **workspace-global** — renders with no thread (threadless scope shows
  Browser/Terminal/Files; a thread unlocks Review/Scope).
- Creatable set = **scope-filter then cardinality-filter**; "+" hides when nothing
  is openable and opens directly when exactly one type remains.
- **Files is a coming-soon teaser** — shown disabled with a "Soon" badge, excluded
  from the creatable count and from "+" actions (it is a deferred feature).
- **mcode keycaps** on every card/menu (Browser mod+shift+b, Terminal mod+j,
  Review mod+d, Scope mod+t), not Codex's bindings.

## Follow-ups (not decided here)

- The **open-in split button belongs in the chat header**, not the panel; it sits
  in the prototype's panel top-right only for demo convenience. The real home is
  the chat header (covered by the open-in issues #601-#603).
- Rail close could add **middle-click** and a **right-click "Close / Close others"**
  menu as complements to the hover-×.
- The card grid should **scroll** when a thread unlocks all five types.

## Browser view (`?prototype=browser`)

The Browser tab's content view, now that pages are not top-level panel tabs.

- **Clean URL header** — back/forward/reload + centered URL/title + an overflow
  kebab; the rarely-needed tools (Force reload, device toolbar, Zoom, Clear
  cookies, Clear cache) live in the kebab, out of view until summoned.
- **Header states** — *empty* ("Enter a URL"), *focused* (ringed pill + ↗),
  *loaded* (page title centered + a **design-mode icon** + a **screenshot icon**
  + kebab). *Hover* on a loaded bar reveals reload + the **open-in-external ↗**.
  Secondary tools live in the kebab — New page, Force reload, Dump page content,
  Region capture, Developer tools (Soon), Show device toolbar (Soon), Zoom, Clear
  cookies/cache — so the header stays minimal.
- **Empty state lists detected localhost ports** as cards (name, port, online
  dot). The sort/filter control (Recently used / Port; All / Online / Hidden) is
  a **future** addition — stubbed disabled.
- **Design mode** and **Screenshot** already exist and are **not changing** in
  this revamp — the prototype's design overlay is illustrative only. The work is
  to surface their existing entry points in the new clean header (a Design icon
  and a Screenshot icon), with behavior preserved. A future revamp of design
  mode itself is out of scope here.

### Multi-page = the right-panel rail (settled)
Multiple Browser pages live in the **right-panel activity rail**, not a top tab
strip. Each page is a favicon entry in the rail (consistent with the Browser rail
glyph = active page favicon); the rail **is** the page switcher. Concretely:
pages render as favicon entries grouped under the Browser tab in the rail, the
active page highlighted, each closeable via the rail's hover-×; when the last
page closes the Browser tab closes. "New page" (header / kebab) adds a rail entry.

### Browser-view open items
- The empty → focused **animation** is only suggested (ring/pill); needs a real
  morph transition.
- Where **Dump page content / Region capture / Screenshot** outputs land in the
  composer (the attach-to-chat flow).

## Cleanup

Throwaway. Fold the rail + card-grid empty state into the real panel
(`apps/web/src/components/panels/RightPanel.tsx`), then delete
`apps/web/src/components/prototype/` and the `?prototype=panel` short-circuit +
lazy import in `apps/web/src/app/App.tsx`.
