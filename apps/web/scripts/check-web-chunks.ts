import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";

const EAGER_CHUNK_MAX_GZIP_BYTES = 500 * 1_024;
const DIST_DIRECTORY = NodePath.resolve(import.meta.dirname, "../dist");
const MANIFEST_PATH = NodePath.join(DIST_DIRECTORY, ".vite/manifest.json");
const REQUIRED_DYNAMIC_ENTRIES = [
  "src/components/pull-requests/PullRequestSurface.tsx",
  "src/components/pull-requests/PullRequestCode.tsx",
  "src/components/pull-requests/RemoteMarkdownRenderer.tsx",
] as const;

interface ManifestChunk {
  file: string;
  imports?: string[];
  dynamicImports?: string[];
  isEntry?: boolean;
  isDynamicEntry?: boolean;
  src?: string;
}

type ViteManifest = Record<string, ManifestChunk>;

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function readManifest(): ViteManifest {
  if (!NodeFS.existsSync(MANIFEST_PATH)) {
    fail(`Vite manifest is missing at ${MANIFEST_PATH}. Run the web build first.`);
  }
  return JSON.parse(NodeFS.readFileSync(MANIFEST_PATH, "utf8")) as ViteManifest;
}

function collectStaticGraph(manifest: ViteManifest): Set<string> {
  const pending = Object.entries(manifest)
    .filter(([, chunk]) => chunk.isEntry)
    .map(([key]) => key);
  if (pending.length === 0) fail("Vite manifest does not contain an application entry.");

  const visited = new Set<string>();
  while (pending.length > 0) {
    const key = pending.pop();
    if (!key || visited.has(key)) continue;
    const chunk = manifest[key];
    if (!chunk) fail(`Vite manifest references a missing static import: ${key}`);
    visited.add(key);
    pending.push(...(chunk.imports ?? []));
  }
  return visited;
}

function gzipBytes(file: string): number {
  const filePath = NodePath.join(DIST_DIRECTORY, file);
  if (!NodeFS.existsSync(filePath)) fail(`Built chunk is missing at ${filePath}`);
  return NodeZlib.gzipSync(NodeFS.readFileSync(filePath), { level: 9 }).byteLength;
}

const manifest = readManifest();
const eagerKeys = collectStaticGraph(manifest);
const failures: string[] = [];
const eagerReport = [...eagerKeys]
  .map((key) => {
    const chunk = manifest[key];
    if (!chunk) fail(`Vite manifest entry disappeared while reading: ${key}`);
    const bytes = gzipBytes(chunk.file);
    if (bytes > EAGER_CHUNK_MAX_GZIP_BYTES) {
      failures.push(
        `${chunk.file} is ${bytes.toLocaleString()} gzip bytes, above ${EAGER_CHUNK_MAX_GZIP_BYTES.toLocaleString()}.`,
      );
    }
    return { file: chunk.file, gzipBytes: bytes };
  })
  .sort((left, right) => right.gzipBytes - left.gzipBytes);

for (const source of REQUIRED_DYNAMIC_ENTRIES) {
  const entry = manifest[source];
  if (!entry) {
    failures.push(`The required pull request split point is missing from the manifest: ${source}`);
    continue;
  }
  if (!entry.isDynamicEntry || eagerKeys.has(source)) {
    failures.push(`The pull request split point is eagerly reachable: ${source}`);
  }
}

const eagerPullRequestSources = [...eagerKeys].filter((key) =>
  key.includes("/pull-requests/"),
);
if (eagerPullRequestSources.length > 0) {
  failures.push(
    `Pull request UI entered the eager graph: ${eagerPullRequestSources.join(", ")}`,
  );
}

if (failures.length > 0) {
  fail(["Web chunk performance gate failed:", ...failures.map((item) => `- ${item}`)].join("\n"));
}

process.stdout.write(
  `${JSON.stringify({
    eagerChunkLimitGzipBytes: EAGER_CHUNK_MAX_GZIP_BYTES,
    eagerChunks: eagerReport,
    dynamicPullRequestEntries: REQUIRED_DYNAMIC_ENTRIES,
  })}\n`,
);
