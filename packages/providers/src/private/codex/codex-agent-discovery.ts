/**
 * Bounded compatibility discovery for selectable Codex agents.
 *
 * The adapter reads direct `.toml` files from two roots: `<CODEX_HOME>/agents`
 * and `<cwd>/.codex/agents`. `CODEX_HOME` and its home-directory fallback come
 * from the exact environment used to start Codex. Discovery never recurses,
 * visits at most the named directory-entry limit plus one overflow sentinel,
 * reads at most the named file-count limit, and reads one byte beyond the named
 * per-file limit only to detect oversize input. Each file is parsed as TOML;
 * only optional top-level string fields `name` and `description` affect the
 * suggestion. A missing name falls back to the filename. Rejected files produce
 * source-scoped diagnostics without exposing absolute paths, while valid siblings remain available.
 */
import { open, opendir } from "fs/promises";
import { basename, join } from "path";
import { parse } from "smol-toml";
import {
  PROVIDER_CATALOG_MAX_CODEX_AGENT_FILE_BYTES,
  PROVIDER_CATALOG_MAX_CODEX_AGENT_FILES,
  SelectableProviderAgentSchema,
  type SelectableProviderAgent,
  type ProviderCatalogSourceDiagnostic,
} from "@mcode/contracts";

/** Global directory name under the effective Codex home. */
export const CODEX_GLOBAL_AGENT_DIRECTORY = "agents";
/** Project directory segments under the effective working directory. */
export const CODEX_PROJECT_AGENT_DIRECTORY = [".codex", "agents"] as const;
/** Standalone discovery accepts direct files only. */
export const CODEX_AGENT_DISCOVERY_RECURSIVE = false;
/** Top-level TOML fields read by the compatibility adapter. */
export const CODEX_AGENT_TOML_FIELDS = ["name", "description"] as const;

/** One filesystem root accepted by standalone Codex agent discovery. */
export interface CodexAgentDiscoveryRoot {
  readonly scope: "global" | "project";
  readonly directory: string;
}

/** File limits per request and an entry-visit limit for each discovery root. */
export interface CodexAgentDiscoveryLimits {
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxDirectoryEntriesPerRoot?: number;
}

/** Directory entry shape needed by direct standalone discovery. */
export interface CodexAgentDirectoryEntry {
  readonly name: string;
  isFile(): boolean;
}

/** Result of one bounded agent-file read. */
export type CodexAgentFileReadResult =
  | { readonly status: "ok"; readonly body: string }
  | { readonly status: "oversized" }
  | { readonly status: "unreadable" };

/** Inputs for one bounded standalone Codex agent scan. */
export interface DiscoverCodexStandaloneAgentsInput {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
  readonly platform: NodeJS.Platform;
  readonly limits?: CodexAgentDiscoveryLimits;
  readonly readFile?: (path: string, maxBytes: number) => Promise<CodexAgentFileReadResult>;
  readonly openDirectory?: (path: string) => Promise<AsyncIterable<CodexAgentDirectoryEntry>>;
}

/** Valid suggestions plus isolated diagnostics from one bounded scan. */
export interface CodexStandaloneAgentDiscovery {
  readonly agents: readonly SelectableProviderAgent[];
  readonly diagnostics: readonly ProviderCatalogSourceDiagnostic[];
}

const DEFAULT_LIMITS: CodexAgentDiscoveryLimits = {
  maxFiles: PROVIDER_CATALOG_MAX_CODEX_AGENT_FILES,
  maxFileBytes: PROVIDER_CATALOG_MAX_CODEX_AGENT_FILE_BYTES,
};
const DIAGNOSTIC_SOURCE_MAX_CHARS = 256;

function nonEmptyEnvironmentPath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Resolves the global and project roots from the Codex spawn context. */
export function resolveCodexAgentDiscoveryRoots(
  environment: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
  cwd?: string,
): CodexAgentDiscoveryRoot[] {
  const codexHome = nonEmptyEnvironmentPath(environment.CODEX_HOME)
    ?? (() => {
      const home = platform === "win32"
        ? nonEmptyEnvironmentPath(environment.USERPROFILE)
          ?? nonEmptyEnvironmentPath(environment.HOME)
        : nonEmptyEnvironmentPath(environment.HOME)
          ?? nonEmptyEnvironmentPath(environment.USERPROFILE);
      return home ? join(home, ".codex") : undefined;
    })();
  const roots: CodexAgentDiscoveryRoot[] = [];
  if (codexHome) {
    roots.push({ scope: "global", directory: join(codexHome, CODEX_GLOBAL_AGENT_DIRECTORY) });
  }
  if (cwd) {
    roots.push({ scope: "project", directory: join(cwd, ...CODEX_PROJECT_AGENT_DIRECTORY) });
  }
  return roots.filter((root, index) => (
    roots.findIndex((candidate) => candidate.directory === root.directory) === index
  ));
}

