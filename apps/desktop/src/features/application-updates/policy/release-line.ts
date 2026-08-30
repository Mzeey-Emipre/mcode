/** Release line used to select the updater feed. */
export type ReleaseLine = "stable" | "nightly";

/** Updater fields controlled by the selected release line. */
export interface UpdaterChannelTarget {
  channel: string | null;
  allowPrerelease: boolean;
}

/** Map an application release line to its electron-updater channel. */
function releaseLineToUpdaterChannel(releaseLine: ReleaseLine): string {
  return releaseLine === "nightly" ? "nightly" : "latest";
}

/** Apply updater channel and prerelease settings for a release line. */
export function applyChannelConfig(
  updater: UpdaterChannelTarget,
  releaseLine: ReleaseLine,
): void {
  updater.channel = releaseLineToUpdaterChannel(releaseLine);
  updater.allowPrerelease = releaseLine === "nightly";
}

/** Compare two three-part semantic versions, including prerelease identifiers. */
function semverGt(a: string, b: string): boolean {
  return compareSemanticVersions(parseSemanticVersion(a), parseSemanticVersion(b)) > 0;
}

function parseSemanticVersion(version: string): { nums: number[]; pre: string | null } {
  const [main, pre] = version.split("-", 2);
  return { nums: main.split(".").map((part) => Number(part)), pre: pre ?? null };
}

function compareSemanticVersions(
  left: { nums: number[]; pre: string | null },
  right: { nums: number[]; pre: string | null },
): number {
  const mainComparison = compareMainVersion(left.nums, right.nums);
  if (mainComparison !== 0) return mainComparison;
  return comparePrerelease(left.pre, right.pre);
}

function compareMainVersion(left: number[], right: number[]): number {
  for (let index = 0; index < 3; index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function comparePrerelease(left: string | null, right: string | null): number {
  if (left === null) return right === null ? 0 : 1;
  if (right === null) return -1;
  return comparePrereleaseParts(left.split("."), right.split("."));
}

function comparePrereleaseParts(leftPrerelease: string[], rightPrerelease: string[]): number {
  for (let index = 0; index < Math.max(leftPrerelease.length, rightPrerelease.length); index++) {
    const comparison = comparePrereleasePart(leftPrerelease[index], rightPrerelease[index]);
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function comparePrereleasePart(left: string | undefined, right: string | undefined): number {
  if (left === undefined) return right === undefined ? 0 : -1;
  if (right === undefined) return 1;
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  const leftIsNumber = !Number.isNaN(leftNumber);
  const rightIsNumber = !Number.isNaN(rightNumber);
  if (leftIsNumber && rightIsNumber) return leftNumber - rightNumber;
  if (leftIsNumber) return -1;
  if (rightIsNumber) return 1;
  return left === right ? 0 : left > right ? 1 : -1;
}

/** Return whether a release-line switch would install an older stable build. */
export function isCrossChannelDowngrade(args: {
  from: ReleaseLine;
  to: ReleaseLine;
  currentVersion: string;
  latestStable: string | undefined;
}): boolean {
  if (args.from === args.to) return false;
  if (args.to !== "stable") return false;
  if (!args.latestStable) return false;
  return semverGt(args.currentVersion, args.latestStable);
}
