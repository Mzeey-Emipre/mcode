import { createCodexProvider, type ProviderFactoryInput } from "@mcode/providers";
import type { IAgentProvider } from "@mcode/contracts";

/** Registers the exact usable Codex factory instance as the server Provider. */
export function registerCodexProvider(
  registry: { registerInstance(token: "IAgentProvider", provider: IAgentProvider): unknown },
  input: ProviderFactoryInput,
): IAgentProvider {
  const provider = createCodexProvider(input);
  registry.registerInstance("IAgentProvider", provider);
  return provider;
}
