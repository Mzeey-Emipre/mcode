import type { SelectableProviderAgent, SkillInfo } from "@mcode/contracts";
import { CodexAppServer } from "./private/codex/codex-app-server.js";
import {
  discoverCodexStandaloneAgents,
  type DiscoverCodexStandaloneAgentsInput,
} from "./private/codex/codex-agent-discovery.js";
import { isCodexCustomPromptCatalogItem } from "./private/codex/codex-prompt.js";

/** Process attachment authority used by a catalog client during startup. */
export interface CodexCatalogProcessAttachment {
  attach(pid: number, description: string): void;
}

/** Options for the provider-owned, catalog-only Codex connection. */
export interface CodexCatalogClientOptions {
  cliPath: string;
  platform: NodeJS.Platform;
  workingDirectory: string;
  processAttachment?: CodexCatalogProcessAttachment;
  getSpawnEnv?: () => Record<string, string>;
}

/** Skill metadata returned by the Codex provider catalog. */
export interface CodexCatalogSkill {
  name: string;
  description: string;
  enabled: boolean;
  path: string;
  scope: string;
  shortDescription?: string | null;
  interface?: Record<string, unknown> | null;
  [key: string]: unknown;
}

/** One working-directory result from the provider Skill catalog. */
export interface CodexCatalogSkillsResult {
  data: Array<{
    cwd: string;
    errors: Array<{ message: string; path: string }>;
    skills: CodexCatalogSkill[];
  }>;
}

/** Composer metadata attached to one installed provider plugin. */
export interface CodexCatalogPluginSummary {
  id: string;
  name: string;
  installed: boolean;
  enabled: boolean;
  version?: string | null;
  localVersion?: string | null;
  interface?: {
    displayName?: string | null;
    shortDescription?: string | null;
    longDescription?: string | null;
    developerName?: string | null;
    capabilities?: string[];
    [key: string]: unknown;
  } | null;
  [key: string]: unknown;
}

/** One provider plugin marketplace and its installed plugin summaries. */
export interface CodexCatalogMarketplace {
  name: string;
  path: string | null;
  plugins: CodexCatalogPluginSummary[];
  [key: string]: unknown;
}

/** Installed provider plugin catalog result. */
export interface CodexCatalogPluginsResult {
  marketplaces: CodexCatalogMarketplace[];
  marketplaceLoadErrors: Array<{ marketplacePath: string; message: string }>;
  featuredPluginIds: string[];
}

/** Parameters for reading one provider plugin's detail. */
export interface CodexCatalogPluginReadParams {
  marketplacePath?: string;
  remoteMarketplaceName?: string;
  pluginName: string;
}

/** Detail returned for one provider plugin. */
export interface CodexCatalogPluginReadResult {
  plugin: {
    description?: string | null;
    summary?: CodexCatalogPluginSummary;
    [key: string]: unknown;
  };
}

/** Effective provider configuration returned for one working directory. */
export interface CodexCatalogConfigResult {
  config: Record<string, unknown>;
}

/** Stable provider-level catalog client used by server-owned catalog services. */
export interface CodexCatalogClient {
  readonly isAlive: boolean;
  on(event: "notification", listener: (notification: unknown) => void): this;
  start(): Promise<void>;
  listSkills(cwds?: string[], forceReload?: boolean): Promise<CodexCatalogSkillsResult>;
  listPlugins(cwds?: string[]): Promise<CodexCatalogPluginsResult>;
  readPlugin(params: CodexCatalogPluginReadParams): Promise<CodexCatalogPluginReadResult>;
  readConfig(cwd?: string): Promise<CodexCatalogConfigResult>;
  kill(): Promise<void>;
}

/** Creates one catalog-only client without exposing the concrete app-server class. */
export function createCodexCatalogClient(
  options: CodexCatalogClientOptions,
): CodexCatalogClient {
  return new CodexAppServer({
    cliPath: options.cliPath,
    platform: options.platform,
    workingDirectory: options.workingDirectory,
    approvalPolicy: "never",
    catalogOnly: true,
    ...(options.processAttachment ? { processAttachment: options.processAttachment } : {}),
    ...(options.getSpawnEnv ? { getSpawnEnv: options.getSpawnEnv } : {}),
  });
}

/** Bounded provider-owned discovery inputs for standalone Codex agent suggestions. */
export interface CodexCatalogAgentDiscoveryOptions {
  environment: Readonly<Record<string, string | undefined>>;
  cwd?: string;
  platform: NodeJS.Platform;
}

/** Standalone agent suggestions and source-scoped diagnostics. */
export interface CodexCatalogAgentDiscovery {
  readonly agents: readonly SelectableProviderAgent[];
  readonly diagnostics: readonly import("@mcode/contracts").ProviderCatalogSourceDiagnostic[];
}

/** Discovers provider catalog agents through the bounded compatibility adapter. */
export function discoverCodexCatalogAgents(
  options: CodexCatalogAgentDiscoveryOptions,
): Promise<CodexCatalogAgentDiscovery> {
  return discoverCodexStandaloneAgents(options as DiscoverCodexStandaloneAgentsInput);
}

/** Identifies a Skill entry produced by the Codex custom-prompt catalog adapter. */
export function isCodexProviderCatalogPrompt(
  item: SkillInfo,
): item is SkillInfo & { path: string } {
  return isCodexCustomPromptCatalogItem(item);
}
