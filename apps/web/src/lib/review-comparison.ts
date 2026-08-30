import type { FileEffect, ReviewFileChange, TurnSnapshot } from "@mcode/contracts";

function fromEffect(effect: FileEffect): ReviewFileChange | null {
  if (effect.scope !== "workspace") return null;
  return {
    path: effect.path,
    previousPath: effect.kind === "renamed" ? (effect.oldPath ?? null) : null,
    changeType:
      effect.kind === "added"
        ? "added"
        : effect.kind === "removed"
          ? "deleted"
          : effect.kind === "renamed"
            ? "renamed"
            : "modified",
    binary: effect.binary,
  };
}

/** Resolve the file metadata for one persisted turn snapshot. */
export function reviewFilesForSnapshot(snapshot: TurnSnapshot): ReviewFileChange[] {
  const effects = snapshot.file_effects?.effects
    .map(fromEffect)
    .filter((effect): effect is ReviewFileChange => effect !== null);
  if (effects && effects.length > 0) return effects;
  return snapshot.files_changed.map((path) => ({
    path,
    previousPath: null,
    changeType: "modified" as const,
    binary: false,
  }));
}

function mergeBinary(prior: ReviewFileChange | undefined, change: ReviewFileChange): boolean {
  return prior?.binary === true || change.binary;
}

function applyRenamedChange(
  current: Map<string, ReviewFileChange>,
  change: ReviewFileChange,
): void {
  if (!change.previousPath) return;
  const prior = current.get(change.previousPath);
  current.delete(change.previousPath);
  if (prior?.changeType === "added") {
    current.set(change.path, {
      ...change,
      previousPath: null,
      changeType: "added",
      binary: mergeBinary(prior, change),
    });
    return;
  }
  current.set(change.path, {
    ...change,
    previousPath: prior?.previousPath ?? change.previousPath,
    binary: mergeBinary(prior, change),
  });
}

function applyDeletedChange(
  current: Map<string, ReviewFileChange>,
  change: ReviewFileChange,
): void {
  const prior = current.get(change.path);
  if (prior?.changeType === "added") {
    current.delete(change.path);
    return;
  }
  if (prior?.changeType === "renamed" && prior.previousPath) {
    current.delete(change.path);
    current.set(prior.previousPath, {
      path: prior.previousPath,
      previousPath: null,
      changeType: "deleted",
      binary: mergeBinary(prior, change),
    });
    return;
  }
  current.set(change.path, change);
}

function applyCurrentFileChange(
  current: Map<string, ReviewFileChange>,
  change: ReviewFileChange,
): void {
  const prior = current.get(change.path);
  if (change.changeType === "added" && prior?.changeType === "deleted") {
    current.set(change.path, { ...change, changeType: "modified" });
    return;
  }
  if (prior?.changeType === "added") {
    current.set(change.path, { ...prior, binary: mergeBinary(prior, change) });
    return;
  }
  current.set(change.path, {
    ...change,
    changeType: change.changeType === "added" ? "added" : "modified",
    binary: mergeBinary(prior, change),
  });
}

function applyReviewFileChange(
  current: Map<string, ReviewFileChange>,
  change: ReviewFileChange,
): void {
  if (change.changeType === "renamed" && change.previousPath) {
    applyRenamedChange(current, change);
    return;
  }
  if (change.changeType === "deleted") {
    applyDeletedChange(current, change);
    return;
  }
  applyCurrentFileChange(current, change);
}

function resolveAuthoritativeFileChange(
  current: ReadonlyMap<string, ReviewFileChange>,
  path: string,
): ReviewFileChange {
  const change = current.get(path);
  if (!change) return { path, previousPath: null, changeType: "modified", binary: false };
  if (change.changeType === "renamed" && change.previousPath === path) {
    return { ...change, previousPath: null, changeType: "modified" };
  }
  return change;
}

/** Decorate the authoritative first-ref to final-ref file set with persisted turn metadata. */
export function cumulativeReviewFiles(
  snapshots: readonly TurnSnapshot[],
  authoritativePaths: readonly string[],
): ReviewFileChange[] {
  const current = new Map<string, ReviewFileChange>();
  for (const snapshot of snapshots) {
    for (const change of reviewFilesForSnapshot(snapshot)) {
      applyReviewFileChange(current, change);
    }
  }
  return [...new Set(authoritativePaths)]
    .sort((left, right) => left.localeCompare(right))
    .map((path) => resolveAuthoritativeFileChange(current, path));
}
