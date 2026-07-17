import { test, expect, type Page } from "@playwright/test";
import { mockWebSocketServer, interceptZustandStores } from "./helpers/e2e-helpers";

/**
 * E2E coverage for the shell UI:
 *  1. Composer overflow popover for responsive permission and task controls.
 *  2. Right panel modal overlay at narrow viewports (<768px).
 *  3. Docked shell surfaces with dividers instead of visible gaps.
 */

const now = new Date().toISOString();
/** Minimal workspace so the palette projects list has at least one row to select. */
const WORKSPACE_FIXTURE = {
  id: "ws-float-1",
  name: "Test Workspace",
  path: "/test",
  provider_config: {},
  is_git_repo: true,
  pinned: false,
  last_opened_at: null,
  sort_order: 0,
  created_at: now,
  updated_at: now,
};

/**
 * Activate a minimal workspace in the Zustand store. Requires interceptZustandStores()
 * before page.goto in the enclosing test so the patched store receives injected state.
 */
async function activateWorkspace(page: Page): Promise<void> {
  await page.evaluate((workspace) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stores: any[] = (window as any).__mcodeStores ?? [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wsStore = stores.find((s: any) => {
      const st = s.getState();
      return "activeWorkspaceId" in st && "threads" in st && "workspaces" in st;
    });
    if (!wsStore) throw new Error("[E2E] workspace store not found");
    wsStore.setState({
      workspaces: [workspace],
      activeWorkspaceId: workspace.id,
      threads: [],
      loading: false,
      error: null,
    });
  }, WORKSPACE_FIXTURE);
}

async function openComposerInNewThread(page: Page): Promise<void> {
  await expect(page.getByText("No projects yet", { exact: true })).toBeVisible();
  await activateWorkspace(page);
  await expect(
    page.getByRole("heading", { name: "What should we build in Test Workspace?" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /^(Send message|Queue message|Stop agent)$/ })).toBeVisible();
  const closeProjectTree = page.getByRole("button", {
    name: "Close project tree",
  });
  if (await closeProjectTree.isVisible().catch(() => false)) {
    const viewport = page.viewportSize();
    if (!viewport) throw new Error("Viewport size is unavailable");
    await page.mouse.click(viewport.width - 8, 8);
    await expect(closeProjectTree).toHaveCount(0);
  }
}

test.describe("Composer options at wide viewport", () => {
  test.beforeEach(async ({ page }) => {
    await mockWebSocketServer(page);
    // Must be called before page.goto so zustand.js is intercepted on load.
    await interceptZustandStores(page);
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  test("renders Full access inline and hides the overflow trigger", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await openComposerInNewThread(page);

    // Capability modes are attached through the add menu, not permanent controls.
    await expect(page.getByRole("button", { name: /^Build$/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Full access$/ })).toBeVisible();

    // The overflow trigger is reserved for narrow viewports.
    await expect(page.getByRole("button", { name: "Composer options" })).toHaveCount(0);
  });
});

test.describe("Composer options at narrow viewport", () => {
  test.beforeEach(async ({ page }) => {
    await mockWebSocketServer(page);
    // Must be called before page.goto so zustand.js is intercepted on load.
    await interceptZustandStores(page);
    await page.setViewportSize({ width: 600, height: 800 });
  });

  test("hides inline toggles and reveals them inside the overflow popover", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await openComposerInNewThread(page);

    // Inline permission controls collapse below the threshold.
    await expect(page.getByRole("button", { name: /^Build$/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Full access$/ })).toHaveCount(0);

    const trigger = page.getByRole("button", { name: "Composer options" });
    await expect(trigger).toBeVisible();
    await trigger.click();

    // Capability modes remain in the add menu; this popover contains permissions.
    await expect(page.getByText("Mode", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Permissions", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Full" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Supervised" })).toBeVisible();
  });

  test("permission control reflects aria-pressed when toggled", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await openComposerInNewThread(page);

    await page.getByRole("button", { name: "Composer options" }).click();
    const fullBtn = page.getByRole("button", { name: "Full", exact: true });
    const supervisedBtn = page.getByRole("button", { name: "Supervised", exact: true });

    await expect(fullBtn).toHaveAttribute("aria-pressed", "true");
    await expect(supervisedBtn).toHaveAttribute("aria-pressed", "false");

    await supervisedBtn.click();

    await expect(supervisedBtn).toHaveAttribute("aria-pressed", "true");
    await expect(fullBtn).toHaveAttribute("aria-pressed", "false");
  });

  test("Tasks panel row is hidden when the thread has no tasks", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await openComposerInNewThread(page);

    await page.getByRole("button", { name: "Composer options" }).click();
    await expect(page.getByText("Tasks panel")).toHaveCount(0);
  });
});

