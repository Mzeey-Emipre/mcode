#!/usr/bin/env bun

import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";

const PAGE_SIZE = 100;
const MAX_RELEASES = 1_000;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const NUMERIC_IDENTIFIER = "(0|[1-9]\\d*)";
const STABLE_TAG_PATTERN = new RegExp(
  `^mcode-v${NUMERIC_IDENTIFIER}\\.${NUMERIC_IDENTIFIER}\\.${NUMERIC_IDENTIFIER}$`,
);
const NIGHTLY_TAG_PATTERN = new RegExp(
  `^v${NUMERIC_IDENTIFIER}\\.${NUMERIC_IDENTIFIER}\\.${NUMERIC_IDENTIFIER}-nightly\\.(\\d{8})\\.${NUMERIC_IDENTIFIER}$`,
);

function defaultGh(args) {
  return NodeChildProcess.execFileSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
}

function defaultIo() {
  return {
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
  };
}

function parseArguments(argv) {
  const parsed = { apply: false };
  const seen = new Set();

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    assertSupportedArgument(argument);
    assertUniqueArgument(seen, argument);
    seen.add(argument);

    if (argument === "--apply") {
      parsed.apply = true;
      continue;
    }

    const value = readArgumentValue(argv, index, argument);
    parsed[argument === "--repo" ? "repo" : "stableTag"] = value;
    index += 1;
  }

  validateRequiredArguments(parsed);
  return parsed;
}

function assertSupportedArgument(argument) {
  if (!["--repo", "--stable-tag", "--apply"].includes(argument)) {
    throw new Error(`Unknown argument: ${argument}`);
  }
}

function assertUniqueArgument(seen, argument) {
  if (seen.has(argument)) throw new Error(`Duplicate argument: ${argument}`);
}

function readArgumentValue(argv, index, argument) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${argument}`);
  return value;
}

function validateRequiredArguments(parsed) {
  if (!parsed.repo || !parsed.stableTag) {
    throw new Error("Both --repo and --stable-tag are required.");
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(parsed.repo)) {
    throw new Error("--repo must be an owner/name pair.");
  }
}

function callApi(gh, method, endpoint) {
  const output = gh(["api", "--method", method, endpoint]);
  if (method === "DELETE") {
    return undefined;
  }

  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`GitHub returned invalid JSON for ${endpoint}.`);
  }
}

function parseTimestamp(value, field) {
  if (typeof value !== "string") {
    throw new Error(`${field} must be a timestamp.`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`${field} must be a valid timestamp.`);
  }
  return timestamp;
}

function parseVersion(match) {
  return match.slice(1, 4).map((part) => BigInt(part));
}

function compareVersions(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return 0;
}

function isCalendarDate(value) {
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  if (year === 0 || month === 0 || day === 0) {
    return false;
  }

  const timestamp = Date.parse(
    `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T00:00:00Z`,
  );
  return (
    Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString().slice(0, 10) ===
      `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
  );
}

function validateStableRelease(release, expectedTag) {
  if (!release || typeof release !== "object" || Array.isArray(release)) {
    throw new Error("GitHub did not return a stable release object.");
  }
  if (release.tag_name !== expectedTag) {
    throw new Error(
      `Stable release tag ${String(release.tag_name)} does not match ${expectedTag}.`,
    );
  }
  const tagMatch = STABLE_TAG_PATTERN.exec(release.tag_name);
  if (!tagMatch) {
    throw new Error("Stable tag must exactly match mcode-vX.Y.Z.");
  }
  if (release.draft !== false || release.prerelease !== false) {
    throw new Error("Stable release must be published and non-prerelease.");
  }

  return {
    version: parseVersion(tagMatch),
    publishedAt: parseTimestamp(
      release.published_at,
      "Stable release published_at",
    ),
  };
}

function isCandidate(release, stableVersion, cutoff) {
  if (!hasCandidateShape(release)) return false;
  const tagMatch = parseNightlyTag(release.tag_name);
  if (!tagMatch || !hasEligibleVersion(tagMatch, stableVersion)) return false;
  return readCandidateCreationTime(release) < cutoff;
}

