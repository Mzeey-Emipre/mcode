/**
 * Bounded compatibility adapter for deprecated Codex custom prompts.
 *
 * The adapter resolves its root from the `CODEX_HOME` value in the same
 * {@link EnvService} environment used to spawn Codex. When that value is not
 * set, it derives `<user home>/.codex` from that environment. Discovery reads
 * only direct regular `*.md` files under the `prompts` directory. It never
 * searches a workspace, recurses, or installs a filesystem watcher.
 *
 * Each file is bounded by {@link CODEX_CUSTOM_PROMPT_MAX_FILE_BYTES}, and each
 * refresh inspects at most {@link CODEX_CUSTOM_PROMPT_MAX_DIRECTORY_ENTRIES}
 * directory entries and {@link CODEX_CUSTOM_PROMPT_MAX_FILES} supported files.
 * Prompt bodies may begin with YAML frontmatter; only a string `description` field is used.
 * Invalid UTF-8, malformed frontmatter, unreadable files, and exceeded limits
 * produce source-scoped diagnostics without hiding valid sibling prompts.
 */

import { open, opendir } from "fs/promises";
import { homedir } from "os";
import { join, resolve } from "path";
import { inject, injectable } from "tsyringe";
import { parseDocument } from "yaml";
import type { ProviderCatalogSourceDiagnostic, SkillInfo } from "@mcode/contracts";
import { PROVIDER_CATALOG_PATH_MAX_CHARS } from "@mcode/contracts";
import { EnvService } from "../../../runtime/environment/env-service.js";

/** Environment variable whose value is Codex's effective configuration root. */
export const CODEX_HOME_ENVIRONMENT_VARIABLE = "CODEX_HOME";
/** Direct child directory of the effective Codex home containing custom prompts. */
export const CODEX_CUSTOM_PROMPT_DIRECTORY_NAME = "prompts";
/** Exact supported suffix for direct Codex custom prompt files. */
export const CODEX_CUSTOM_PROMPT_FILE_SUFFIX = ".md";
/** Maximum direct custom prompt files inspected during one refresh. */
export const CODEX_CUSTOM_PROMPT_MAX_FILES = 64;
/** Maximum direct directory entries inspected during one refresh. */
export const CODEX_CUSTOM_PROMPT_MAX_DIRECTORY_ENTRIES = 256;
/** Maximum bytes read from one custom prompt file. */
export const CODEX_CUSTOM_PROMPT_MAX_FILE_BYTES = 256 * 1_024;

const CODEX_CUSTOM_PROMPT_MAX_DIAGNOSTICS = CODEX_CUSTOM_PROMPT_MAX_FILES + 1;
const CODEX_CUSTOM_PROMPT_MAX_NAME_CHARS = 256;
const CODEX_CUSTOM_PROMPT_MAX_DESCRIPTION_CHARS = 2_000;
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/** File-count and per-file byte limits applied by custom prompt discovery. */
export interface CodexCustomPromptDiscoveryLimits {
  readonly maxFiles: number;
  readonly maxFileBytes: number;
}

/** Minimal filesystem boundary used by the custom prompt adapter. */
export interface CodexCustomPromptFileSystem {
  entries(directory: string): AsyncIterable<{ readonly name: string; readonly isFile: boolean }>;
  readFile(path: string, maxBytes: number): Promise<Buffer>;
}

/** Optional discovery limits and filesystem implementation. */
export interface CodexCustomPromptDiscoveryOptions extends CodexCustomPromptDiscoveryLimits {
  readonly maxDirectoryEntries?: number;
  readonly fileSystem?: CodexCustomPromptFileSystem;
}

/** Complete result of one bounded custom prompt directory refresh. */
export interface CodexCustomPromptDiscoveryResult {
  readonly prompts: SkillInfo[];
  readonly diagnostics: ProviderCatalogSourceDiagnostic[];
  readonly available: boolean;
}

const DEFAULT_DISCOVERY_OPTIONS: CodexCustomPromptDiscoveryLimits = {
  maxFiles: CODEX_CUSTOM_PROMPT_MAX_FILES,
  maxFileBytes: CODEX_CUSTOM_PROMPT_MAX_FILE_BYTES,
};

const NODE_FILE_SYSTEM: CodexCustomPromptFileSystem = {
  async *entries(directory) {
    const handle = await opendir(directory);
    for await (const entry of handle) {
      yield { name: entry.name, isFile: entry.isFile() };
    }
  },
  async readFile(path, maxBytes) {
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.allocUnsafe(maxBytes + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      return buffer.subarray(0, offset);
    } finally {
      await handle.close().catch(() => undefined);
    }
  },
};

