import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { main } from "../cleanup-superseded-nightlies.mjs";

const REPO = "Mzeey-Empire/mcode";
const STABLE_TAG = "mcode-v1.2.0";
const STABLE_RELEASE = {
  id: 900,
  tag_name: STABLE_TAG,
  draft: false,
  prerelease: false,
  published_at: "2026-01-15T12:00:00Z",
};

function nightly(overrides = {}) {
  return {
    id: 1,
    tag_name: "v1.2.0-nightly.20260101.1",
    draft: false,
    prerelease: true,
    created_at: "2026-01-01T00:00:00Z",
    published_at: "2026-01-01T01:00:00Z",
    immutable: false,
    ...overrides,
  };
}

function createHarness({ releases, refetched = new Map(), failAt } = {}) {
  const calls = [];
  const stdout = [];
  const stderr = [];

  const gh = (args) => {
    calls.push(args);
    const signature = args.join(" ");
    if (failAt && signature === failAt) {
      throw new Error("simulated GitHub failure");
    }
    const endpoint = args.at(-1);
    if (
      args.includes("--method") &&
      args[args.indexOf("--method") + 1] === "DELETE"
    ) {
      return "";
    }
    if (endpoint === `repos/${REPO}/releases/tags/${STABLE_TAG}`) {
      return JSON.stringify(STABLE_RELEASE);
    }
    if (endpoint === `repos/${REPO}/releases?per_page=100&page=1`) {
      return JSON.stringify(releases ?? []);
    }
    const releaseMatch = endpoint.match(/\/releases\/(\d+)$/);
    if (releaseMatch) {
      const id = Number(releaseMatch[1]);
      return JSON.stringify(
        refetched.get(id) ?? releases.find((release) => release.id === id),
      );
    }
    throw new Error(`Unexpected gh call: ${signature}`);
  };

  return {
    calls,
    stdout,
    stderr,
    gh,
    io: {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
  };
}

test("dry run selects only old superseded nightlies without mutating GitHub", () => {
  const eligiblePublished = nightly();
  const eligibleDraft = nightly({
    id: 2,
    tag_name: "v1.1.9-nightly.20251231.2",
    draft: true,
    published_at: null,
  });
  const releases = [
    eligiblePublished,
    eligibleDraft,
    nightly({
      id: 3,
      tag_name: "mcode-v1.1.0",
      prerelease: false,
    }),
    nightly({
      id: 4,
      tag_name: "nightly",
    }),
    nightly({
      id: 5,
      tag_name: "v1.2.0-nightly.20260108.5",
      created_at: "2026-01-08T12:00:00Z",
    }),
    nightly({
      id: 6,
      tag_name: "v1.2.0-nightly.20260109.6",
      created_at: "2026-01-09T00:00:00Z",
    }),
    nightly({
      id: 7,
      tag_name: "v1.3.0-nightly.20251201.7",
    }),
    nightly({
      id: 8,
      tag_name: "v1.0.0-nightly.20251201.8",
      immutable: true,
    }),
    nightly({
      id: 9,
      tag_name: "v01.2.0-nightly.20251201.9",
    }),
    nightly({
      id: 10,
      tag_name: "v1.2.0-nightly.20261340.10",
    }),
    nightly({
      id: 11,
      tag_name: "v1.2.0-nightly.20251201.01",
    }),
  ];
  const harness = createHarness({ releases });

  const result = main(["--repo", REPO, "--stable-tag", STABLE_TAG], {
    gh: harness.gh,
    io: harness.io,
  });

  assert.equal(result, 0);
  assert.deepEqual(harness.stdout, [
    `Stable tag: ${STABLE_TAG}`,
    "Cutoff: 2026-01-08T12:00:00.000Z",
    "Candidates (2):",
    "  v1.2.0-nightly.20260101.1",
    "  v1.1.9-nightly.20251231.2",
    "Dry run: no releases or tags were deleted.",
  ]);
  assert.equal(
    harness.calls.some((args) => args.includes("DELETE")),
    false,
  );
});

test("apply re-fetches candidates, skips stale plans, then deletes release before exact tag", () => {
  const first = nightly();
  const second = nightly({
    id: 2,
    tag_name: "v1.1.9-nightly.20251231.2",
  });
  const refetched = new Map([
    [first.id, { ...first, immutable: true }],
    [second.id, second],
  ]);
  const harness = createHarness({ releases: [first, second], refetched });

  const result = main(["--repo", REPO, "--stable-tag", STABLE_TAG, "--apply"], {
    gh: harness.gh,
    io: harness.io,
  });

  assert.equal(result, 0);
  assert.ok(
    harness.stdout.includes(
      "Skipped v1.2.0-nightly.20260101.1: release no longer matches the cleanup plan.",
    ),
  );
  const mutations = harness.calls.filter((args) => args.includes("DELETE"));
  assert.deepEqual(mutations, [
    ["api", "--method", "DELETE", `repos/${REPO}/releases/2`],
    [
      "api",
      "--method",
      "DELETE",
      `repos/${REPO}/git/refs/tags/v1.1.9-nightly.20251231.2`,
    ],
  ]);
});

test("apply explicitly skips malformed tags returned by candidate revalidation", () => {
  for (const malformedTag of [
    "v01.2.0-nightly.20251201.9",
    "v1.2.0-nightly.20261340.10",
    "v1.2.0-nightly.20251201.01",
  ]) {
    const planned = nightly();
    const harness = createHarness({
      releases: [planned],
      refetched: new Map([
        [planned.id, { ...planned, tag_name: malformedTag }],
      ]),
    });

    assert.equal(
      main(["--repo", REPO, "--stable-tag", STABLE_TAG, "--apply"], {
        gh: harness.gh,
        io: harness.io,
      }),
      0,
    );
    assert.ok(
      harness.stdout.includes(
        `Skipped ${planned.tag_name}: release no longer matches the cleanup plan.`,
      ),
      malformedTag,
    );
    assert.equal(
      harness.calls.some((args) => args.includes("DELETE")),
      false,
      malformedTag,
    );
  }
});

test("apply reports a partial failure and exits nonzero", () => {
  const release = nightly();
  const tagEndpoint = `repos/${REPO}/git/refs/tags/v1.2.0-nightly.20260101.1`;
  const harness = createHarness({
    releases: [release],
    failAt: `api --method DELETE ${tagEndpoint}`,
  });

  const result = main(["--repo", REPO, "--stable-tag", STABLE_TAG, "--apply"], {
    gh: harness.gh,
    io: harness.io,
  });

  assert.equal(result, 1);
  assert.match(
    harness.stderr.join("\n"),
    /Release 1 was deleted, but exact tag v1\.2\.0-nightly\.20260101\.1 was not/,
  );
});

test("invalid or ambiguous CLI arguments fail closed", () => {
  for (const argv of [
    [],
    ["--repo", REPO],
    ["--stable-tag", STABLE_TAG],
    ["--repo", REPO, "--repo", REPO, "--stable-tag", STABLE_TAG],
    ["--repo", REPO, "--stable-tag", STABLE_TAG, "--confirm"],
    ["--repo", REPO, "--stable-tag", STABLE_TAG, "--apply", "--apply"],
  ]) {
    const harness = createHarness({ releases: [] });
    assert.equal(main(argv, { gh: harness.gh, io: harness.io }), 1);
    assert.equal(harness.calls.length, 0);
  }
});

test("an invalid stable release fails before nightly enumeration", () => {
  const harness = createHarness({ releases: [] });
  harness.gh = (args) => {
    harness.calls.push(args);
    return JSON.stringify({ ...STABLE_RELEASE, prerelease: true });
  };

  assert.equal(
    main(["--repo", REPO, "--stable-tag", STABLE_TAG], {
      gh: harness.gh,
      io: harness.io,
    }),
    1,
  );
  assert.equal(harness.calls.length, 1);
});

test("malformed stable tags fail before release enumeration", () => {
  for (const stableTag of [
    "mcode-v01.2.0",
    "mcode-v1.02.0",
    "mcode-v1.2.00",
    "mcode-v1.2",
  ]) {
    const calls = [];
    const stderr = [];
    const gh = (args) => {
      calls.push(args);
      return JSON.stringify({
        ...STABLE_RELEASE,
        tag_name: stableTag,
      });
    };

    assert.equal(
      main(["--repo", REPO, "--stable-tag", stableTag], {
        gh,
        io: { stdout() {}, stderr: (line) => stderr.push(line) },
      }),
      1,
      stableTag,
    );
    assert.equal(calls.length, 1, stableTag);
    assert.match(stderr.join("\n"), /exactly match mcode-vX\.Y\.Z/, stableTag);
  }
});

test("a full tenth page reaches the enumeration cap and fails closed", () => {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    const endpoint = args.at(-1);
    if (endpoint.includes("/releases/tags/")) {
      return JSON.stringify(STABLE_RELEASE);
    }
    return JSON.stringify(
      Array.from({ length: 100 }, (_, index) =>
        nightly({
          id: Number(endpoint.match(/page=(\d+)/)[1]) * 100 + index,
          tag_name: `v1.2.0-nightly.20250101.${index + 1}`,
        }),
      ),
    );
  };
  const stderr = [];

  assert.equal(
    main(["--repo", REPO, "--stable-tag", STABLE_TAG], {
      gh,
      io: { stdout() {}, stderr: (line) => stderr.push(line) },
    }),
    1,
  );
  assert.match(stderr.join("\n"), /1,000-release safety cap/);
  assert.equal(calls.length, 11);
});

test("release workflows share the non-cancelling bounded mutation queue", () => {
  for (const path of [
    ".github/workflows/nightly-desktop.yml",
    ".github/workflows/release-please.yml",
  ]) {
    const workflow = readFileSync(path, "utf8");
    assert.match(
      workflow,
      /concurrency:\r?\n  group: nightly-release-mutations\r?\n  cancel-in-progress: false\r?\n  queue: max/,
      path,
    );
  }
});