test.describe("Floating sidebar resize", () => {
  test.beforeEach(async ({ page }) => {
    await mockWebSocketServer(page);
    await interceptZustandStores(page);
    await page.setViewportSize({ width: 600, height: 800 });
  });

  test("docks a floating sidebar when a selected project gains space", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await activateWorkspace(page);

    await page.evaluate(() => {
      const stores =
        (window as unknown as {
          __mcodeStores?: Array<{
            getState: () => Record<string, unknown>;
            setState: (patch: Record<string, unknown>) => void;
          }>;
        }).__mcodeStores ?? [];
      const uiStore = stores.find((store) => "sidebarFloating" in store.getState());
      if (!uiStore) throw new Error("[E2E] UI store not found");
      uiStore.setState({
        sidebarCollapsed: true,
        sidebarCollapsedByLayout: false,
        sidebarFloating: false,
      });
    });

    await page.getByRole("button", { name: "Expand sidebar" }).click();
    await expect(page.getByTestId("sidebar-floating")).toBeVisible();

    await page.setViewportSize({ width: 1280, height: 800 });

    await expect(page.getByTestId("sidebar-floating")).toHaveCount(0);
    await expect(page.getByTestId("sidebar-docked")).toBeVisible();
  });
});

test.describe("Project tree empty state", () => {
  test.beforeEach(async ({ page }) => {
    await mockWebSocketServer(page);
    await interceptZustandStores(page);
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  test("labels an expanded project with no threads", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("mcode-expanded-projects", JSON.stringify({ "ws-float-1": false }));
    });
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await activateWorkspace(page);

    await page.getByRole("button", { name: "Toggle threads for Test Workspace" }).click();

    await expect(page.getByText("Empty", { exact: true })).toBeVisible();
  });
});

test.describe("Docked shell surfaces", () => {
  test.beforeEach(async ({ page }) => {
    await mockWebSocketServer(page);
  });

  test("page chrome keeps a separate --page token", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const tokens = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      return {
        page: root.getPropertyValue("--page").trim(),
        background: root.getPropertyValue("--background").trim(),
      };
    });

    // Both tokens must be defined.
    expect(tokens.page).not.toBe("");
    expect(tokens.background).not.toBe("");

    // They must differ so the project tree can use chrome tone beside content.
    expect(tokens.page).not.toBe(tokens.background);
  });

  test("main content joins the shell without rounded internal corners", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const main = page.locator("main").first();
    const radius = await main.evaluate((el) => getComputedStyle(el).borderRadius);
    expect(radius).toBe("0px");
  });

  test("sidebar uses page tone and touches the main content with a divider", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const sidebar = page.getByTestId("sidebar-docked");
    const main = page.locator("main").first();
    const metrics = await page.evaluate(() => {
      const probe = document.createElement("div");
      probe.className = "bg-page";
      document.body.append(probe);
      const pageBackground = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return { pageBackground };
    });
    const sidebarBackground = await sidebar.evaluate((el) =>
      getComputedStyle(el).backgroundColor,
    );
    const rightBorder = await sidebar.evaluate((el) =>
      getComputedStyle(el).borderRightWidth,
    );
    const [sidebarBox, mainBox] = await Promise.all([
      sidebar.boundingBox(),
      main.boundingBox(),
    ]);

    expect(sidebarBackground).toBe(metrics.pageBackground);
    expect(rightBorder).toBe("1px");
    expect(sidebarBox).not.toBeNull();
    expect(mainBox).not.toBeNull();
    expect(Math.abs(sidebarBox!.x + sidebarBox!.width - mainBox!.x)).toBeLessThanOrEqual(1);
  });
});

test.describe("Right panel modal overlay (narrow viewport)", () => {
  test.beforeEach(async ({ page }) => {
    await mockWebSocketServer(page);
  });

  test("useMediaQuery reports below md at 600px", async ({ page }) => {
    await page.setViewportSize({ width: 600, height: 800 });
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const matchesMd = await page.evaluate(() =>
      window.matchMedia("(min-width: 768px)").matches,
    );
    expect(matchesMd).toBe(false);
  });

  test("useMediaQuery reports above md at 1280px", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const matchesMd = await page.evaluate(() =>
      window.matchMedia("(min-width: 768px)").matches,
    );
    expect(matchesMd).toBe(true);
  });
});

test.describe("Visual regression — docked layout", () => {
  test.beforeEach(async ({ page }) => {
    await mockWebSocketServer(page);
    // Must be called before page.goto so zustand.js is intercepted on load.
    await interceptZustandStores(page);
  });

  test("captures wide-viewport screenshot (1280×800) showing docked panels", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.screenshot({
      path: testInfo.outputPath("docked-wide.png"),
      fullPage: false,
    });
  });

  test("captures narrow-viewport screenshot (600×800)", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 600, height: 800 });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "What should we work on?" })).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("docked-narrow.png"),
      fullPage: false,
    });
  });

  test("captures composer popover open at narrow viewport", async ({ page }, testInfo) => {
    // Overflow popover only renders below the md breakpoint.
    await page.setViewportSize({ width: 600, height: 800 });
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    await openComposerInNewThread(page);
    const trigger = page.getByRole("button", { name: "Composer options" });
    await expect(trigger).toBeVisible();
    await trigger.click();
    // Wait for the popover to render its controls before screenshotting.
    await expect(page.getByText("Permissions", { exact: true })).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("composer-popover.png"),
      fullPage: false,
    });
  });
});
