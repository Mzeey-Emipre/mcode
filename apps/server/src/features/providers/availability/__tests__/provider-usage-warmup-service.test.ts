import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import {
  SettingsSchema,
  type IAgentProvider,
  type IProviderRegistry,
  type Settings,
} from "@mcode/contracts";
import { ProviderUsageWarmupService } from "../provider-usage-warmup-service.js";
import type { SettingsService } from "../../../settings/settings-service.js";

function makeSettings(enabled: Partial<Settings["provider"]["enabled"]> = {}): Settings {
  const settings = SettingsSchema().parse({});
  settings.provider.enabled = { ...settings.provider.enabled, ...enabled };
  return settings;
}

function makeProvider(
  id: IAgentProvider["id"],
  methods: Partial<Pick<IAgentProvider, "getUsage">> & {
    warmUsageCache?: (force?: boolean) => Promise<unknown>;
  },
): IAgentProvider {
  return {
    id,
    supportsCompletion: false,
    sessionForkOnResume: "unsupported",
    forker: {} as IAgentProvider["forker"],
    maxInputCharactersPerTurn: 1,
    sendTurn: vi.fn(),
    stopSession: vi.fn(),
    shutdown: vi.fn(),
    listModels: vi.fn(),
    on: vi.fn(),
    ...methods,
  } as unknown as IAgentProvider;
}

function makeService(settings: Settings, providers: IAgentProvider[]): ProviderUsageWarmupService {
  return new ProviderUsageWarmupService(
    { get: () => settings } as unknown as SettingsService,
    { resolveAll: () => providers } as unknown as IProviderRegistry,
  );
}

describe("ProviderUsageWarmupService", () => {
  it("warms usage for enabled providers that expose usage", () => {
    const claudeUsage = vi.fn().mockResolvedValue({ providerId: "claude", quotaCategories: [] });
    const codexWarm = vi.fn().mockResolvedValue({ providerId: "codex", quotaCategories: [] });
    const cursorUsage = vi.fn().mockResolvedValue({ providerId: "cursor", quotaCategories: [] });
    const settings = makeSettings({ claude: true, codex: true, cursor: false });

    makeService(settings, [
      makeProvider("claude", { getUsage: claudeUsage }),
      makeProvider("codex", { getUsage: vi.fn(), warmUsageCache: codexWarm }),
      makeProvider("cursor", { getUsage: cursorUsage }),
    ]).warmEnabledProviders();

    expect(claudeUsage).toHaveBeenCalledTimes(1);
    expect(codexWarm).toHaveBeenCalledWith(false);
    expect(cursorUsage).not.toHaveBeenCalled();
  });
});
