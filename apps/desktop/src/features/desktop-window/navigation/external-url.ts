import { ipcMain, shell } from "electron";
import { isMcodeWorkspacePreviewUrl } from "@mcode/contracts";

const EXTERNAL_PROTOCOLS = new Set(["https:", "http:", "mailto:"]);

/** The result of resolving a workspace-relative Preview URL. */
export type WorkspacePreviewUrlResolution =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly error: string };

/** Resolves a workspace-relative Preview URL through the Preview feature. */
export type WorkspacePreviewUrlResolver = (
  url: string,
  workspacePath: string | null,
) => Promise<WorkspacePreviewUrlResolution>;

/** Open an approved URL in the user's default system application. */
export function openExternalUrl(url: string): void {
  try {
    const parsed = new URL(url);
    if (EXTERNAL_PROTOCOLS.has(parsed.protocol)) {
      shell.openExternal(parsed.href).catch((error: unknown) => {
        console.error(
          `[openIfAllowed] Failed to open ${parsed.protocol} URL: ${parsed.href}`,
          error,
        );
      });
    }
  } catch {
    // Invalid URL, ignore.
  }
}

/** Register the renderer bridge handler for external and workspace Preview URLs. */
export function registerExternalUrlHandler(
  resolveWorkspacePreviewUrl: WorkspacePreviewUrlResolver,
): void {
  ipcMain.handle(
    "open-external-url",
    async (_event, url: unknown, workspacePath?: unknown) => {
      const trimmed = typeof url === "string" ? url.trim() : "";
      if (!trimmed) return;
      if (isMcodeWorkspacePreviewUrl(trimmed)) {
        const workspace =
          typeof workspacePath === "string" && workspacePath.trim().length > 0
            ? workspacePath.trim()
            : null;
        const resolved = await resolveWorkspacePreviewUrl(trimmed, workspace);
        if (!resolved.ok) return;
        void shell.openExternal(resolved.url).catch((error: unknown) => {
          console.error(
            `[open-external-url] Failed to open file URL: ${resolved.url}`,
            error,
          );
        });
        return;
      }
      openExternalUrl(trimmed);
    },
  );
}
