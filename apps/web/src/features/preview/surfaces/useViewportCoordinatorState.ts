import { useCallback, useSyncExternalStore } from "react";
import {
  type ViewportCoordinator,
  type ViewportCoordinatorState,
} from "../automation/services/viewportCoordinator";

const snapshots = new WeakMap<ViewportCoordinator, ViewportCoordinatorState>();

function snapshotFor(
  coordinator: ViewportCoordinator,
): ViewportCoordinatorState {
  const cached = snapshots.get(coordinator);
  if (cached) return cached;
  const snapshot = coordinator.snapshot();
  snapshots.set(coordinator, snapshot);
  return snapshot;
}

/** Subscribes to a viewport coordinator without copying its state into an effect. */
export function useViewportCoordinatorState(
  coordinator: ViewportCoordinator | undefined,
  fallback: ViewportCoordinatorState,
): ViewportCoordinatorState {
  const subscribe = useCallback(
    (notify: () => void) => {
      if (!coordinator) return () => undefined;
      snapshots.set(coordinator, coordinator.snapshot());
      return coordinator.subscribe((snapshot) => {
        snapshots.set(coordinator, snapshot);
        notify();
      });
    },
    [coordinator],
  );
  const getSnapshot = useCallback(
    () => coordinator ? snapshotFor(coordinator) : fallback,
    [coordinator, fallback],
  );

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
