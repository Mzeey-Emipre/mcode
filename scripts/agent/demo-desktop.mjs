#!/usr/bin/env node
/**
 * Launch the packaged Electron main process under Playwright, capture a
 * screenshot of the first window (**after** the transport connects and the
 * sidebar renders), optionally walk common panel toggles via keybindings (`--tour`), dump main/renderer console output, then
 * exit (leaving the app running if `--keep-open` is passed).
 *
 * Use this when the change touches Electron-specific surfaces (native menus,
 * tray, BrowserView, contextBridge IPC, deep links, window chrome). For
 * everything else, prefer scripts/agent/demo.mjs: the Vite dev target is
 * faster and Playwright MCP can drive it interactively.
 *
 * Requires: `cd apps/desktop && bun run build` to have produced
 * apps/desktop/dist/main/main.cjs (and a server bundle for the child process).
 *
 * Prints an instructions block at the end so an agent knows where artifacts
 * landed.
 */
import { mkdirSync, rmSync, existsSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

const KEEP_OPEN = process.argv.includes("--keep-open");
const TOUR = process.argv.includes("--tour");
const TIMEOUT_MS = Number(process.env.MCODE_DEMO_TIMEOUT_MS ?? 60_000);
/** Playwright-compatible modifier matching `mod` in default-keybindings (`Ctrl` vs `Cmd`). */
const MOD_PRIMARY = process.platform === "darwin" ? "Meta" : "Control";
const REPO_ROOT = resolve(process.cwd());
const DESKTOP_DIR = join(REPO_ROOT, "apps", "desktop");
const MAIN_BUNDLE = join(DESKTOP_DIR, "dist", "main", "main.cjs");
const SCREENSHOT_DIR = join(
  REPO_ROOT,
  "apps",
  "web",
  "e2e",
  "screenshots",
  "demo-desktop",
);

/** @param {number} ms */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

if (!existsSync(MAIN_BUNDLE)) {
  console.error(`[demo-desktop] missing build: ${MAIN_BUNDLE}`);
  console.error("[demo-desktop] run `cd apps/desktop && bun run build` first");
  process.exit(1);
}

// Playwright is hoisted in the web workspace. Resolve from there so this
// script works from the repo root without an explicit dep entry.
const require = createRequire(join(REPO_ROOT, "apps", "web", "package.json"));
let playwright;
try {
  playwright = require("@playwright/test");
} catch (err) {
  console.error("[demo-desktop] could not load @playwright/test:", err.message);
  console.error("[demo-desktop] run `bun install` first");
  process.exit(1);
}

const { _electron: electron } = playwright;
mkdirSync(SCREENSHOT_DIR, { recursive: true });

/**
 * Drops focus from editable fields so `when: "!inputFocused"` keybindings
 * (`changes.toggle`, `preview.toggle`, etc.) reliably fire during the demo tour.
 *
 * @param {import('@playwright/test').Page} page
 */
async function blurFocusedInput(page) {
  await page
    .evaluate(() => {
      const el = document.activeElement;
      if (el && "blur" in el && typeof el.blur === "function") {
        /** @type {HTMLElement} */ (el).blur();
      }
    })
    .catch(() => {});
}

/** Wait until `initTransport` replaced the splash with the sidebar shell (`ThreadSearchBar`). */
async function waitForAppShell(page) {
  await page
    .getByPlaceholder("Search threads...")
    .waitFor({ state: "visible", timeout: 120_000 })
    .catch(() => {});
}

/** Opens one thread when the sidebar or home lists one, so Chat header shortcuts exist. */
async function ensureChatView(page) {
  const chatReady = async () =>
    page.locator('[data-testid="chat-view"]').isVisible().catch(() => false);
  if (await chatReady()) return true;

  const threadItem = page.locator('[data-testid="thread-item"]').first();
  const recentRow = page.locator('[data-testid="recent-thread-row"]').first();
  if (await threadItem.isVisible().catch(() => false)) {
    await threadItem.click({ timeout: 10_000 }).catch(() => {});
  } else if (await recentRow.isVisible().catch(() => false)) {
    await recentRow.click({ timeout: 10_000 }).catch(() => {});
  } else return false;

  await page.locator('[data-testid="chat-view"]').waitFor({
    state: "visible",
    timeout: 20_000,
  }).catch(() => {});
  await sleep(500);
  return await chatReady();
}

/**
 * Writes a PNG into `demo-desktop/` and logs its path for the transcript.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} filename
 */
async function screenshotStep(page, filename) {
  const path = join(SCREENSHOT_DIR, filename);
  await page.screenshot({ path, fullPage: true });
  console.log(`[demo-desktop] screenshot: ${path}`);
}

// Isolate the demo from your real profile by default: the launched app gets a
// fresh, empty `MCODE_DATA_DIR` so the tour can never read or mutate `~/.mcode`.
// The embedded server also picks its own free port within the desktop range, so
// we never collide with — or attach to — another running instance. Opt back
// into the real profile with `MCODE_DEMO_USE_REAL_DATA=1` when you specifically
// need to demo against existing workspaces.
const USE_REAL_DATA = process.env.MCODE_DEMO_USE_REAL_DATA === "1";
const demoDataDir = USE_REAL_DATA ? null : mkdtempSync(join(tmpdir(), "mcode-demo-desktop-"));
if (demoDataDir) {
  console.log(`[demo-desktop] isolated data dir: ${demoDataDir}`);
} else {
  console.log("[demo-desktop] MCODE_DEMO_USE_REAL_DATA=1 — using your real ~/.mcode profile");
}

console.log(`[demo-desktop] launching Electron from ${DESKTOP_DIR}`);
const app = await electron.launch({
  args: ["."],
  cwd: DESKTOP_DIR,
  timeout: TIMEOUT_MS,
  env: demoDataDir ? { ...process.env, MCODE_DATA_DIR: demoDataDir } : process.env,
});

const mainConsole = [];
const rendererErrors = [];
app.process().stdout?.on("data", (b) => mainConsole.push(String(b)));
app.process().stderr?.on("data", (b) => mainConsole.push(String(b)));

const win = await app.firstWindow({ timeout: TIMEOUT_MS });
win.on("console", (m) => {
  if (m.type() === "error") rendererErrors.push(m.text());
});

await win.waitForLoadState("domcontentloaded");

await waitForAppShell(win);
await screenshotStep(win, "first-window.png");

if (TOUR) {
  await win.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  await sleep(2500);
  await screenshotStep(win, "tour-02-after-settled.png");

  const chat = await ensureChatView(win);
  if (chat) {
    await screenshotStep(win, "tour-02b-active-chat.png");
  } else {
    console.warn(
      "[demo-desktop] tour: no thread rows found; Changes header click may be skipped",
    );
  }

  await blurFocusedInput(win);
  await sleep(200);
  try {
    await win.keyboard.press(`${MOD_PRIMARY}+d`);
    await sleep(750);
    await screenshotStep(win, "tour-03-changes-panel-mod-d.png");
  } catch (err) {
    console.warn("[demo-desktop] tour: changes.toggle hotkey skipped:", String(err));
  }

  await blurFocusedInput(win);
  try {
    await win.keyboard.press(`${MOD_PRIMARY}+j`);
    await sleep(750);
    await screenshotStep(win, "tour-04-terminal-panel-mod-j.png");
  } catch (err) {
    console.warn("[demo-desktop] tour: terminal.toggle hotkey skipped:", String(err));
  }

  await blurFocusedInput(win);
  try {
    await win.keyboard.press(`${MOD_PRIMARY}+Shift+b`);
    await sleep(750);
    await screenshotStep(win, "tour-05-preview-panel-mod-shift-b.png");
  } catch (err) {
    console.warn("[demo-desktop] tour: preview.toggle hotkey skipped:", String(err));
  }

  const changesBtn = win.getByRole("button", { name: "Toggle changes panel" });
  const headerVisible = await changesBtn.isVisible().catch(() => false);
  if (headerVisible) {
    await changesBtn.click({ timeout: 5000 }).catch(() => {});
    await sleep(500);
    await screenshotStep(win, "tour-06-changes-header-button.png").catch(() => {});
  } else {
    console.warn(
      "[demo-desktop] tour: header \"Toggle changes panel\" not visible (open a thread with chat header)",
    );
  }
}

const title = await win.title();
console.log("");
console.log(`[demo-desktop] first window title: ${title}`);
console.log(`[demo-desktop] renderer errors: ${rendererErrors.length}`);
for (const err of rendererErrors) console.log(`  - ${err}`);
console.log("");
console.log("[demo-desktop] artifacts dir:", SCREENSHOT_DIR);
if (TOUR) {
  console.log(
    "[demo-desktop] --tour captured extra PNGs prefixed with tour-* (panels may be empty unless a workspace + thread is active)",
  );
} else {
  console.log("[demo-desktop] pass --tour for Changes / Terminal / Preview screenshots");
}

console.log(
  "[demo-desktop] further steps: drive `win` programmatically; see scripts/agent/demo-desktop.mjs",
);

if (KEEP_OPEN) {
  console.log("[demo-desktop] --keep-open set; leaving Electron running");
  if (demoDataDir) {
    console.log(`[demo-desktop] isolated data dir left in place for inspection: ${demoDataDir}`);
  }
  console.log("[demo-desktop] close the window or Ctrl-C to exit");
  await new Promise(() => {});
} else {
  await app.close();
  if (demoDataDir) rmSync(demoDataDir, { recursive: true, force: true });
}
