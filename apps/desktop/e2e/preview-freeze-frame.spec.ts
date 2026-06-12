/**
 * Freeze-frame regression spec for overlay suppression over the embedded
 * browser (WebContentsView).
 *
 * The native view composites above all HTML, so any renderer overlay
 * (dropdown, dialog) forces the view to detach while it is open. The
 * freeze-frame keeps a JPEG snapshot of the page in the view's place so the
 * surface never blanks. This spec loads a local page, opens the browser
 * header overflow menu (a suppressor), and asserts the snapshot stands in,
 * matches the surface bounds, and clears once the menu closes.
 *
 * Requires `apps/desktop/dist/main/main.cjs`; build with
 * `cd apps/desktop && bun run build` first (same as electron-smoke.spec.ts).
 */
import { test, expect, _electron as electron } from "@playwright/test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// import.meta-based dirname: this package is ESM, so specs transpile without
// a CommonJS __dirname.
const DESKTOP_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const MAIN_BUNDLE = join(DESKTOP_DIR, "dist", "main", "main.cjs");

/** Demo page with unmistakable content so a blank capture cannot pass. */
const PAGE_HTML = `<!doctype html><html><head><title>Freeze Frame Demo</title></head>
<body style="margin:0;height:100vh;display:grid;place-items:center;background:linear-gradient(135deg,#5b21b6,#0ea5e9);color:#fff;font:700 42px system-ui">
LIVE PAGE CONTENT</body></html>`;

test.describe("preview freeze-frame", () => {
  test.beforeAll(() => {
    if (!existsSync(MAIN_BUNDLE)) {
      throw new Error(
        `Missing ${MAIN_BUNDLE}. Run \`cd apps/desktop && bun run build\` first.`,
      );
    }
  });

  test("overflow menu floats over a frozen page instead of a blank hole", async () => {
    const pagePath = join(mkdtempSync(join(tmpdir(), "mcode-ff-")), "demo.html");
    writeFileSync(pagePath, PAGE_HTML);

    // Agent harnesses set ELECTRON_RUN_AS_NODE=1, which would make Electron
    // boot as plain Node and never open a window. Strip it for the launch.
    const env = { ...process.env } as Record<string, string>;
    delete env.ELECTRON_RUN_AS_NODE;

    const app = await electron.launch({
      args: ["."],
      cwd: DESKTOP_DIR,
      env,
      timeout: 120_000,
    });
    try {
      const win = await app.firstWindow({ timeout: 120_000 });
      await win.waitForLoadState("domcontentloaded");
      // Transport connected and sidebar shell rendered.
      await win
        .getByPlaceholder("Search threads...")
        .waitFor({ state: "visible", timeout: 120_000 });
      await win.waitForTimeout(1_000);

      // Open a thread when one exists: the browser panel mounts inside a
      // thread/workspace scope, so a bare home screen cannot host it.
      const threadItem = win.locator('[data-testid="thread-item"]').first();
      const recentRow = win.locator('[data-testid="recent-thread-row"]').first();
      if (await threadItem.isVisible().catch(() => false)) {
        await threadItem.click({ timeout: 10_000 }).catch(() => {});
      } else if (await recentRow.isVisible().catch(() => false)) {
        await recentRow.click({ timeout: 10_000 }).catch(() => {});
      }
      await win.waitForTimeout(1_000);

      // preview.toggle is gated on !inputFocused; drop focus first.
      await win.evaluate(() => {
        const el = document.activeElement;
        if (el instanceof HTMLElement) el.blur();
      });
      await win.keyboard.press("Control+Shift+B");

      const panel = win.locator('[data-testid="preview-panel"]');
      const panelOpened = await panel
        .waitFor({ state: "visible", timeout: 15_000 })
        .then(() => true)
        .catch(() => false);
      // A pristine profile with no workspace cannot host the browser panel;
      // skip rather than fail in that environment.
      test.skip(!panelOpened, "browser panel unavailable (no workspace configured)");

      const omnibox = win.locator('input[aria-label="Preview URL"]');
      await omnibox.click();
      await omnibox.fill(pagePath);
      await omnibox.press("Enter");
      await win.waitForTimeout(2_500);

      await win.locator('button[aria-label="More browser tools"]').click();
      await expect(
        win.locator('[data-testid="browser-overflow-menu"]'),
      ).toBeVisible();

      // The snapshot must stand in while the suppressor is open...
      const frame = win.locator('[data-testid="preview-freeze-frame"]');
      await expect(frame).toBeVisible();
      await expect(frame).toHaveAttribute("src", /^data:image\/jpeg;base64,/);

      // ...and cover the surface the native view vacated.
      const frameBox = await frame.boundingBox();
      const surfaceBox = await win
        .locator('[role="region"][aria-label="Page preview"]')
        .boundingBox();
      expect(frameBox).not.toBeNull();
      expect(surfaceBox).not.toBeNull();
      expect(Math.abs(frameBox!.width - surfaceBox!.width)).toBeLessThan(4);
      expect(Math.abs(frameBox!.height - surfaceBox!.height)).toBeLessThan(4);

      // Resize while frozen: the snapshot must stay pinned to its
      // capture-time size (clip/reveal, never stretch) and keep standing in
      // for the detached view — a stray bounds sync must not remount the
      // native view above the open menu.
      const before = await frame.boundingBox();
      await app.evaluate(({ BrowserWindow }, delta) => {
        const w = BrowserWindow.getAllWindows()[0];
        const [width, height] = w.getSize();
        w.setSize(width + delta, height - delta);
      }, 80);
      await win.waitForTimeout(800);
      await expect(frame).toBeVisible();
      const after = await frame.boundingBox();
      expect(Math.abs(after!.width - before!.width)).toBeLessThan(2);
      expect(Math.abs(after!.height - before!.height)).toBeLessThan(2);

      // Closing the menu remounts the live view and clears the snapshot.
      await win.keyboard.press("Escape");
      await expect(frame).not.toBeAttached();
    } finally {
      await app.close();
    }
  });
});
