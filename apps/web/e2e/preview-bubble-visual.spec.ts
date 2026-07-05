/**
 * Visual and semantic tests for the annotation bubble dark-palette polish.
 *
 * Screenshots are captured to the repo's screenshots/ dir for human review.
 * Every test also asserts semantic correctness (visible elements, computed
 * colors, roles) so CI has a deterministic gate independent of pixel comparison.
 *
 * Coverage that already lives in preview-chrome.spec.ts (slash popup keyboard
 * nav, Escape behavior, Enter-to-save) is NOT duplicated here. This file
 * focuses exclusively on the dark-tone visual cohesion of the bubble and its
 * autocomplete popups.
 */
import { test, expect, type Page } from "@playwright/test";
import {
  interceptZustandStores,
  mockWebSocketServer,
  type RpcOverrides,
} from "./helpers/e2e-helpers";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";

// Save screenshots to the repo-level screenshots/ dir so they stay under
// version control for branch review. The dir is in .gitignore for main but
// not for this feature branch, so reviewers can see the output directly.
const SCREENSHOTS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
  "screenshots",
);

const now = new Date().toISOString();

const WORKSPACE = {
  id: "ws-1",
  name: "Test Workspace",
  path: "/test/path",
  provider_config: {},
  is_git_repo: true,
  pinned: false,
  last_opened_at: null,
  sort_order: 0,
  created_at: now,
  updated_at: now,
};

const THREAD = {
  id: "thread-1",
  workspace_id: "ws-1",
  title: "Test Thread",
  status: "paused" as const,
  mode: "direct" as const,
  worktree_path: null,
  branch: "main",
  worktree_managed: false,
  issue_number: null,
  pr_number: null,
  pr_status: null,
  sdk_session_id: null,
  created_at: now,
  updated_at: now,
  model: "claude-sonnet-4-6",
  provider: "claude",
  deleted_at: null,
  last_context_tokens: null,
  context_window: null,
  reasoning_level: null,
  interaction_mode: null,
  permission_mode: null,
  copilot_agent: null,
  parent_thread_id: null,
  forked_from_message_id: null,
  last_compact_summary: null,
};

async function injectPreviewBridge(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const noop = (): Promise<void> => Promise.resolve();
    const unsub = (): (() => void) => () => undefined;
    const emptyTabSet = (threadId: string): unknown => ({
      threadId, activeTabId: null, tabs: [],
    });
    const tabOk = (threadId: string): Promise<unknown> =>
      Promise.resolve({ ok: true, data: emptyTabSet(threadId) });
    const tabCreateOk = (threadId: string): Promise<unknown> =>
      Promise.resolve({ ok: true, data: { tabSet: emptyTabSet(threadId), createdTabId: "mock-tab" } });

    let pickResolver: ((v: { ok: false; error: string }) => void) | null = null;
    const preview = {
      sync: noop,
      navigate: () => Promise.resolve({ ok: true } as const),
      detectLocalPorts: () => Promise.resolve([]),
      goBack: () => Promise.resolve(false),
      goForward: () => Promise.resolve(false),
      reload: noop, forceReload: noop, clearCookies: noop, clearCache: noop,
      getZoom: () => Promise.resolve(1),
      setZoom: (f: number) => Promise.resolve(f),
      openExternal: noop, openGuestDevTools: noop,
      onShortcutFired: unsub,
      getNavigationState: () => Promise.resolve({ canGoBack: false, canGoForward: false }),
      capturePictureReference: () => Promise.resolve({ ok: false, error: "no-preview" } as const),
      capturePictureReferenceRegion: () => Promise.resolve({ ok: false, error: "no-preview" } as const),
      capturePictureReferenceElementPick: () =>
        new Promise<{ ok: false; error: string }>((resolve) => { pickResolver = resolve; }),
      capturePageContext: () => Promise.resolve({ ok: false, error: "no-preview" } as const),
      releaseBrowserCaptureSpills: noop,
      onPageStatus: (cb: (s: { url: string | null; title: string | null; favicon: string | null; phase: "loading" | "loaded" | "error" | "discarded" }) => void) => {
        const status = { url: "https://example.com", title: "Example", favicon: null, phase: "loaded" as const };
        cb(status);
        setTimeout(() => cb(status), 0);
        return () => undefined;
      },
      cancelCapture: () => {
        if (pickResolver) { const r = pickResolver; pickResolver = null; r({ ok: false, error: "cancelled" }); }
        return Promise.resolve();
      },
      tabs: { list: tabOk, create: tabCreateOk, activate: tabOk, close: tabOk, onUpdated: unsub },
      getPerfCounters: () => Promise.resolve({ ramKb: 0, frameRateHz: 60, gpuProcessActive: false, allocationsPerSec: 0 }),
      adoptWebview: () => Promise.resolve({ ok: true } as const),
      releaseWebview: () => Promise.resolve({ ok: true } as const),
      captureAnnotationSnapshot: () => Promise.resolve({
        ok: true,
        meta: { id: "e2e-snapshot", name: "Preview annotation", sizeBytes: 0, sourcePath: "preview/e2e-snapshot.png" },
        capture: { schemaVersion: 2, pageUrl: "https://example.com/", pageTitle: "Example", capturedAt: new Date().toISOString(), captureKind: "element", bounds: { x: 0, y: 0, width: 0, height: 0 }, layoutViewport: { width: 800, height: 600 } },
      }),
      design: {
        setViewport: () => Promise.resolve({ ok: true, data: { width: 0, height: 0 } } as const),
        resetViewport: noop,
        setInspect: () => Promise.resolve({ ok: true } as const),
        setAnnotationGuard: () => Promise.resolve({ ok: true } as const),
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).desktopBridge = { preview };
  });
}