function diagnosticSource(path: string): string {
  return basename(path)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, DIAGNOSTIC_SOURCE_MAX_CHARS) || "unknown agent source";
}

function discoveryDiagnostic(
  rejectedSource: string,
  message: string,
): ProviderCatalogSourceDiagnostic {
  return {
    sourceKind: "standaloneAgentAdapter",
    rejectedSource,
    severity: "warning",
    code: "discovery-error",
    message,
  };
}

function partialDiagnostic(
  rejectedSource: string,
  message: string,
): ProviderCatalogSourceDiagnostic {
  return {
    sourceKind: "standaloneAgentAdapter",
    rejectedSource,
    severity: "warning",
    code: "partial-result",
    message,
  };
}

async function readBoundedAgentFile(
  path: string,
  maxBytes: number,
): Promise<CodexAgentFileReadResult> {
  let file;
  try {
    file = await open(path, "r");
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let totalBytesRead = 0;
    while (totalBytesRead < buffer.length) {
      const { bytesRead } = await file.read(
        buffer,
        totalBytesRead,
        buffer.length - totalBytesRead,
        totalBytesRead,
      );
      if (bytesRead === 0) break;
      totalBytesRead += bytesRead;
    }
    if (totalBytesRead > maxBytes) return { status: "oversized" };
    return { status: "ok", body: buffer.subarray(0, totalBytesRead).toString("utf8") };
  } catch {
    return { status: "unreadable" };
  } finally {
    await file?.close().catch(() => undefined);
  }
}

function parseAgent(
  body: string,
  path: string,
  fallbackName: string,
): SelectableProviderAgent | undefined {
  const parsed = parse(body);
  const nameValue = parsed.name;
  const descriptionValue = parsed.description;
  if (nameValue !== undefined && typeof nameValue !== "string") return undefined;
  if (descriptionValue !== undefined && typeof descriptionValue !== "string") return undefined;
  const name = nameValue?.trim() || fallbackName;
  const agent = SelectableProviderAgentSchema().safeParse({
    providerId: "codex",
    nativeId: name,
    name,
    path,
    ...(descriptionValue?.trim() ? { description: descriptionValue.trim() } : {}),
  });
  return agent.success ? agent.data : undefined;
}

async function directTomlFiles(
  root: CodexAgentDiscoveryRoot,
  remainingFiles: number,
  maxDirectoryEntriesPerRoot: number,
  openDirectory: (path: string) => Promise<AsyncIterable<CodexAgentDirectoryEntry>>,
): Promise<{
  files: string[];
  excessiveFiles: boolean;
  excessiveEntries: boolean;
  diagnostic?: ProviderCatalogSourceDiagnostic;
}> {
  let directory;
  try {
    directory = await openDirectory(root.directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { files: [], excessiveFiles: false, excessiveEntries: false };
    }
    return {
      files: [],
      excessiveFiles: false,
      excessiveEntries: false,
      diagnostic: discoveryDiagnostic(
        `${root.scope} agents`,
        `Codex ${root.scope} agent directory could not be read.`,
      ),
    };
  }

  const files: string[] = [];
  let visitedEntries = 0;
  let excessiveFiles = false;
  let excessiveEntries = false;
  for await (const entry of directory) {
    visitedEntries += 1;
    if (visitedEntries > maxDirectoryEntriesPerRoot) {
      excessiveEntries = true;
      break;
    }
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".toml")) continue;
    if (files.length >= remainingFiles) {
      excessiveFiles = true;
      break;
    }
    files.push(join(root.directory, entry.name));
  }
  files.sort((left, right) => left.localeCompare(right));
  return { files, excessiveFiles, excessiveEntries };
}

/** Discovers standalone Codex agents without recursive or unbounded filesystem work. */
export async function discoverCodexStandaloneAgents(
  input: DiscoverCodexStandaloneAgentsInput,
): Promise<CodexStandaloneAgentDiscovery> {
  const scan = createCodexAgentScan(input);
  const roots = resolveCodexAgentDiscoveryRoots(input.environment, input.platform, input.cwd);
  for (const root of roots) {
    const outcome = await scanCodexAgentRoot(root, scan);
    if (outcome === "stop") break;
  }
  return {
    agents: [...scan.byName.values()].sort((left, right) => left.name.localeCompare(right.name)),
    diagnostics: scan.diagnostics,
  };
}

