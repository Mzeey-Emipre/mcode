import { create } from "zustand";

/** Lifecycle state used by the DEV-only child-continuation prototype. */
export type ChildContinuationPrototypeLifecycle = "started" | "working" | "finished";

/** One synthetic child agent shown by the child-continuation prototype. */
export interface ChildContinuationPrototypeChild {
  readonly id: string;
  readonly identity: string;
  readonly task: string;
  readonly lifecycle: ChildContinuationPrototypeLifecycle;
  readonly startOrder: number;
  readonly completedOrder?: number;
  readonly activity: string;
}

/** Shared state for the child timeline, Thread Overview, and right-panel roster. */
export interface ChildContinuationPrototypeState {
  readonly children: readonly ChildContinuationPrototypeChild[];
  readonly completionSequence: number;
  readonly lastChildTransition: ChildContinuationPrototypeLifecycle | null;
  readonly parentStatus: "settled" | "continuing";
  readonly readingPosition: "tail" | "above";
  readonly hasUnreadChildResult: boolean;
  readonly selectedChildId: string | null;
}

/** A child row projected into the production-shaped roster surfaces. */
export interface ChildContinuationPrototypeRosterRow {
  readonly id: string;
  readonly identity: string;
  readonly hasExplicitIdentity: true;
  readonly task: string;
  readonly lifecycle: ChildContinuationPrototypeLifecycle;
  readonly activity: string;
}

/** Active and finished rows for the Thread Overview and Subagents panel. */
export interface ChildContinuationPrototypeRoster {
  readonly active: readonly ChildContinuationPrototypeRosterRow[];
  readonly finished: readonly ChildContinuationPrototypeRosterRow[];
}

interface ChildContinuationPrototypeActions {
  advanceSchemaScan: () => void;
  setParentContinuing: () => void;
  setReadingPosition: (position: ChildContinuationPrototypeState["readingPosition"]) => void;
  selectChild: (childId: string | null) => void;
  reset: () => void;
}

/** Zustand state and actions shared by the DEV prototype surfaces. */
export type ChildContinuationPrototypeStore = ChildContinuationPrototypeState & ChildContinuationPrototypeActions;

const INITIAL_CHILDREN: readonly ChildContinuationPrototypeChild[] = [
  {
    id: "rollback-check",
    identity: "Rollback check",
    task: "Verify the down migration edge cases",
    lifecycle: "working",
    startOrder: 1,
    activity: "Checking index absence",
  },
  {
    id: "schema-scan",
    identity: "Schema scan",
    task: "Map the migration boundary",
    lifecycle: "started",
    startOrder: 2,
    activity: "Queued initial checks",
  },
  {
    id: "test-runner",
    identity: "Test runner",
    task: "Exercise migration rollback tests",
    lifecycle: "working",
    startOrder: 3,
    activity: "Running rollback tests",
  },
  {
    id: "api-check",
    identity: "API check",
    task: "Verify the migration boundary in the API",
    lifecycle: "working",
    startOrder: 4,
    activity: "Comparing generated schema",
  },
  {
    id: "docs-scan",
    identity: "Docs scan",
    task: "Check migration notes for compatibility warnings",
    lifecycle: "finished",
    startOrder: 5,
    completedOrder: 1,
    activity: "Result available",
  },
];

/** Returns a fresh initial state so reset never shares mutable child arrays. */
export function createChildContinuationPrototypeInitialState(): ChildContinuationPrototypeState {
  return {
    children: INITIAL_CHILDREN.map((child) => ({ ...child })),
    completionSequence: 1,
    lastChildTransition: null,
    parentStatus: "settled",
    readingPosition: "tail",
    hasUnreadChildResult: false,
    selectedChildId: null,
  };
}

/** Projects shared prototype state into the production roster ordering. */
export function projectChildContinuationPrototypeRoster(
  state: ChildContinuationPrototypeState,
): ChildContinuationPrototypeRoster {
  const toRow = (child: ChildContinuationPrototypeChild): ChildContinuationPrototypeRosterRow => ({
    id: child.id,
    identity: child.identity,
    hasExplicitIdentity: true,
    task: child.task,
    lifecycle: child.lifecycle,
    activity: child.activity,
  });
  return {
    active: state.children
      .filter((child) => child.lifecycle !== "finished")
      .sort((left, right) => left.startOrder - right.startOrder)
      .map(toRow),
    finished: state.children
      .filter((child) => child.lifecycle === "finished")
      .sort((left, right) => (right.completedOrder ?? 0) - (left.completedOrder ?? 0))
      .map(toRow),
  };
}

/** Shared DEV-only store for the parent timeline and Sub-agents right panel. */
export const useChildContinuationPrototypeStore = create<ChildContinuationPrototypeStore>((set, get) => ({
  ...createChildContinuationPrototypeInitialState(),
  advanceSchemaScan: () => {
    const current = get();
    const target = current.children.find((child) => child.id === "schema-scan") ?? current.children[0];
    const nextLifecycle: ChildContinuationPrototypeLifecycle = target.lifecycle === "started"
      ? "working"
      : target.lifecycle === "working"
        ? "finished"
        : "started";
    const nextSequence = nextLifecycle === "finished"
      ? current.completionSequence + 1
      : current.completionSequence;
    const activity = nextLifecycle === "started"
      ? "Queued initial checks"
      : nextLifecycle === "working"
        ? "Checking index absence"
        : "Result available";
    set({
      children: current.children.map((child) => child.id === target.id
        ? {
          ...child,
          lifecycle: nextLifecycle,
          activity,
          completedOrder: nextLifecycle === "finished" ? nextSequence : undefined,
        }
        : child),
      completionSequence: nextSequence,
      lastChildTransition: nextLifecycle,
      hasUnreadChildResult: current.readingPosition === "above",
    });
  },
  setParentContinuing: () => set({ parentStatus: "continuing", lastChildTransition: null }),
  setReadingPosition: (readingPosition) => set({
    readingPosition,
    ...(readingPosition === "tail" ? { hasUnreadChildResult: false } : {}),
  }),
  selectChild: (selectedChildId) => set({ selectedChildId }),
  reset: () => set(createChildContinuationPrototypeInitialState()),
}));
