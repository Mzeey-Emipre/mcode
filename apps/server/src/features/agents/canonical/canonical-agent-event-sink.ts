import { injectable } from "tsyringe";

import { CanonicalAgentBoundary } from "./canonical-agent-boundary.js";

export * from "./canonical-agent-boundary.js";

/** Temporary compatibility façade for callers that have not yet moved to the named boundary. */
@injectable()
export class CanonicalAgentEventSink extends CanonicalAgentBoundary {}
