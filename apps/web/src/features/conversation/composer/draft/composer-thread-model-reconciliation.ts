import type { ComposerAgentSelection } from "./composer-selection-state";

/** Inputs that reconcile server thread-model changes with the active Composer selection. */
export interface ComposerThreadModelReconciliationInput {
  activeThreadModel: string | null | undefined;
  activeThreadProvider: string | null | undefined;
  threadSwitchPending: boolean;
  hasDraft: boolean;
  isRunning: boolean;
  lastServerThreadModelKey: string;
  selection: Pick<ComposerAgentSelection, "modelId" | "provider">;
}

/** The server-model bookkeeping and optional selection patch for one Composer render. */
export interface ComposerThreadModelReconciliation {
  serverModelKey: string | null;
  consumeThreadSwitch: boolean;
  selectionPatch: Partial<ComposerAgentSelection> | null;
}

function createServerModelKey(modelId: string, provider: string): string {
  return `${modelId}\0${provider}`;
}

function selectionMatchesServerModel(
  selection: Pick<ComposerAgentSelection, "modelId" | "provider">,
  modelId: string,
  provider: string,
): boolean {
  return selection.modelId === modelId && selection.provider === provider;
}

function shouldKeepDraftSelection(hasDraft: boolean, isRunning: boolean): boolean {
  return hasDraft && !isRunning;
}

function shouldKeepCurrentSelection(
  isRunning: boolean,
  serverRowChanged: boolean,
  selectionMatches: boolean,
): boolean {
  return !isRunning && !serverRowChanged && !selectionMatches;
}

function createServerSelectionPatch(
  modelId: string,
  provider: string | null | undefined,
): Partial<ComposerAgentSelection> {
  return {
    modelId,
    ...(provider ? { provider } : {}),
  };
}

/** Determines whether the server model should replace the current Composer selection. */
export function reconcileComposerThreadModel({
  activeThreadModel,
  activeThreadProvider,
  threadSwitchPending,
  hasDraft,
  isRunning,
  lastServerThreadModelKey,
  selection,
}: ComposerThreadModelReconciliationInput): ComposerThreadModelReconciliation {
  if (!activeThreadModel) {
    return { serverModelKey: null, consumeThreadSwitch: false, selectionPatch: null };
  }

  const serverProvider = activeThreadProvider ?? "claude";
  const serverModelKey = createServerModelKey(activeThreadModel, serverProvider);
  if (threadSwitchPending) {
    return { serverModelKey, consumeThreadSwitch: true, selectionPatch: null };
  }
  if (shouldKeepDraftSelection(hasDraft, isRunning)) {
    return { serverModelKey: null, consumeThreadSwitch: false, selectionPatch: null };
  }

  const serverRowChanged = lastServerThreadModelKey !== serverModelKey;
  const selectionMatches = selectionMatchesServerModel(selection, activeThreadModel, serverProvider);
  if (shouldKeepCurrentSelection(isRunning, serverRowChanged, selectionMatches)) {
    return { serverModelKey, consumeThreadSwitch: false, selectionPatch: null };
  }
  return {
    serverModelKey,
    consumeThreadSwitch: false,
    selectionPatch: createServerSelectionPatch(activeThreadModel, activeThreadProvider),
  };
}
