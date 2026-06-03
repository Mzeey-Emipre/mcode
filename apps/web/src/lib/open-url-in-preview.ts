import { isMcodeWorkspacePreviewUrl } from "@mcode/contracts";
import type { BrowserTabInfo } from "@mcode/contracts";
import { useDiffStore } from "@/stores/diffStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";

/** Returns true when the event is a Ctrl+click (Windows/Linux) or Cmd+click (macOS). */
export function isModifierClick(e: { ctrlKey: boolean; metaKey: boolean }): boolean {
  return e.ctrlKey || e.metaKey;
}

/** Whether a URL can be loaded in the embedded preview panel. */
export function isPreviewableUrl(url: string): boolean {
  const trimmed = url.trim();
  if (isMcodeWorkspacePreviewUrl(trimmed)) return true;
  try {
    const { protocol } = new URL(trimmed);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

/** Options for {@link openUrlInPreview}. */
export interface OpenUrlInPreviewOptions {
  /** URL to load in the preview panel. */
  url: string;
  /** Thread that owns the preview session. */
  threadId: string;
  /** Workspace root used to resolve relative paths and mcode-workspace URLs. */
  workspacePath?: string | null;
  /**
   * When true (default), opens in a new preview tab so the active tab keeps
   * its current page.
   */
  newTab?: boolean;
}

function resolveWorkspacePath(explicit: string | null | undefined): string | null {
  if (explicit !== undefined) return explicit;
  const { activeWorkspaceId, workspaces } = useWorkspaceStore.getState();
  if (!activeWorkspaceId) return null;
  return workspaces.find((w) => w.id === activeWorkspaceId)?.path ?? null;
}

/**
 * True when a preview tab has no real page loaded yet. Mirrors the host-side
 * `guestUrlNeedsHttpRestore` check so empty tabs are reused instead of spawning
 * another blank tab.
 */
export function isEmptyPreviewTabUrl(url: string | null | undefined): boolean {
  if (!url || url.trim().length === 0) return true;
  const lower = url.trim().toLowerCase();
  if (lower === "about:blank") return true;
  if (lower.startsWith("about:")) return true;
  if (lower.startsWith("chrome-error:")) return true;
  return false;
}

/** Resolves the active tab from a tab set snapshot. */
function findActiveTab(
  tabs: readonly BrowserTabInfo[],
  activeTabId: string | null,
): BrowserTabInfo | undefined {
  if (activeTabId) {
    const byId = tabs.find((t) => t.id === activeTabId);
    if (byId) return byId;
  }
  return tabs.find((t) => t.active);
}

/**
 * Returns whether a modifier-open should create a new preview tab. Reuses the
 * active tab when it is still blank; opens a new tab when the active tab already
 * has a page loaded.
 */
async function shouldOpenInNewTab(
  threadId: string,
  tabsApi: NonNullable<NonNullable<typeof window.desktopBridge>["preview"]>["tabs"],
): Promise<boolean> {
  if (!tabsApi?.list) return false;

  const listed = await tabsApi.list(threadId);
  if (!listed.ok) return true;

  const active = findActiveTab(listed.data.tabs, listed.data.activeTabId);
  if (!active) return false;

  return !isEmptyPreviewTabUrl(active.url);
}

/**
 * Opens a URL in the embedded browser preview, optionally in a new tab so the
 * current preview tab keeps its page.
 */
export function openUrlInPreview({
  url,
  threadId,
  workspacePath,
  newTab = true,
}: OpenUrlInPreviewOptions): void {
  if (!isPreviewableUrl(url)) return;

  const preview = window.desktopBridge?.preview;
  if (!preview) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }

  const wsPath = resolveWorkspacePath(workspacePath);
  const { showRightPanel, setRightPanelTab, setPreviewUrlForThread } = useDiffStore.getState();
  showRightPanel(threadId);
  setRightPanelTab(threadId, "preview");

  const run = async (): Promise<void> => {
    const openInNewTab = newTab && (await shouldOpenInNewTab(threadId, preview.tabs));

    if (openInNewTab && preview.tabs?.create) {
      await preview.tabs.create(threadId, true);
    } else if (!openInNewTab) {
      setPreviewUrlForThread(threadId, url);
    }

    if (preview.navigate) {
      try {
        await preview.navigate(url, wsPath ?? undefined);
      } catch {
        setPreviewUrlForThread(threadId, url);
      }
    } else {
      setPreviewUrlForThread(threadId, url);
    }
  };

  // Defer until the preview panel has mounted and reported bounds.
  setTimeout(() => {
    void run();
  }, 0);
}

/**
 * Opens a GitHub HTTPS URL in the system browser when plain-clicked, or in the
 * embedded preview (new tab) when Ctrl/Cmd+clicked.
 */
export function openGitHubUrl(
  url: string,
  threadId: string,
  event?: { ctrlKey: boolean; metaKey: boolean },
): void {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") return;
    if (event && isModifierClick(event)) {
      openUrlInPreview({ url, threadId });
      return;
    }
    window.desktopBridge?.openExternalUrl(url);
  } catch {
    // Invalid URL - do nothing
  }
}