function environmentValue(environment: Readonly<Record<string, string>>, key: string): string | undefined {
  const value = environment[key]?.trim();
  return value ? value : undefined;
}

/** Resolves the Codex configuration root from the spawn environment. */
export function resolveEffectiveCodexHome(
  environment: Readonly<Record<string, string>>,
): string {
  const configuredHome = environmentValue(environment, CODEX_HOME_ENVIRONMENT_VARIABLE);
  if (configuredHome) return resolve(configuredHome);

  const driveHome = environmentValue(environment, "HOMEDRIVE")
    && environmentValue(environment, "HOMEPATH")
    ? `${environmentValue(environment, "HOMEDRIVE")}${environmentValue(environment, "HOMEPATH")}`
    : undefined;
  const userHome = environmentValue(environment, "HOME")
    ?? environmentValue(environment, "USERPROFILE")
    ?? driveHome
    ?? homedir();
  return resolve(userHome, ".codex");
}

function safeSourceName(name: string): string {
  return name.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 180) || "unnamed prompt";
}

function addDiagnostic(
  diagnostics: ProviderCatalogSourceDiagnostic[],
  diagnostic: ProviderCatalogSourceDiagnostic,
): void {
  if (diagnostics.length < CODEX_CUSTOM_PROMPT_MAX_DIAGNOSTICS) diagnostics.push(diagnostic);
}

function discoveryError(fileName: string, reason: string): ProviderCatalogSourceDiagnostic {
  return {
    sourceKind: "customPromptAdapter",
    rejectedSource: safeSourceName(fileName),
    severity: "warning",
    code: "discovery-error",
    message: `Codex custom prompt "${safeSourceName(fileName)}" was omitted: ${reason}`,
  };
}

function decodePrompt(buffer: Buffer): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
}

function promptDescription(body: string): string {
  if (!body.startsWith("---\n") && !body.startsWith("---\r\n")) return "";
  const frontmatter = FRONTMATTER_RE.exec(body);
  if (!frontmatter) throw new Error("its YAML frontmatter is not closed");

  const document = parseDocument(frontmatter[1], { uniqueKeys: true });
  if (document.errors.length > 0) throw new Error("its YAML frontmatter is malformed");
  const metadata = document.toJS({ maxAliasCount: 10 }) as unknown;
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("its YAML frontmatter must be a mapping");
  }
  const description = (metadata as Record<string, unknown>).description;
  if (description === undefined || description === null) return "";
  if (typeof description !== "string") {
    throw new Error("its YAML description must be a string");
  }
  if (description.length > CODEX_CUSTOM_PROMPT_MAX_DESCRIPTION_CHARS) {
    throw new Error(`its description exceeds ${CODEX_CUSTOM_PROMPT_MAX_DESCRIPTION_CHARS} characters`);
  }
  return description.trim();
}

function promptFromFile(fileName: string, path: string, body: string): SkillInfo {
  const nativeName = fileName.slice(0, -CODEX_CUSTOM_PROMPT_FILE_SUFFIX.length);
  const name = `prompts:${nativeName}`;
  if (
    nativeName.length === 0
    || nativeName.trim() !== nativeName
    || /[\u0000-\u001f\u007f]/.test(nativeName)
    || name.length > CODEX_CUSTOM_PROMPT_MAX_NAME_CHARS
  ) {
    throw new Error("its filename does not form a supported prompt name");
  }
  if (path.length > PROVIDER_CATALOG_PATH_MAX_CHARS) {
    throw new Error(`its path exceeds ${PROVIDER_CATALOG_PATH_MAX_CHARS} characters`);
  }
  return {
    name,
    nativeName,
    description: promptDescription(body),
    kind: "command",
    source: "user",
    providers: ["codex"],
    path,
  };
}

