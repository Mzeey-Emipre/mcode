import type { TerminalBackendCapabilities } from "@mcode/contracts";
import type { TerminalClient, TerminalRpcCall } from "./terminal-client";
import { LegacyTerminalClient } from "./legacy/legacy-terminal-client";
import { ModernTerminalClient, type TerminalBinarySend, type TerminalScopeResolver } from "./modern/modern-terminal-client";

/** Selects one immutable Terminal client from server capability reporting. */
export class TerminalClientSelector {
  private selected: TerminalClient | null = null;

  private readonly legacyClient: LegacyTerminalClient;
  private modernClient: ModernTerminalClient | null = null;

  constructor(
    private readonly rpc: TerminalRpcCall,
    private readonly sendFrame: TerminalBinarySend = () => undefined,
    private readonly resolveScope: TerminalScopeResolver = async () => {
      throw new Error("Modern Terminal scope resolver is unavailable");
    },
  ) {
    this.legacyClient = new LegacyTerminalClient(rpc);
  }

  /** Selects the adapter declared by the server for its current boot. */
  select(capabilities: TerminalBackendCapabilities): TerminalClient {
    if (capabilities.contractVersion === 1 && capabilities.backend === "modern") {
      this.modernClient ??= new ModernTerminalClient(
        this.rpc,
        this.sendFrame,
        capabilities,
        this.resolveScope,
      );
      this.selected ??= this.modernClient;
      return this.selected;
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

  /** Routes one v1 binary frame to the selected modern adapter. */
  handleFrame(bytes: Uint8Array): boolean {
    if (!this.modernClient || this.selected !== this.modernClient) return false;
    this.modernClient.handleFrame(bytes);
    return true;
  }
}
