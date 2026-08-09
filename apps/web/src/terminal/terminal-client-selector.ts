import type { TerminalBackendCapabilities } from "@mcode/contracts";
import type { TerminalClient, TerminalRpcCall } from "./terminal-client";
import { LegacyTerminalClient } from "./legacy/legacy-terminal-client";

/** Selects one immutable Terminal client from server capability reporting. */
export class TerminalClientSelector {
  private selected: TerminalClient | null = null;

  private readonly legacyClient: LegacyTerminalClient;

  constructor(rpc: TerminalRpcCall) {
    this.legacyClient = new LegacyTerminalClient(rpc);
  }

  /** Selects the adapter declared by the server for its current boot. */
  select(capabilities: TerminalBackendCapabilities): TerminalClient {
    if (capabilities.backend !== "legacy") {
      throw new Error(`Unsupported Terminal backend: ${capabilities.backend}`);
    }
    this.selected ??= this.legacyClient;
    return this.selected;
  }

  /** Returns the selected client or fails before Terminal state can hydrate. */
  getSelected(): TerminalClient {
    if (!this.selected) {
      throw new Error("Terminal client is not selected");
    }
    return this.selected;
  }
}
