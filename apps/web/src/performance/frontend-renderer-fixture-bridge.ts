import { useDiffStore } from "@/stores/diffStore";
import { createEmptyThreadRecord } from "@/stores/thread-record";
import { useThreadStore } from "@/stores/threadStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { resetWorkerForPerformance } from "@/lib/shiki-worker-client";
import { resetChatHighlightCoordinator } from "@/lib/chat-highlight-coordinator";
import { clearRecordCache } from "@/features/conversation/hydration/record-cache";
import {
  clearScrollMemory,
  forgetScrollTop,
  recallScrollPosition,
} from "@/components/chat/scrollPositionMemory";
import {
  drainShikiPerformanceObservations,
  resetShikiPerformanceObservations,
  setShikiPerformanceCapture,
} from "./shiki-performance";
import {
  drainMessageListPerformanceObservations,
  resetMessageListPerformanceObservations,
} from "./message-list-performance";

function resetShikiPerformanceWorker(): void {
  resetWorkerForPerformance();
  resetChatHighlightCoordinator();
}

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
        readonly resetWorker: typeof resetShikiPerformanceWorker;
      };
      readonly messageListPerformance: {
        readonly drain: typeof drainMessageListPerformanceObservations;
        readonly reset: typeof resetMessageListPerformanceObservations;
      };
      readonly recordCache: {
        readonly clear: typeof clearRecordCache;
      };
      readonly scrollMemory: {
        readonly clear: typeof clearScrollMemory;
        readonly forget: typeof forgetScrollTop;
        readonly recall: typeof recallScrollPosition;
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
      resetWorker: resetShikiPerformanceWorker,
    },
    messageListPerformance: {
      drain: drainMessageListPerformanceObservations,
      reset: resetMessageListPerformanceObservations,
    },
    recordCache: {
      clear: clearRecordCache,
    },
    scrollMemory: {
      clear: clearScrollMemory,
      forget: forgetScrollTop,
      recall: recallScrollPosition,
    },
  };
}
