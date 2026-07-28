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

/** Decorate the authoritative first-ref to final-ref file set with persisted turn metadata. */
export function cumulativeReviewFiles(
  snapshots: readonly TurnSnapshot[],
  authoritativePaths: readonly string[],
): ReviewFileChange[] {
  const current = new Map<string, ReviewFileChange>();
  for (const snapshot of snapshots) {
    for (const change of reviewFilesForSnapshot(snapshot)) {
      if (change.changeType === "renamed" && change.previousPath) {
        const prior = current.get(change.previousPath);
        current.delete(change.previousPath);
        if (prior?.changeType === "added") {
          current.set(change.path, { ...change, previousPath: null, changeType: "added", binary: prior.binary || change.binary });
        } else {
          current.set(change.path, {
            ...change,
            previousPath: prior?.previousPath ?? change.previousPath,
            binary: prior?.binary === true || change.binary,
          });
        }
        continue;
      }

      const prior = current.get(change.path);
      if (change.changeType === "deleted") {
        if (prior?.changeType === "added") current.delete(change.path);
        else if (prior?.changeType === "renamed" && prior.previousPath) {
          current.delete(change.path);
          current.set(prior.previousPath, {
            path: prior.previousPath,
            previousPath: null,
            changeType: "deleted",
            binary: prior.binary || change.binary,
          });
        } else current.set(change.path, change);
        continue;
      }
      if (change.changeType === "added" && prior?.changeType === "deleted") {
        current.set(change.path, { ...change, changeType: "modified" });
        continue;
      }
      if (prior?.changeType === "added") {
        current.set(change.path, { ...prior, binary: prior.binary || change.binary });
        continue;
      }
      current.set(change.path, {
        ...change,
        changeType: change.changeType === "added" ? "added" : "modified",
        binary: prior?.binary === true || change.binary,
      });
    }
  }
  return [...new Set(authoritativePaths)].sort((left, right) => left.localeCompare(right)).map((path) => {
    const change = current.get(path);
    if (!change) {
      return { path, previousPath: null, changeType: "modified", binary: false };
    }
    if (change.changeType === "renamed" && change.previousPath === path) {
      return { ...change, previousPath: null, changeType: "modified" };
    }
    return change;
  });
}