type CodexAgentScan = {
  limits: CodexAgentDiscoveryLimits;
  readFile: (path: string, maxBytes: number) => Promise<CodexAgentFileReadResult>;
  openDirectory: (path: string) => Promise<AsyncIterable<CodexAgentDirectoryEntry>>;
  maxDirectoryEntriesPerRoot: number;
  byName: Map<string, SelectableProviderAgent>;
  diagnostics: ProviderCatalogSourceDiagnostic[];
  inspectedFiles: number;
};

function createCodexAgentScan(input: DiscoverCodexStandaloneAgentsInput): CodexAgentScan {
  return {
    limits: input.limits ?? DEFAULT_LIMITS,
    readFile: input.readFile ?? readBoundedAgentFile,
    openDirectory: input.openDirectory ?? opendir,
    maxDirectoryEntriesPerRoot: input.limits?.maxDirectoryEntriesPerRoot ?? DEFAULT_LIMITS.maxFiles,
    byName: new Map<string, SelectableProviderAgent>(),
    diagnostics: [],
    inspectedFiles: 0,
  };
}

async function scanCodexAgentRoot(
  root: CodexAgentDiscoveryRoot,
  scan: CodexAgentScan,
): Promise<"next" | "stop"> {
  const listed = await directTomlFiles(
    root,
    Math.max(0, scan.limits.maxFiles - scan.inspectedFiles),
    scan.maxDirectoryEntriesPerRoot,
    scan.openDirectory,
  );
  if (listed.diagnostic) scan.diagnostics.push(listed.diagnostic);
  for (const path of listed.files) await scanCodexAgentFile(root, path, scan);
  if (listed.excessiveEntries) {
    scan.diagnostics.push(partialDiagnostic(
      `${root.scope} agents`,
      `Codex ${root.scope} agent directory was capped at ${scan.maxDirectoryEntriesPerRoot} direct directory ${scan.maxDirectoryEntriesPerRoot === 1 ? "entry" : "entries"}.`,
    ));
    return "next";
  }
  if (!listed.excessiveFiles) return "next";
  scan.diagnostics.push(partialDiagnostic(
    `${root.scope} agents`,
    `Codex ${root.scope} agent directory was capped at ${scan.limits.maxFiles} direct TOML ${scan.limits.maxFiles === 1 ? "file" : "files"}.`,
  ));
  return "stop";
}

async function scanCodexAgentFile(
  root: CodexAgentDiscoveryRoot,
  path: string,
  scan: CodexAgentScan,
): Promise<void> {
  scan.inspectedFiles += 1;
  const file = await scan.readFile(path, scan.limits.maxFileBytes).catch(
    (): CodexAgentFileReadResult => ({ status: "unreadable" }),
  );
  if (file.status !== "ok") {
    reportUnreadableCodexAgentFile(root, path, file.status, scan);
    return;
  }
  addParsedCodexAgent(root, path, file.body, scan);
}

function reportUnreadableCodexAgentFile(
  root: CodexAgentDiscoveryRoot,
  path: string,
  status: Exclude<CodexAgentFileReadResult["status"], "ok">,
  scan: CodexAgentScan,
): void {
  const source = diagnosticSource(path);
  if (status === "unreadable") {
    scan.diagnostics.push(discoveryDiagnostic(source, `Codex ${root.scope} agent file could not be read.`));
    return;
  }
  scan.diagnostics.push(partialDiagnostic(source, `Codex ${root.scope} agent file exceeded ${scan.limits.maxFileBytes} bytes and was omitted.`));
}

function addParsedCodexAgent(
  root: CodexAgentDiscoveryRoot,
  path: string,
  body: string,
  scan: CodexAgentScan,
): void {
  const fallbackName = path.split(/[\\/]/).at(-1)?.replace(/\.toml$/i, "") ?? "";
  try {
    const agent = parseAgent(body, path, fallbackName);
    if (!agent) throw new Error("invalid agent metadata");
    scan.byName.set(agent.name, agent);
  } catch {
    scan.diagnostics.push(discoveryDiagnostic(
      diagnosticSource(path),
      `Codex ${root.scope} agent file contained invalid TOML or agent metadata.`,
    ));
  }
}
