import { createCursorProvider, type CursorProviderBoundary, type ProviderFactoryInput } from "@mcode/providers";

/** Registers the exact usable Cursor factory instance as the server Provider. */
export function registerCursorProvider(
  registry: { registerInstance(token: "IAgentProvider", provider: CursorProviderBoundary): unknown },
  input: ProviderFactoryInput,
): CursorProviderBoundary {
  const provider = createCursorProvider(input);
  registry.registerInstance("IAgentProvider", provider);
  return provider;
}
