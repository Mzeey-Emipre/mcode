import { isGoalOpen } from "@mcode/contracts";
import type { GoalLookupResult, GoalState } from "@mcode/contracts";

/** Resolves a goal lookup result against the currently cached open goal. */
export function resolveGoalLookupGoal(
  lookup: GoalLookupResult,
  currentGoal: GoalState | null | undefined,
): GoalState | null {
  const goal = isGoalOpen(lookup.goal) ? lookup.goal : null;
  if (!goal && !lookup.authoritative && isGoalOpen(currentGoal)) return currentGoal;
  return goal;
}
