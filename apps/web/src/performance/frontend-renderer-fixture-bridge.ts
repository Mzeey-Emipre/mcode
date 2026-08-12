import { useDiffStore } from "@/stores/diffStore";
import { createEmptyThreadRecord } from "@/stores/thread-record";
import { useThreadStore } from "@/stores/threadStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";

declare global {
  interface Window {
    __mcodeFrontendPerformanceModules?: {
      readonly workspaceStore: typeof useWorkspaceStore;
      readonly threadStore: typeof useThreadStore;
      readonly diffStore: typeof useDiffStore;
      readonly createEmptyThreadRecord: typeof createEmptyThreadRecord;
    };
  }
}

/** Exposes the compiled store seam used by the maintained performance fixture. */
export function installFrontendRendererFixtureBridge(): void {
  window.__mcodeFrontendPerformanceModules = {
    workspaceStore: useWorkspaceStore,
    threadStore: useThreadStore,
    diffStore: useDiffStore,
    createEmptyThreadRecord,
  };
}
