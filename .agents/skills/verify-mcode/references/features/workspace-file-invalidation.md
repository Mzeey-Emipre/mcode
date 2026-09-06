# Local workspace file invalidation

## Sub-features

- Files, selected Review file content, and `@` file autocomplete refresh after an external local change.
- Review compares the live filesystem again. Last turn remains the recorded agent comparison, so an external edit never gains agent attribution.
- An open Mcode Browser preview on a local loopback address reloads. Remote pages do not reload.
- The server accepts only paths whose canonical existing path, or nearest existing canonical ancestor for a deletion, remains within the resolved workspace or worktree root.
- One WebSocket connection owns one watch per resolved workspace scope. It receives debounced paths, or one whole-workspace invalidation after more than 100 paths. Disconnect closes its watches, and reconnect subscribes again.

## How to get to it (user or client POV)

1. Register `.dev/fixture-repo` as an Mcode workspace and open its Files, Review, `@` autocomplete, and local loopback Preview surfaces.
2. Select one text file in Files and Review. Capture the file content, autocomplete choice, Preview, and both Review comparison modes.
3. Edit that fixture file outside Mcode, inspect the disk content, and wait for the stable refresh on every surface.
4. Rename or delete the file and confirm the Files catalog and live Review comparison refresh while Last turn retains its agent-attributed content.

## Driving it with Mcode Browser

- Run `runtime health`, then register the fixture workspace and use the public Mcode Browser Preview control. Do not use a generic browser automation tool for this shared Preview surface.
- Capture Files, selected Review content, `@` autocomplete, Mcode Browser Preview, and Review before and after one external fixture edit. Save screenshots and redacted receipts under `.dev/verification`.
- Create more than 100 temporary files in `.dev/fixture-repo` within one debounce window. Confirm one whole-workspace refresh, then remove only those owned files.
- Close the client WebSocket through the public client lifecycle, then make another fixture edit. Confirm no refresh reaches the closed client. Reconnect and confirm a new subscription refreshes the active client.

## Gotchas

- Keep every edit in `.dev/fixture-repo`. Inspect the disk content after each external edit.
- Outside-root injection needs a public control that supplies a watcher path. When that control is absent, record the gap. Focused server tests cover canonical containment, including symlink escapes and deletion races.
- A missing registered fixture workspace or Mcode Browser host blocks the visual journey. Record the exact blocker. Focused tests do not replace the rendered proof.
- Do not treat live filesystem changes as agent changes. Last turn is historical agent evidence; live Review is the filesystem comparison.
