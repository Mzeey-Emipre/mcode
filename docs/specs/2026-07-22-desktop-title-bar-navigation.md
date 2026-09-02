# Desktop Title Bar and Navigation History

**Date:** 2026-07-22
**Status:** Specification
**Related glossary:** [Mcode context](../../CONTEXT.md)

## Problem Statement

Mcode's Electron window uses the operating system's standard frame while the
project sidebar repeats the Mcode identity in its own 44px header. This splits
window controls, navigation, menus, and app identity across two rows. When the
sidebar collapses, individual content surfaces also render their own reveal
controls.

The desktop app needs one compact title bar that owns persistent window and
navigation controls. It must preserve native desktop behavior, remove redundant
sidebar chrome, and give Back and Forward stable Mcode semantics without
conflicting with Preview page navigation.

## Solution

Add a 40px custom Electron title bar. It displays the Mcode mark, the single
desktop sidebar toggle, Mcode Back and Forward controls, application menus, and
native window controls. Windows and Linux render File, Edit, View, and Help in
the title bar. macOS keeps those menus in the system menu bar and preserves
native traffic lights.

Desktop navigation uses an in-memory location stack. Locations include threads,
the New thread canvas, Settings sections, the pull request inbox, selected pull
requests, and their Summary, Timeline, and Code tabs. Preview retains its own
page-navigation controls. The title-bar arrows always navigate Mcode locations.

The web app keeps its current shell, sidebar header, reveal controls, and
navigation behavior.

## User Stories

1. As a desktop user, I want app identity and persistent controls in one title
   bar, so that the workspace has less duplicate chrome.
2. As a desktop user, I want one sidebar toggle that remains available across
   every surface, so that I always know where to find it.
3. As a keyboard user, I want the existing sidebar shortcut to keep working.
4. As a desktop user, I want Back and Forward to revisit the Mcode locations I
   used, so that switching threads and major surfaces does not require retracing
   the sidebar.
5. As a pull request reviewer, I want history to restore the selected pull
   request and detail tab, so that navigation returns me to the same review
   context.
6. As a Preview user, I want app history and page history to remain separate,
   so that the title-bar arrows never change the inspected page unexpectedly.
7. As a Windows or Linux user, I want familiar application menus and mnemonic
   access from the title bar.
8. As a macOS user, I want native traffic lights and system menus preserved.
9. As a user resizing the window, I want navigation and window controls to stay
   visible when menu labels no longer fit.

## Design Decisions

- The title bar is 40px high. The Mcode mark is 24px, icon controls are 32px,
  control spacing follows the four-point system, and groups use 8px separation.
- The title bar uses the existing page and border tokens. A quiet bottom
  hairline separates it from the workspace. It has no centered window title and
  no decorative motion.
- The Mcode mark is a non-interactive identity element.
- The title bar is the only desktop sidebar control. Desktop sidebar branding,
  collapse controls, and content-level reveal controls are suppressed. Web
  controls remain unchanged.
- The existing sidebar keyboard command remains the authority for toggling the
  sidebar. The title-bar button invokes the same command behavior.
- macOS reserves space for native traffic lights. It does not duplicate File,
  Edit, View, and Help inside the window.
- Windows and Linux menus support `Alt+F`, `Alt+E`, `Alt+V`, and `Alt+H`, followed
  by arrow-key navigation.
- File contains focused project, thread, close-window, and quit actions. Edit
  contains standard undo, redo, clipboard, and selection roles. View contains
  Mcode navigation, panel actions, zoom, full screen, reload, and development
  tools. Help contains keyboard shortcuts and About.
- When horizontal space cannot hold the menu labels, one neutral application
  menu button preserves File, Edit, View, and Help as grouped submenus. The
  Mcode mark, sidebar toggle, Back, Forward, and native window controls remain
  visible.

## Navigation Decisions

- History belongs to the current Electron window and starts fresh after an app
  restart.
- A location records the active project and one destination: New thread, thread,
  Settings section, pull request inbox, or pull request detail tab.
- Selecting the current location again does not add a duplicate entry.
- A new direct navigation after going Back clears the Forward stack.
- Back and Forward replay a location without adding another history entry.
- Deleted or otherwise invalid destinations are skipped. When no valid prior
  entry exists, the control is disabled.
- Settings Back and narrow pull request detail Back use the same history stack.
  If no valid prior location exists, they return to the appropriate parent
  surface.
- `Alt+Left` and `Alt+Right` navigate on Windows and Linux. `Cmd+[` and `Cmd+]`
  navigate on macOS. Matching menu items expose the same actions.
- Title-bar navigation retains Mcode semantics while Preview has focus. Preview
  continues to expose its own page Back and Forward controls.

## Acceptance Criteria

1. The Electron desktop window renders the custom 40px title bar with the
   platform-specific controls and menu behavior described above.
2. Native resizing, minimizing, maximizing, snapping, closing, and dragging
   continue to work.
3. Desktop surfaces expose one sidebar toggle in the title bar, and the existing
   sidebar shortcut still toggles the same state.
4. Desktop sidebars omit the Mcode logo row but retain contextual Settings
   navigation. The web sidebar remains unchanged.
5. Back and Forward restore every specified Mcode location, including Settings
   sections and pull request detail tabs.
6. Direct navigation after Back clears Forward history, duplicate locations are
   coalesced, and unavailable destinations are skipped safely.
7. Header navigation never consumes Preview page history.
8. Windows and Linux menu labels support mouse, keyboard, and mnemonic access.
9. macOS preserves native traffic lights and uses the system menu bar.
10. Narrow desktop windows retain identity, sidebar, navigation, and window
    controls while exposing all menus through one grouped application menu.
11. All title-bar controls have accessible names, visible keyboard focus, and
    disabled states that match their availability.

## Testing Decisions

- Store tests cover initial state, Back, Forward, duplicate coalescing, Forward
  clearing, invalid-location skipping, and the bounded session-only stack.
- App integration tests cover thread, New thread, Settings section, pull request
  inbox, selected pull request, and pull request tab restoration.
- Component tests cover desktop-only title-bar rendering, web-only sidebar
  branding and reveal controls, accessible control states, and compact menu
  behavior.
- Desktop main-process tests cover platform-specific BrowserWindow title-bar
  options and native menu behavior.
- Live Electron verification exercises dragging, resize and window controls,
  sidebar toggling by button and shortcut, Back and Forward by button and
  shortcut, menu mouse and keyboard access, compact-menu behavior, Settings
  return, pull request restoration, and separation from Preview history.
- Visual verification covers wide and narrow windows in both themes, with no
  clipped controls or console errors.
- The final regression floor includes focused tests, typecheck, and lint.

## Out of Scope

- Persisting navigation history across app restarts.
- Adding browser-style address routing to the web app.
- Folding Preview page history into Mcode location history.
- Adding a centered project or thread title to the desktop title bar.
- Redesigning content headers beyond suppressing duplicate desktop sidebar
  controls.
- Expanding the compact application menu beyond the four agreed menu groups.
