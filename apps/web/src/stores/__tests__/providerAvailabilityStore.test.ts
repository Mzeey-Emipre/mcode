import { describe, it, expect, beforeEach } from "vitest";
import type { ProviderAvailability } from "@mcode/contracts";
import { useProviderAvailabilityStore } from "../providerAvailabilityStore";

function row(partial: Partial<ProviderAvailability>): ProviderAvailability {
  return {
    id: "claude",
    enabled: true,
    hasAdapter: true,
    beta: false,
    comingSoon: false,
    capabilities: [],
    cli: { status: "found", resolvedPath: "/usr/local/bin/claude", configuredPath: "" },
    ...partial,
  };
}

describe("providerAvailabilityStore", () => {
  beforeEach(() => useProviderAvailabilityStore.setState({ providers: [] }));

  it("exposes isEnabled", () => {
    useProviderAvailabilityStore.getState().replace([
      row({ id: "claude", enabled: true }),
      row({ id: "codex", enabled: false }),
    ]);
    expect(useProviderAvailabilityStore.getState().isEnabled("claude")).toBe(true);
    expect(useProviderAvailabilityStore.getState().isEnabled("codex")).toBe(false);
  });

  it("isUsable requires enabled AND cli.status !== 'not_found'", () => {
    useProviderAvailabilityStore.getState().replace([
      row({ id: "claude", enabled: true, cli: { status: "found", resolvedPath: "/a", configuredPath: "" } }),
      row({ id: "codex",  enabled: true, cli: { status: "not_found", resolvedPath: null, configuredPath: "" } }),
      row({ id: "copilot", enabled: false, cli: { status: "found", resolvedPath: "/b", configuredPath: "" } }),
    ]);
    const s = useProviderAvailabilityStore.getState();
    expect(s.isUsable("claude")).toBe(true);
    expect(s.isUsable("codex")).toBe(false);
    expect(s.isUsable("copilot")).toBe(false);
  });

  it("returns 'unchecked' CLI as usable so the startup race doesn't false-alarm", () => {
    useProviderAvailabilityStore.getState().replace([
      row({ id: "claude", enabled: true, cli: { status: "unchecked", resolvedPath: null, configuredPath: "" } }),
    ]);
    expect(useProviderAvailabilityStore.getState().isUsable("claude")).toBe(true);
  });
});
