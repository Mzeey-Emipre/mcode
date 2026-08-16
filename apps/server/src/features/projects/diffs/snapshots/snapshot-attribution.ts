import { TurnFileEffectSummarySchema, type TurnFileEffectSummary } from "@mcode/contracts";

/** Minimal persisted snapshot fields needed to scope historical Git calculations. */
export interface SnapshotAttributionInput {
  files_changed: readonly string[] | string;
  file_effects?: TurnFileEffectSummary | string;
}

function parseFileEffects(value: SnapshotAttributionInput["file_effects"]): TurnFileEffectSummary | null {
  if (!value) return null;
  try {
    const parsed = TurnFileEffectSummarySchema().safeParse(
      typeof value === "string" ? JSON.parse(value) : value,
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function parseLegacyPaths(value: SnapshotAttributionInput["files_changed"]): string[] {
  if (Array.isArray(value)) return [...value];
  try {
    const parsed = JSON.parse(value as string) as unknown;
    return Array.isArray(parsed) ? parsed.filter((path): path is string => typeof path === "string") : [];
  } catch {
    return [];
  }
}

/** Return bounded workspace path groups authored in one turn, preserving rename pairs. */
export function attributedWorkspacePathGroups(snapshot: SnapshotAttributionInput): string[][] {
  const fileEffects = parseFileEffects(snapshot.file_effects);
  const groups = fileEffects && fileEffects.fileCount > 0
    ? fileEffects.effects.flatMap((effect) => (
        effect.scope === "workspace"
          ? [[effect.path, ...(effect.oldPath ? [effect.oldPath] : [])]]
          : []
      ))
    : parseLegacyPaths(snapshot.files_changed).map((path) => [path]);
  const bounded: string[][] = [];
  let pathCount = 0;
  for (const group of groups) {
    const uniqueGroup = [...new Set(group)];
    if (pathCount + uniqueGroup.length > 512) break;
    bounded.push(uniqueGroup);
    pathCount += uniqueGroup.length;
  }
  return bounded;
}

/** Return bounded workspace paths authored in one turn, including both sides of renames. */
export function attributedWorkspacePaths(snapshot: SnapshotAttributionInput): string[] {
  return [...new Set(attributedWorkspacePathGroups(snapshot).flat())];
}

/** Return distinct workspace path groups across turns while retaining rename relationships. */
export function collectAttributedWorkspacePathGroups(
  snapshots: readonly SnapshotAttributionInput[],
): string[][] {
  const seen = new Set<string>();
  return snapshots.flatMap(attributedWorkspacePathGroups).filter((group) => {
    const key = group.join("\0");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Return every distinct workspace path authored across the supplied turns. */
export function collectAttributedWorkspacePaths(
  snapshots: readonly SnapshotAttributionInput[],
): string[] {
  return [...new Set(collectAttributedWorkspacePathGroups(snapshots).flat())];
}
