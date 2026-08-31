/**
 * Compare two version strings using semver precedence rules.
 *
 * Numeric segments compared numerically; presence-of-prerelease is less than
 * absence at the same MAJOR.MINOR.PATCH; mixed prerelease identifiers follow
 * semver §11.4 (numeric < alphanumeric, shorter prefix < longer when prefix
 * equal). Build metadata (`+...`) is not handled.
 *
 * @param a - First version
 * @param b - Second version
 * @returns true if `a > b`
 */
type ParsedSemver = { nums: number[]; pre: string | null };

function parseSemver(version: string): ParsedSemver {
  const [main, pre] = version.split("-", 2);
  return { nums: main.split(".").map((part) => Number(part)), pre: pre ?? null };
}

function comparePrereleasePart(left: string, right: string): number {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  const leftIsNumber = !Number.isNaN(leftNumber);
  const rightIsNumber = !Number.isNaN(rightNumber);
  if (leftIsNumber && rightIsNumber) return leftNumber - rightNumber;
  if (leftIsNumber) return -1;
  if (rightIsNumber) return 1;
  return left.localeCompare(right);
}

function prereleaseGt(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return left === null && right !== null;
  const leftParts = left.split(".");
  const rightParts = right.split(".");
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const leftPart = leftParts[index];
    const rightPart = rightParts[index];
    if (leftPart === undefined || rightPart === undefined) return rightPart === undefined;
    const comparison = comparePrereleasePart(leftPart, rightPart);
    if (comparison !== 0) return comparison > 0;
  }
  return false;
}

export function semverGt(a: string, b: string): boolean {
  const left = parseSemver(a);
  const right = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    const ai = left.nums[i] ?? 0;
    const bi = right.nums[i] ?? 0;
    if (ai !== bi) return ai > bi;
  }
  return prereleaseGt(left.pre, right.pre);
}
