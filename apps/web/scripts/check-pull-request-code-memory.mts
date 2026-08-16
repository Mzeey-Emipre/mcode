import {
  buildPullRequestDiffRowModel,
  releasePullRequestPatchRows,
} from "../src/features/pull-requests/lib/pull-request-diff-row-model.ts";

const MAX_CACHE_BYTES = 16 * 1024 * 1024;
const ITERATIONS = 3;

if (typeof globalThis.gc !== "function") {
  throw new Error("Run the pull request memory check with Node --expose-gc.");
}

function collect(): void {
  globalThis.gc?.();
  globalThis.gc?.();
}

function makeFile(id: string) {
  return {
    locator: `locator_${id}`,
    path: `src/${id}.ts`,
    previousPath: null,
    changeType: "modified" as const,
    additions: 19_999,
    deletions: 0,
    changes: 19_999,
    blobOid: "a".repeat(40),
    patchStatus: "available" as const,
  };
}

function makeResult(file: ReturnType<typeof makeFile>, patch: string, lineCount: number) {
  return {
    ok: true as const,
    locator: file.locator,
    path: file.path,
    previousPath: null,
    changeType: "modified" as const,
    blobOid: file.blobOid,
    baseOid: "b".repeat(40),
    headOid: "c".repeat(40),
    status: "available" as const,
    patch,
    parsedLineCount: lineCount,
    fetchedAt: "2026-07-11T10:00:00.000Z",
    staleAt: "2026-07-11T10:10:00.000Z",
  };
}

const warmFile = makeFile("warm");
const warmPatch = "@@ -0,0 +1,1 @@\n+x";
const warmResult = makeResult(warmFile, warmPatch, 2);
buildPullRequestDiffRowModel({
  snapshotKey: "warm",
  headOid: "c".repeat(40),
  files: [{
    file: warmFile,
    expanded: true,
    patchState: "available",
    patchResult: warmResult,
    threads: [],
    drafts: [],
  }],
});
releasePullRequestPatchRows(warmResult);

const file = makeFile("large");
const patch = [
  "@@ -0,0 +1,19999 @@",
  ...Array.from({ length: 19_999 }, (_, index) => `+value ${index}`),
].join("\n");
const result = makeResult(file, patch, 20_000);
const thread = {
  kind: "review_thread" as const,
  providerNodeId: "THREAD_MEMORY_CURRENT_LINE",
  path: file.path,
  line: 10_000,
  startLine: 10_000,
  side: "right" as const,
  startSide: "right" as const,
  originalLine: null,
  originalStartLine: null,
  subjectType: "line" as const,
  commitOid: "c".repeat(40),
  headOid: "c".repeat(40),
  isResolved: false,
  isOutdated: false,
  createdAt: "2026-07-11T10:00:00.000Z",
  updatedAt: "2026-07-11T10:00:00.000Z",
  totalCount: 0,
  comments: [],
};
const input = {
  snapshotKey: "snapshot-large",
  headOid: "c".repeat(40),
  files: [{
    file,
    expanded: true,
    patchState: "available" as const,
    patchResult: result,
    threads: [thread],
    drafts: [],
  }],
};
const rawBytes = new TextEncoder().encode(patch).byteLength;
const retainedDeltas: number[] = [];
let reportedBytes = 0;

function measureModel(): { retainedBytes: number; reportedBytes: number } {
  collect();
  const before = process.memoryUsage().heapUsed;
  const model = buildPullRequestDiffRowModel(input);
  collect();
  return {
    retainedBytes: process.memoryUsage().heapUsed - before,
    reportedBytes: model.parsedBytesByLocator.get(file.locator) ?? 0,
  };
}

for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
  const measurement = measureModel();
  retainedDeltas.push(measurement.retainedBytes);
  reportedBytes = measurement.reportedBytes;
  releasePullRequestPatchRows(result);
  collect();
}

const retainedBytes = Math.min(...retainedDeltas);
if (retainedBytes + rawBytes > MAX_CACHE_BYTES) {
  throw new Error(
    `Pull request Code retained ${retainedBytes + rawBytes} bytes, above ${MAX_CACHE_BYTES}.`,
  );
}
if (reportedBytes < retainedBytes) {
  throw new Error(
    `Pull request Code reported ${reportedBytes} bytes for ${retainedBytes} retained bytes.`,
  );
}

process.stdout.write(
  `${JSON.stringify({ retainedDeltas, retainedBytes, reportedBytes, rawBytes })}\n`,
);
