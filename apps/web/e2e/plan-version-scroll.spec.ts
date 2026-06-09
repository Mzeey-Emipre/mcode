import { test, expect, type Page } from "@playwright/test";
import {
  mockWebSocketServer,
  interceptZustandStores,
} from "./helpers/e2e-helpers";

const WORKSPACE = {
  id: "ws-plan-scroll-1",
  name: "Plan Scroll Test",
  path: "/tmp/plan-scroll-test",
  provider_config: {},
  is_git_repo: true,
  pinned: false,
  last_opened_at: null,
  sort_order: 0,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const THREAD = {
  id: "thread-plan-scroll-1",
  workspace_id: "ws-plan-scroll-1",
  title: "Plan scroll test",
  branch_name: "main",
  branch_ref: "main",
  worktree_path: null,
  worktree_managed: false,
  sdk_session_id: null,
  status: "idle",
  model: "claude-sonnet-4-20250514",
  provider: "claude",
  goal: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

function buildLongPlanMd(): string {
  const sections = Array.from({ length: 40 }, (_, i) => {
    return `## Task ${i + 1}\n\n${"Implementation detail line. ".repeat(30)}`;
  });
  return `# Auth refactor plan\n\n${sections.join("\n\n")}\n\n\`\`\`mermaid\nflowchart LR\n  A[Login] --> B[Token]\n  B --> C[API]\n\`\`\``;
}

const SHORT_PLAN_MD = `# Auth refactor plan\n\n## Task 1\n\nShort version.\n`;

async function setupWorkspace(page: Page): Promise<void> {
  await page.evaluate(
    ({ workspace, thread }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stores: any[] = (window as any).__mcodeStores ?? [];
      const wsStore = stores.find((s) => {
        const st = s.getState();
        return "activeThreadId" in st && "threads" in st && "workspaces" in st;
      });
      if (!wsStore) throw new Error("[E2E] workspace store not found");
      wsStore.setState({
        workspaces: [workspace],
        activeWorkspaceId: workspace.id,
        threads: [thread],
        activeThreadId: thread.id,
        loading: false,
        error: null,
      });
    },
    { workspace: WORKSPACE, thread: THREAD },
  );
}

async function showRightPanel(page: Page, workspaceId: string, threadId: string): Promise<void> {
  await page.evaluate(
    ({ wid, tid }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stores: any[] = (window as any).__mcodeStores ?? [];
      const diffStore = stores.find((s) => {
        const st = s.getState();
        return "rightPanelByWorkspace" in st && "showRightPanel" in st;
      });
      if (!diffStore) throw new Error("[E2E] diff store not found");
      // Open/closed is per-thread; width/tab stay workspace-global.
      diffStore.getState().showRightPanel(wid, tid);
      diffStore.getState().setRightPanelTab(wid, "tasks");
      diffStore.getState().setRightPanelWidth(wid, 520);
    },
    { wid: workspaceId, tid: threadId },
  );
}

async function seedPlanVersions(page: Page, threadId: string): Promise<void> {
  const longMd = buildLongPlanMd();
  await page.evaluate(
    ({ tid, longContent, shortContent }) => {
      const iso = new Date().toISOString();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stores: any[] = (window as any).__mcodeStores ?? [];
      const planStore = stores.find((s) => {
        const st = s.getState();
        return "plansByThread" in st && "setActiveVersion" in st;
      });
      if (!planStore) throw new Error("[E2E] plan store not found");

      planStore.setState({
        plansByThread: {
          [tid]: [
            {
              id: "plan-v1",
              threadId: tid,
              messageId: "msg-v1",
              version: 1,
              title: "Auth refactor plan",
              contentMd: longContent,
              sectionsJson: [{ id: "t1", title: "Task 1", level: 2 }],
              changeSummary: null,
              status: "superseded",
              createdAt: iso,
            },
            {
              id: "plan-v2",
              threadId: tid,
              messageId: "msg-v2",
              version: 2,
              title: "Auth refactor plan",
              contentMd: shortContent,
              sectionsJson: [{ id: "t1", title: "Task 1", level: 2 }],
              changeSummary: "Revised after feedback on auth types",
              status: "draft",
              createdAt: iso,
            },
          ],
        },
        activeVersionByThread: { [tid]: 1 },
        generatingThreads: new Set<string>(),
      });
    },
    { tid: threadId, longContent: longMd, shortContent: SHORT_PLAN_MD },
  );
}

interface LayoutSnapshot {
  panelWidth: number;
  viewportWidth: number;
  articleWidth: number;
  docClientWidth: number;
  docScrollWidth: number;
  bodyScrollHeight: number;
  bodyClientHeight: number;
}

async function captureLayout(page: Page): Promise<LayoutSnapshot> {
  return page.evaluate(() => {
    const panel = document.querySelector('[aria-label="Thread side panel"], [role="dialog"]')
      ?? document.querySelector(".rounded-lg.shadow-sm.overflow-hidden");
    const viewport = document.querySelector('[data-testid="plan-panel-viewport"]')
      ?? document.querySelector('[data-slot="scroll-area-viewport"]');
    const article = document.querySelector(".prose.prose-sm");
    const docEl = document.documentElement;
    const body = document.body;
    return {
      panelWidth: panel instanceof HTMLElement ? panel.clientWidth : 0,
      viewportWidth: viewport instanceof HTMLElement ? viewport.clientWidth : 0,
      articleWidth: article instanceof HTMLElement ? article.clientWidth : 0,
      docClientWidth: docEl.clientWidth,
      docScrollWidth: docEl.scrollWidth,
      bodyScrollHeight: body.scrollHeight,
      bodyClientHeight: body.clientHeight,
    };
  });
}

async function maxWidthDeltaDuring(
  page: Page,
  action: () => Promise<void>,
  samples = 12,
): Promise<{ baseline: LayoutSnapshot; maxDelta: number; snapshots: LayoutSnapshot[] }> {
  const baseline = await captureLayout(page);
  const snapshots: LayoutSnapshot[] = [baseline];
  let maxDelta = 0;

  await action();

  for (let i = 0; i < samples; i++) {
    await page.waitForTimeout(16);
    const snap = await captureLayout(page);
    snapshots.push(snap);
    const delta = Math.max(
      Math.abs(snap.panelWidth - baseline.panelWidth),
      Math.abs(snap.viewportWidth - baseline.viewportWidth),
      Math.abs(snap.articleWidth - baseline.articleWidth),
      Math.abs(snap.docClientWidth - baseline.docClientWidth),
    );
    maxDelta = Math.max(maxDelta, delta);
  }

  return { baseline, maxDelta, snapshots };
}

test.describe("Plan version navigation layout stability", () => {
  test.beforeEach(async ({ page }) => {
    await mockWebSocketServer(page);
    await interceptZustandStores(page);
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await setupWorkspace(page);
    await seedPlanVersions(page, THREAD.id);
    await showRightPanel(page, WORKSPACE.id, THREAD.id);
    await expect(page.getByRole("button", { name: "Next version" })).toBeVisible({
      timeout: 5000,
    });
  });

  test("switching plan versions does not shift panel or document width", async ({ page }) => {
    const nextBtn = page.getByRole("button", { name: "Next version" });

    const forward = await maxWidthDeltaDuring(page, async () => {
      await nextBtn.click();
      await expect(page.getByText("v2", { exact: true })).toBeVisible();
    });

    expect(forward.maxDelta, JSON.stringify(forward.snapshots, null, 2)).toBeLessThanOrEqual(1);

    const prevBtn = page.getByRole("button", { name: "Previous version" });
    const backward = await maxWidthDeltaDuring(page, async () => {
      await prevBtn.click();
      await expect(page.getByText("v1", { exact: true })).toBeVisible();
    });

    expect(backward.maxDelta, JSON.stringify(backward.snapshots, null, 2)).toBeLessThanOrEqual(1);
  });

  test("scrolling plan content after version switch does not shift width", async ({ page }) => {
    const viewport = page.locator('[data-testid="plan-panel-viewport"]').first();
    await expect(viewport).toBeVisible();

    const nextBtn = page.getByRole("button", { name: "Next version" });
    await nextBtn.click();
    await expect(page.getByText("v2", { exact: true })).toBeVisible();

    const baseline = await captureLayout(page);
    let maxDelta = 0;

    for (let step = 0; step < 8; step++) {
      await viewport.evaluate((el, offset) => {
        (el as HTMLElement).scrollTop = offset;
      }, step * 120);
      await page.waitForTimeout(32);
      const snap = await captureLayout(page);
      const delta = Math.max(
        Math.abs(snap.panelWidth - baseline.panelWidth),
        Math.abs(snap.viewportWidth - baseline.viewportWidth),
        Math.abs(snap.docClientWidth - baseline.docClientWidth),
      );
      maxDelta = Math.max(maxDelta, delta);
    }

    expect(maxDelta, JSON.stringify({ baseline, maxDelta })).toBeLessThanOrEqual(1);
  });

  test("overlay panel mode keeps stable width on version switch", async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 700 });
    await showRightPanel(page, WORKSPACE.id, THREAD.id);
    await expect(page.getByRole("button", { name: "Next version" })).toBeVisible({
      timeout: 5000,
    });

    const nextBtn = page.getByRole("button", { name: "Next version" });
    const forward = await maxWidthDeltaDuring(page, async () => {
      await nextBtn.click();
      await expect(page.getByText("v2", { exact: true })).toBeVisible();
    }, 24);

    expect(forward.maxDelta, JSON.stringify(forward.snapshots, null, 2)).toBeLessThanOrEqual(1);
  });

  test("document root does not become vertically scrollable during version switch", async ({ page }) => {
    const nextBtn = page.getByRole("button", { name: "Next version" });
    let sawDocOverflow = false;

    const baseline = await captureLayout(page);
    await nextBtn.click();
    await expect(page.getByText("v2", { exact: true })).toBeVisible();

    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(16);
      const snap = await captureLayout(page);
      if (snap.docScrollWidth > snap.docClientWidth + 1) sawDocOverflow = true;
      if (snap.bodyScrollHeight > snap.bodyClientHeight + 1) sawDocOverflow = true;
    }

    expect(sawDocOverflow, JSON.stringify({ baseline })).toBe(false);
  });
});