async function openAppAtThread(page: Page, overrides: RpcOverrides = {}): Promise<void> {
  await mockWebSocketServer(page, {
    "workspace.list": [WORKSPACE],
    "thread.list": [THREAD],
    "message.list": { messages: [], hasMore: false, answeredPlanMessageIds: [] },
    ...overrides,
  });
  await page.goto("/");
  await page.waitForSelector("text=Test Workspace", { timeout: 15000 });
  await page.locator("text=Test Workspace").click();
  await page.waitForSelector("[data-testid='thread-item']", { timeout: 10000 });
  await page.locator("[data-testid='thread-item']").first().click();
  await page.waitForSelector('[contenteditable="true"]', { timeout: 10000 });
}

async function openPreviewTab(page: Page): Promise<void> {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.keyboard.press("Control+Shift+B");
  await page.waitForSelector("[data-testid='preview-panel'], [data-testid='preview-panel-unavailable']", { timeout: 5000 });
}

async function waitForAnnotationStores(page: Page): Promise<void> {
  await expect.poll(
    () => page.evaluate(() => {
      type StoreHandle = { getState: () => Record<string, unknown> };
      const stores = (window as unknown as { __mcodeStores?: StoreHandle[] }).__mcodeStores ?? [];
      const annotationStore = stores.find((s) => {
        const st = s.getState();
        return "byThread" in st && "drafts" in st && "buildBundle" in st;
      });
      const designStore = stores.find((s) => {
        const st = s.getState();
        return "modes" in st && "toggle" in st && "isActive" in st;
      });
      return Boolean(annotationStore && designStore);
    }),
    { timeout: 10000 },
  ).toBe(true);
}

async function seedDraft(page: Page, note = ""): Promise<void> {
  await waitForAnnotationStores(page);
  await page.evaluate((args) => {
    const [threadId, note] = args;
    type StoreHandle = { getState: () => Record<string, unknown>; setState: (p: Record<string, unknown>) => void };
    const stores = (window as unknown as { __mcodeStores?: StoreHandle[] }).__mcodeStores ?? [];
    const annotationStore = stores.find((s) => {
      const st = s.getState(); return "byThread" in st && "drafts" in st && "buildBundle" in st;
    })!;
    const designStore = stores.find((s) => {
      const st = s.getState(); return "modes" in st && "toggle" in st && "isActive" in st;
    })!;
    annotationStore.setState({
      drafts: {
        [threadId]: {
          threadId,
          pageIdentity: "https://example.com/",
          bounds: { x: 20, y: 60, width: 220, height: 48 },
          selectorHint: "input[name='q']",
          label: "Search input",
          pageContext: {
            schemaVersion: 2, pageUrl: "https://example.com/", pageTitle: "Example",
            capturedAt: "2026-07-01T00:00:00.000Z", captureKind: "element",
            bounds: { x: 20, y: 60, width: 220, height: 48 },
            layoutViewport: { width: 800, height: 600 },
          },
          note,
        },
      },
    });
    designStore.setState({ modes: { [threadId]: true } });
  }, [THREAD.id, note] as [string, string]);
  await page.waitForSelector("[data-testid='preview-annotation-bubble']", { timeout: 5000 });
}

