import type { CanonicalAgentEventSink } from "../../index.js";
import type Database from "better-sqlite3";

/** Creates an AgentService test seam that runs compatibility writes without canonical persistence. */
export function createCanonicalAgentEventSinkStub(
  db: Pick<Database.Database, "transaction">,
): CanonicalAgentEventSink {
  return {
    startParentTurn: (
      input: Parameters<CanonicalAgentEventSink["startParentTurn"]>[0],
    ) => {
      db.transaction(input.projectUserMessage)();
      return {
        outcome: "committed",
        conversationRevision: 0,
        rosterRevision: 0,
        acceptedThrough: 0,
        durableThrough: 0,
        events: [],
      };
    },
    loadCheckpoint: () => null,
    loadTurnByExecution: () => null,
    loadCanonicalChildStopTargets: () => [],
    finishCanonicalChildTurn: () => null,
    recordProviderDiagnostic: () => undefined,
    recordCodexChildRoutingDiagnostic: () => false,
  } as unknown as CanonicalAgentEventSink;
}
