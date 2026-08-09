import { injectable } from "tsyringe";
import { LegacyTerminalBackend } from "./legacy/legacy-terminal-backend.js";
import type { TerminalBackend } from "./terminal-backend.js";

/** Selects one immutable Terminal backend before the server accepts requests. */
@injectable()
export class TerminalBackendSelector {
  private readonly selectedBackend: TerminalBackend;

  constructor(legacyBackend: LegacyTerminalBackend) {
    this.selectedBackend = legacyBackend;
  }

  /** Returns the Terminal backend selected for this server boot. */
  getSelectedBackend(): TerminalBackend {
    return this.selectedBackend;
  }
}
