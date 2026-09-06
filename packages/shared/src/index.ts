// Logging
export { logger, getLogPath, getRecentLogs } from "./logging/index.js";

// Paths
export {
  getMcodeDir,
  spillWorkspaceDirSegment,
  isLinkedGitWorktree,
  resolveDbPath,
} from "./paths/index.js";
export {
  newHandoffUlid,
  resolveThreadHandoffsDir,
  resolveHandoffDir,
  resolveThreadAttachmentsDir,
} from "./paths/handoffs.js";

// Git utilities
export { createTextPatch } from "./git/text-patch.js";
export {
  validateWorktreeName,
  validateBranchName,
  sanitizeBranchForFolder,
} from "./git/index.js";

// Model effort normalization
export {
  isXhighEffortModel,
  isMaxEffortModel,
  supportsEffortParameter,
  supports1MContextWindow,
  supportsThinkingToggle,
  normalizeReasoningLevelForModel,
} from "./model-effort/index.js";

export { redactMcodeBrowserCaptureV2 } from "./browser-preview/redact.js";
