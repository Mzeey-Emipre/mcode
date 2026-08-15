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
  const parse = (version: string) => {
    const [main, pre] = version.split("-", 2);
    const nums = main.split(".").map((part) => Number(part));
    return { nums, pre: pre ?? null };
  };
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < 3; index++) {
    const leftPart = left.nums[index] ?? 0;
    const rightPart = right.nums[index] ?? 0;
    if (leftPart !== rightPart) return leftPart > rightPart;
  }
  if (left.pre === null && right.pre !== null) return true;
  if (left.pre !== null && right.pre === null) return false;
  if (left.pre === null && right.pre === null) return false;

  const leftPrerelease = (left.pre as string).split(".");
  const rightPrerelease = (right.pre as string).split(".");
  for (let index = 0; index < Math.max(leftPrerelease.length, rightPrerelease.length); index++) {
    const leftPart = leftPrerelease[index];
    const rightPart = rightPrerelease[index];
    if (leftPart === undefined) return false;
    if (rightPart === undefined) return true;
    const leftNumber = Number(leftPart);
    const rightNumber = Number(rightPart);
    const leftIsNumber = !Number.isNaN(leftNumber);
    const rightIsNumber = !Number.isNaN(rightNumber);
    if (leftIsNumber && rightIsNumber) {
      if (leftNumber !== rightNumber) return leftNumber > rightNumber;
    } else if (leftIsNumber) {
      return false;
    } else if (rightIsNumber) {
      return true;
    } else if (leftPart !== rightPart) {
      return leftPart > rightPart;
    }
  }
  return false;
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