function hasCandidateShape(release) {
  return Boolean(
    release &&
    typeof release === "object" &&
    Number.isSafeInteger(release.id) &&
    release.id > 0 &&
    release.prerelease === true &&
    release.immutable === false,
  );
}

function parseNightlyTag(tag) {
  if (typeof tag !== "string") return null;
  const match = NIGHTLY_TAG_PATTERN.exec(tag);
  return match && isCalendarDate(match[4]) ? match : null;
}

function hasEligibleVersion(tagMatch, stableVersion) {
  return compareVersions(parseVersion(tagMatch), stableVersion) <= 0;
}

function readCandidateCreationTime(release) {
  try {
    return parseTimestamp(release.created_at, "Nightly created_at");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function listReleases(gh, repo) {
  const releases = [];
  const pageCount = MAX_RELEASES / PAGE_SIZE;

  for (let page = 1; page <= pageCount; page += 1) {
    const endpoint = `repos/${repo}/releases?per_page=${PAGE_SIZE}&page=${page}`;
    const response = callApi(gh, "GET", endpoint);
    if (!Array.isArray(response)) {
      throw new Error(`GitHub returned a non-array release page ${page}.`);
    }
    releases.push(...response);
    if (response.length < PAGE_SIZE) {
      return releases;
    }
  }

  throw new Error(
    "Release enumeration reached the 1,000-release safety cap; refusing cleanup.",
  );
}

function printPlan(io, stableTag, cutoff, candidates) {
  io.stdout(`Stable tag: ${stableTag}`);
  io.stdout(`Cutoff: ${new Date(cutoff).toISOString()}`);
  io.stdout(`Candidates (${candidates.length}):`);
  for (const candidate of candidates) {
    io.stdout(`  ${candidate.tag_name}`);
  }
}

function applyPlan({ candidates, cutoff, gh, io, repo, stableVersion }) {
  for (const planned of candidates) {
    const endpoint = `repos/${repo}/releases/${planned.id}`;
    const current = callApi(gh, "GET", endpoint);
    if (
      !isCandidate(current, stableVersion, cutoff) ||
      current.id !== planned.id ||
      current.tag_name !== planned.tag_name
    ) {
      io.stdout(
        `Skipped ${planned.tag_name}: release no longer matches the cleanup plan.`,
      );
      continue;
    }

    try {
      callApi(gh, "DELETE", endpoint);
    } catch (error) {
      throw new Error(
        `Failed to delete release ${planned.id} (${planned.tag_name}): ${error.message}`,
      );
    }

    const tagEndpoint = `repos/${repo}/git/refs/tags/${encodeURIComponent(planned.tag_name)}`;
    try {
      callApi(gh, "DELETE", tagEndpoint);
    } catch (error) {
      throw new Error(
        `Release ${planned.id} was deleted, but exact tag ${planned.tag_name} was not: ${error.message}`,
      );
    }
    io.stdout(`Deleted release and tag: ${planned.tag_name}`);
  }
}

/**
 * Runs the superseded-nightly cleanup CLI with injectable GitHub and I/O seams.
 */
export function main(argv, { gh = defaultGh, io = defaultIo() } = {}) {
  try {
    const { repo, stableTag, apply } = parseArguments(argv);
    const stableEndpoint = `repos/${repo}/releases/tags/${encodeURIComponent(stableTag)}`;
    const stableRelease = callApi(gh, "GET", stableEndpoint);
    const { version: stableVersion, publishedAt } = validateStableRelease(
      stableRelease,
      stableTag,
    );
    const cutoff = publishedAt - RETENTION_MS;
    const candidates = listReleases(gh, repo).filter((release) =>
      isCandidate(release, stableVersion, cutoff),
    );

    printPlan(io, stableTag, cutoff, candidates);
    if (!apply) {
      io.stdout("Dry run: no releases or tags were deleted.");
      return 0;
    }

    applyPlan({ candidates, cutoff, gh, io, repo, stableVersion });
    return 0;
  } catch (error) {
    io.stderr(`Cleanup failed: ${error.message}`);
    return 1;
  }
}

if (import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
