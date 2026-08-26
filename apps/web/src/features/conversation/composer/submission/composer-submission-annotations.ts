import type { PreviewAnnotationBundle } from "@mcode/contracts";
import { usePreviewAnnotationStore } from "@/features/preview/state/previewAnnotationStore";
import { usePreviewDesignModeStore } from "@/features/preview/state/previewDesignModeStore";

/** Annotation lifecycle operations around a single immediate Composer dispatch. */
export interface ComposerAnnotationDispatchGuard {
  clearBeforeDispatch(): void;
  restoreAfterFailure(): void;
  stopWatching(): void;
}

/** Preserves annotations when transport fails unless the user changed them meanwhile. */
export function createComposerAnnotationDispatchGuard(
  annotationScopeId: string | undefined,
  annotations: PreviewAnnotationBundle | undefined,
): ComposerAnnotationDispatchGuard {
  if (!annotationScopeId || !annotations) return EMPTY_ANNOTATION_DISPATCH_GUARD;

  let annotationsCleared = false;
  let annotationsChangedAfterClear = false;
  const stopWatching = usePreviewAnnotationStore.subscribe((state, previousState) => {
    if (annotationsCleared && annotationsChanged(state, previousState, annotationScopeId)) {
      annotationsChangedAfterClear = true;
    }
  });

  return {
    clearBeforeDispatch: () => {
      usePreviewAnnotationStore.getState().clearThread(annotationScopeId);
      usePreviewDesignModeStore.getState().setActive(annotationScopeId, false);
      annotationsCleared = true;
    },
    restoreAfterFailure: () => {
      stopWatching();
      if (!annotationsChangedAfterClear) restoreAnnotations(annotationScopeId, annotations);
    },
    stopWatching,
  };
}

const EMPTY_ANNOTATION_DISPATCH_GUARD: ComposerAnnotationDispatchGuard = {
  clearBeforeDispatch: () => {},
  restoreAfterFailure: () => {},
  stopWatching: () => {},
};

/** Detects a user edit to either annotation collection after the dispatch clear. */
function annotationsChanged(
  state: ReturnType<typeof usePreviewAnnotationStore.getState>,
  previousState: ReturnType<typeof usePreviewAnnotationStore.getState>,
  annotationScopeId: string,
): boolean {
  return (
    state.byThread[annotationScopeId] !== previousState.byThread[annotationScopeId]
    || state.diffByThread[annotationScopeId] !== previousState.diffByThread[annotationScopeId]
  );
}

/** Restores a failed dispatch's annotations and its associated design-mode state. */
function restoreAnnotations(
  annotationScopeId: string,
  annotations: PreviewAnnotationBundle,
): void {
  const restored = usePreviewAnnotationStore
    .getState()
    .restoreBundle(annotationScopeId, annotations);
  usePreviewDesignModeStore
    .getState()
    .setActive(annotationScopeId, restored && annotations.annotations.length > 0);
}
