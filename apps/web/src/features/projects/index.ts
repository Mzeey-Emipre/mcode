/** Public Projects feature surface for workbench composition. */
export { PathLabel } from "./PathLabel";
export { ProjectRow } from "./ProjectRow";
export { ProjectTree } from "./ProjectTree";
export { ProjectsView } from "./ProjectsView";
export {
  useWorkspaceStore,
} from "./state/workspaceStore";
export type { WorkspaceRpcCall } from "./state/workspaceStore";
export {
  getWorkspaceThread,
  readWorkspaceThread,
  useActiveWorkspaceThread,
  useInterruptedThreadIds,
  useParentThreadExists,
  useWorkspaceThread,
} from "./state/workspace-selectors";
export {
  useProjectSelectorStore,
} from "./state/projectSelectorStore";
export type { WorkspaceEnrichmentData } from "./state/projectSelectorStore";
