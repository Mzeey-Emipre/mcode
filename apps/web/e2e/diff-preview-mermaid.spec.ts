import { test, expect, type Page } from "@playwright/test";
import type { Thread, TurnSnapshot } from "@mcode/contracts";
import { getDefaultSettings } from "@mcode/contracts";
import {
  mockWebSocketServer,
  interceptZustandStores,
} from "./helpers/e2e-helpers";

/**
 * Regression for the diff-view mermaid bug: fenced ```mermaid blocks rendered
 * as raw `<pre><code class="language-mermaid">` text inside the markdown diff
 * preview instead of a diagram. This drives the real Changes -> Cumulative ->
 * file -> Preview path so the genuine DiffPreview -> DiffPreviewMarkdown ->
 * MermaidBlock pipeline (with the real mermaid library) executes in Chromium,
 * and asserts a rendered <svg> stands in for the fence.
 */

const now = new Date().toISOString();

const WORKSPACE = {
  id: "ws-diff-mermaid",
  name: "Diff Mermaid",
  path: "/tmp/diff-mermaid",
  provider_config: {},
  is_git_repo: true,
  created_at: now,
  updated_at: now,
  pinned: false,
  last_opened_at: Date.now(),
  sort_order: 0,
};

const THREAD: Thread = {
  id: "thread-diff-mermaid",
  workspace_id: WORKSPACE.id,
  title: "Diff Mermaid Thread",
  status: "paused",
  mode: "direct",
  worktree_path: null,
  branch: "main",
  worktree_managed: false,
  issue_number: null,
  pr_number: null,
  pr_status: null,
  sdk_session_id: null,
  created_at: now,
  updated_at: now,
  model: "claude-3-5-sonnet",
  provider: "claude",
  deleted_at: null,
  last_context_tokens: null,
  context_window: null,
  reasoning_level: null,
  interaction_mode: null,
  permission_mode: null,
  parent_thread_id: null,
  forked_from_message_id: null,
};

const MD_FILE = "docs/schema.md";

const SNAPSHOT: TurnSnapshot = {
  id: "s1",
  message_id: "m-s1",
  thread_id: THREAD.id,
  ref_before: "aaaaaaa",
  ref_after: "bbbbbbb",
  files_changed: [MD_FILE],
  worktree_path: null,
  created_at: now,
};

// A unified diff that adds a markdown file whose body contains a mermaid
// erDiagram fence (the exact shape from the bug report). Built with plain
// strings so the triple backticks don't collide with the template literal.
const MERMAID_MD_DIFF = [
  "@@ -0,0 +1,11 @@",
  "+# Database Schema",
  "+",
  "+```mermaid",
  "+erDiagram",
  "+    USER ||--o{ ORDER : places",
  "+    ORDER ||--|{ LINE_ITEM : contains",
  "+```",
  "+",
  "+## Relationships",
  "+",
  "+The diagram shows the core entities.",
].join("\n");

const SETTINGS = getDefaultSettings();

/** Seeds the active thread + turn snapshot and opens the Changes tab. */
async function openThreadChanges(page: Page): Promise<void> {
  await page.evaluate(
    ({ workspace, thread, wid, tid, snapshot }) => {
      const stores: unknown[] =
        (window as unknown as { __mcodeStores?: unknown[] }).__mcodeStores ?? [];
      const getState = (s: unknown) =>
        (s as { getState: () => Record<string, unknown> }).getState();
      const wsStore = stores.find(
        (s) => "activeThreadId" in getState(s) && "threads" in getState(s),
      );
      (wsStore as { setState: (p: unknown) => void } | undefined)?.setState({
        workspaces: [workspace],
        activeWorkspaceId: workspace.id,
        threads: [thread],
        activeThreadId: tid,
      });
      const diffStore = stores.find(
        (s) => "showRightPanel" in getState(s) && "setSnapshots" in getState(s),
      );
      const api = (
        diffStore as {
          getState: () => {
            setSnapshots: (id: string, snaps: unknown) => void;
            showRightPanel: (id: string, threadId?: string) => void;
            setRightPanelTab: (id: string, t: string) => void;
          };
        }
      ).getState();
      api.setSnapshots(tid, [snapshot]);
      api.showRightPanel(wid, tid);
      api.setRightPanelTab(wid, "changes");
    },
    { workspace: WORKSPACE, thread: THREAD, wid: WORKSPACE.id, tid: THREAD.id, snapshot: SNAPSHOT },
  );
}

test.describe("Diff preview: mermaid fences render as diagrams", () => {
  test.beforeEach(async ({ page }) => {
    await mockWebSocketServer(page, {
      "workspace.list": [WORKSPACE],
      "thread.list": [THREAD],
      "settings.get": SETTINGS,
      "snapshot.listByThread": [SNAPSHOT],
      "snapshot.getDiff": MERMAID_MD_DIFF,
      "snapshot.getCumulativeDiff": MERMAID_MD_DIFF,
      "diffSummary.get": null,
    });
    await interceptZustandStores(page);
    await page.setViewportSize({ width: 1920, height: 1000 });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () =>
        (window as unknown as { __mcodeHydrationComplete?: boolean })
          .__mcodeHydrationComplete === true,
      { timeout: 30_000 },
    );
  });

  test("renders the mermaid diagram instead of raw fenced code", async ({ page }) => {
    await openThreadChanges(page);

    // Switch to the Cumulative view, whose file list is the snapshot's
    // files_changed and whose per-file diff comes from getCumulativeDiff.
    const switcher = page.getByTestId("review-view-switcher");
    await expect(switcher).toBeVisible({ timeout: 5_000 });
    await switcher.click();
    await page.getByTestId("review-view-cumulative").click();
    await expect(switcher).toContainText("Cumulative");

    const fileRow = page.locator(`[data-review-file="${MD_FILE}"]`);
    await expect(fileRow).toBeVisible();

    // Expand the file to load and show its diff.
    await fileRow.locator("button").first().click();

    // Toggle the markdown Preview. The rail collapses to an icon strip; hover
    // expands it so the labelled action is reliably clickable.
    const rail = fileRow.locator('nav[aria-label="File actions"]');
    await expect(rail).toBeVisible();
    await rail.hover();
    await fileRow.getByRole("button", { name: "Show rendered preview" }).click();

    // The fix routes the fence to MermaidBlock. Wait for the lazy preview chunk
    // to mount its container (the "mermaid" header bar) rather than the raw
    // <pre><code class="language-mermaid"> the bug produced.
    await expect(fileRow.getByText("mermaid", { exact: true })).toBeVisible({
      timeout: 20_000,
    });

    // mermaid.render sets the diagram <svg> id to "mermaid-...". Scoping by that
    // id avoids matching the SideRail's lucide icon <svg>s — the real proof the
    // diagram drew rather than falling back to an error banner or raw code.
    await expect(fileRow.locator('svg[id^="mermaid-"]')).toBeVisible({
      timeout: 20_000,
    });

    // The bug's raw fallback must not survive.
    await expect(fileRow.locator("code.language-mermaid")).toHaveCount(0);

    await page.screenshot({
      path: "e2e/screenshots/demo-desktop/diff-preview-mermaid.png",
      fullPage: true,
    });
  });
});
