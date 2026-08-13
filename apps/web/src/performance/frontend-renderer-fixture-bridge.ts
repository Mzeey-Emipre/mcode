import { useDiffStore } from "@/stores/diffStore";
import { createEmptyThreadRecord } from "@/stores/thread-record";
import { useThreadStore } from "@/stores/threadStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { resetWorkerForPerformance } from "@/lib/shiki-worker-client";
import {
  drainShikiPerformanceObservations,
  resetShikiPerformanceObservations,
  setShikiPerformanceCapture,
} from "./shiki-performance";

declare global {
  interface Window {
    __mcodeFrontendPerformanceModules?: {
      readonly workspaceStore: typeof useWorkspaceStore;
      readonly threadStore: typeof useThreadStore;
      readonly diffStore: typeof useDiffStore;
      readonly createEmptyThreadRecord: typeof createEmptyThreadRecord;
      readonly shikiPerformance: {
        readonly drain: typeof drainShikiPerformanceObservations;
        readonly reset: typeof resetShikiPerformanceObservations;
        readonly setCapture: typeof setShikiPerformanceCapture;
        readonly resetWorker: typeof resetWorkerForPerformance;
      };
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
    shikiPerformance: {
      drain: drainShikiPerformanceObservations,
      reset: resetShikiPerformanceObservations,
      setCapture: setShikiPerformanceCapture,
      resetWorker: resetWorkerForPerformance,
    },
  };
}