/** Discovers direct custom prompt files within one effective Codex home. */
export async function discoverCodexCustomPrompts(
  codexHome: string,
  options: CodexCustomPromptDiscoveryOptions = DEFAULT_DISCOVERY_OPTIONS,
): Promise<CodexCustomPromptDiscoveryResult> {
  const diagnostics: ProviderCatalogSourceDiagnostic[] = [];
  const prompts: SkillInfo[] = [];
  const promptDirectory = join(codexHome, CODEX_CUSTOM_PROMPT_DIRECTORY_NAME);
  if (promptDirectory.length > PROVIDER_CATALOG_PATH_MAX_CHARS) {
    return {
      prompts,
      diagnostics: [{
        sourceKind: "customPromptAdapter",
        rejectedSource: "prompts",
        severity: "warning",
        code: "source-unavailable",
        message: "The effective Codex custom prompt directory path is too long.",
      }],
      available: false,
    };
  }

  const fileSystem = options.fileSystem ?? NODE_FILE_SYSTEM;
  const maxDirectoryEntries = options.maxDirectoryEntries
    ?? CODEX_CUSTOM_PROMPT_MAX_DIRECTORY_ENTRIES;
  let inspectedEntries = 0;
  let inspectedFiles = 0;
  try {
    for await (const entry of fileSystem.entries(promptDirectory)) {
      if (inspectedEntries >= maxDirectoryEntries) {
        addDiagnostic(diagnostics, {
          sourceKind: "customPromptAdapter",
          rejectedSource: safeSourceName(entry.name),
          severity: "warning",
          code: "partial-result",
          message: `Codex custom prompt discovery inspected at most ${maxDirectoryEntries} direct director${maxDirectoryEntries === 1 ? "y entry" : "y entries"}; "${safeSourceName(entry.name)}" and later entries were omitted.`,
        });
        break;
      }
      inspectedEntries += 1;
      if (!entry.isFile || !entry.name.endsWith(CODEX_CUSTOM_PROMPT_FILE_SUFFIX)) continue;
      if (inspectedFiles >= options.maxFiles) {
        addDiagnostic(diagnostics, {
          sourceKind: "customPromptAdapter",
          rejectedSource: safeSourceName(entry.name),
          severity: "warning",
          code: "partial-result",
          message: `Codex custom prompt discovery inspected at most ${options.maxFiles} direct .md file${options.maxFiles === 1 ? "" : "s"}; "${safeSourceName(entry.name)}" and later files were omitted.`,
        });
        break;
      }
      inspectedFiles += 1;

      const path = join(promptDirectory, entry.name);
      try {
        const buffer = await fileSystem.readFile(path, options.maxFileBytes);
        if (buffer.length > options.maxFileBytes) {
          addDiagnostic(diagnostics, discoveryError(
            entry.name,
            `it exceeds ${options.maxFileBytes} bytes`,
          ));
          continue;
        }
        const body = decodePrompt(buffer);
        prompts.push(promptFromFile(entry.name, path, body));
      } catch (error) {
        const reason = error instanceof Error && error.message.startsWith("its ")
          ? error.message
          : "it could not be read or parsed";
        addDiagnostic(diagnostics, discoveryError(entry.name, reason));
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { prompts: [], diagnostics: [], available: true };
    }
    return {
      prompts,
      diagnostics: [{
        sourceKind: "customPromptAdapter",
        rejectedSource: "prompts",
        severity: "warning",
        code: "source-unavailable",
        message: "The effective Codex custom prompt directory could not be read.",
      }],
      available: false,
    };
  }

  return { prompts, diagnostics, available: true };
}

/** Owns the cached result of bounded, picker-triggered custom prompt refreshes. */
@injectable()
export class CodexCustomPromptService {
  private current: CodexCustomPromptDiscoveryResult = {
    prompts: [],
    diagnostics: [],
    available: true,
  };
  private refreshInFlight: Promise<CodexCustomPromptDiscoveryResult> | null = null;

  constructor(
    @inject(EnvService) private readonly envService: EnvService,
  ) {}

  /** Refreshes custom prompts once, coalescing concurrent picker requests. */
  refresh(): Promise<CodexCustomPromptDiscoveryResult> {
    if (this.refreshInFlight) return this.refreshInFlight;
    const codexHome = resolveEffectiveCodexHome(this.envService.getEnv());
    const refresh = discoverCodexCustomPrompts(codexHome).then((result) => {
      this.current = result.available
        ? result
        : { ...result, prompts: this.current.prompts };
      return this.current;
    });
    this.refreshInFlight = refresh;
    const clearRefresh = () => {
      if (this.refreshInFlight === refresh) this.refreshInFlight = null;
    };
    void refresh.then(clearRefresh, clearRefresh);
    return refresh;
  }

  /** Returns the latest bounded prompt list without starting filesystem work. */
  currentPrompts(): SkillInfo[] {
    return this.current.prompts;
  }

  /** Returns the latest complete adapter result without starting filesystem work. */
  currentSnapshot(): CodexCustomPromptDiscoveryResult {
    return this.current;
  }
}