async function seedSkillsStore(page: Page): Promise<void> {
  await page.evaluate(() => {
    type StoreHandle = {
      getState: () => Record<string, unknown>;
      setState: (patch: Record<string, unknown>) => void;
    };
    const stores =
      (window as unknown as { __mcodeStores?: StoreHandle[] }).__mcodeStores ?? [];
    const skillsStore = stores.find((store) => {
      const state = store.getState();
      return "skills" in state && "isLoading" in state && "load" in state;
    });
    if (!skillsStore) throw new Error("[E2E] skillsStore not found");
    skillsStore.setState({
      skills: [
        { name: "commit", description: "Create a git commit" },
        { name: "review-pr", description: "Review a pull request" },
      ],
      isLoading: false,
      error: null,
    });
  });
}

function screenshotPath(name: string): string {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  return path.join(SCREENSHOTS_DIR, `bubble-${name}.png`);
}

// Run serially because each test opens the app fresh to avoid shared DOM state.
test.describe.configure({ mode: "serial" });

test.describe("Bubble dark-tone visual cohesion", () => {
  test("(a) bubble collapsed: dark surface and placeholder visible", async ({ page }) => {
    await interceptZustandStores(page);
    await injectPreviewBridge(page);
    await openAppAtThread(page);
    await openPreviewTab(page);
    await seedDraft(page);

    const bubble = page.getByTestId("preview-annotation-bubble");
    await expect(bubble).toBeVisible();

    // Semantic: placeholder text must be present in the input
    const input = bubble.getByLabel("Annotation note");
    await expect(input).toBeVisible();
    await expect(input).toHaveAttribute("placeholder", "Comment · / for skills · @ to mention");

    // Semantic: bubble background must be the dark BUBBLE_SURFACE value (#282828)
    const bg = await bubble.evaluate((el) => getComputedStyle(el).backgroundColor);
    // rgb(40, 40, 40) = #282828
    expect(bg).toBe("rgb(40, 40, 40)");

    await page.screenshot({ path: screenshotPath("a-collapsed"), fullPage: false });
  });

  test("(b) bubble note text: dark note with advanced toggle visible", async ({ page }) => {
    await interceptZustandStores(page);
    await injectPreviewBridge(page);
    await openAppAtThread(page);
    await openPreviewTab(page);
    await seedDraft(page, "Adjust the button color");

    const bubble = page.getByTestId("preview-annotation-bubble");
    await expect(bubble).toBeVisible();
    const input = bubble.getByLabel("Annotation note");
    await expect(input).toHaveValue("Adjust the button color");

    // Semantic: advanced toggle (SlidersHorizontal button) is present
    await expect(page.getByTestId("preview-annotation-advanced-toggle")).toBeVisible();

    await page.screenshot({ path: screenshotPath("b-with-note"), fullPage: false });
  });

  test("(c) bubble with advanced inspector expanded", async ({ page }) => {
    await interceptZustandStores(page);
    await injectPreviewBridge(page);
    await openAppAtThread(page);
    await openPreviewTab(page);
    await seedDraft(page, "Adjust sizing");

    await page.getByTestId("preview-annotation-advanced-toggle").click();
    const advanced = page.getByTestId("preview-annotation-advanced");
    await expect(advanced).toBeVisible({ timeout: 3000 });

    // Semantic: advanced panel background must match BUBBLE_SURFACE_INSET (#202020)
    const advBg = await advanced.evaluate((el) => getComputedStyle(el).backgroundColor);
    // rgb(32, 32, 32) = #202020
    expect(advBg).toBe("rgb(32, 32, 32)");

    await page.screenshot({ path: screenshotPath("c-advanced-open"), fullPage: false });
  });

  test("(c2) inline color picker opens as a dark inspector popover", async ({ page }) => {
    await interceptZustandStores(page);
    await injectPreviewBridge(page);
    await openAppAtThread(page);
    await openPreviewTab(page);
    await seedDraft(page, "Adjust color");

    await page.getByTestId("preview-annotation-advanced-toggle").click();
    await page.getByLabel("Open Text color picker").click();

    const plane = page.getByLabel("Saturation and value for Text color");
    const hue = page.getByLabel("Hue for Text color");
    const textColorValue = page
      .getByTestId("preview-annotation-advanced")
      .getByRole("textbox", { name: "Text color", exact: true });
    await expect(plane).toBeVisible();
    await expect(hue).toBeVisible();
    await expect(page.getByLabel("Text color R")).toBeVisible();
    await expect(page.locator('input[type="color"]')).toHaveCount(0);

    const popoverBg = await page.getByTestId("preview-color-popover-textColor").evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(popoverBg).toBe("rgb(42, 42, 42)");

    const box = await plane.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.click(box!.x + box!.width * 0.35, box!.y + box!.height * 0.45);
    await expect(textColorValue).toHaveValue(/rgb\(/);

    await page.getByLabel("Use HSL for Text color").click();
    await expect(textColorValue).toHaveValue(/hsl\(/);
    await page.screenshot({
      path: screenshotPath("c2-inline-color-picker-hsl"),
      fullPage: false,
    });

    await page.getByLabel("Use HEX for Text color").click();
    await expect(textColorValue).toHaveValue(/^#[0-9A-F]{6}$/);
    await page.screenshot({
      path: screenshotPath("c2-inline-color-picker-hex"),
      fullPage: false,
    });
  });

  test("(d) slash popup open above bubble: dark tone, no builtin commands", async ({ page }) => {
    await interceptZustandStores(page);
    await injectPreviewBridge(page);
    await openAppAtThread(page);
    await openPreviewTab(page);
    await seedSkillsStore(page);
    await seedDraft(page);

    const input = page.getByLabel("Annotation note");
    await input.focus();
    await input.fill("/");

    const listbox = page.getByRole("listbox", { name: "Slash commands" });
    await expect(listbox).toBeVisible({ timeout: 6000 });

    // Semantic: dark popup surface, bg-[#1e1e1e] = rgb(30, 30, 30)
    const popupBg = await listbox.locator("..").evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(popupBg).toBe("rgb(30, 30, 30)");

    // Semantic: seeded skills are present, mcode builtins are absent
    await expect(page.getByText("/commit")).toBeVisible();
    await expect(page.getByText("/m:plan")).toHaveCount(0);

    await page.screenshot({ path: screenshotPath("d-slash-popup"), fullPage: false });
  });

  test("(e) at-mention popup: dark tone, fixed position (clip fix)", async ({ page }) => {
    await interceptZustandStores(page);
    await injectPreviewBridge(page);
    await openAppAtThread(page, {
      "file.list": ["src/app.ts", "src/components/SearchBox.tsx"],
    });
    await openPreviewTab(page);
    await seedDraft(page);

    const input = page.getByLabel("Annotation note");
    await input.focus();
    await input.fill("@");
    const popup = page.locator("[data-file-popup]");
    await expect(popup).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("src/components/SearchBox.tsx")).toBeVisible();

    const position = await popup.evaluate((el) => getComputedStyle(el).position);
    expect(position).toBe("fixed");
    const box = await popup.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(200);
    expect(box!.height).toBeGreaterThan(30);
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    const cssViewport = await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    expect(box!.x + box!.width).toBeLessThanOrEqual(cssViewport.width);
    expect(box!.y + box!.height).toBeLessThanOrEqual(cssViewport.height);

    // Dark surface color, rgb(30, 30, 30) = #1e1e1e
    const bg = await popup.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).toBe("rgb(30, 30, 30)");

    await page.screenshot({
      path: screenshotPath("e-at-mention"),
      fullPage: false,
      scale: "css",
    });
  });
});
