/** Minimal workspace-store surface used by the packaged Terminal release bootstrap. */
export interface TerminalReleaseTestWorkspaceState {
  readonly workspaces: readonly { readonly id: string }[];
  readonly activeWorkspaceId: string | null;
  readonly loadWorkspaces: () => Promise<void>;
  readonly setActiveWorkspace: (id: string) => void;
}

/** Return the current workspace-store state for the packaged Terminal release bootstrap. */
export type TerminalReleaseTestWorkspaceStateGetter =
  () => TerminalReleaseTestWorkspaceState;

/** Load and activate the deterministic first workspace for the packaged Terminal release test. */
export async function bootstrapTerminalReleaseTestWorkspace(
  getWorkspaceState: TerminalReleaseTestWorkspaceStateGetter,
): Promise<string> {
  await getWorkspaceState().loadWorkspaces();
  const workspaceState = getWorkspaceState();
  const firstWorkspace = workspaceState.workspaces[0];
  if (!firstWorkspace) {
    throw new Error("Terminal release-test workspace is missing");
  }
  if (workspaceState.activeWorkspaceId === null) {
    workspaceState.setActiveWorkspace(firstWorkspace.id);
  }
  return getWorkspaceState().activeWorkspaceId ?? firstWorkspace.id;
}
