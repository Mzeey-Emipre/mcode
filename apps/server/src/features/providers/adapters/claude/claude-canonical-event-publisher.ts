import type { ProviderEventSinkPort } from "@mcode/providers";
import {
  CanonicalLiveEventPublisher,
  type CanonicalLiveEventRouting,
} from "../../composition/canonical-live-event-publisher.js";

/** Identifies the canonical turn execution that owns Claude live events. */
export type ClaudeCanonicalEventRouting = CanonicalLiveEventRouting;

/** Serializes Claude live events through the provider-neutral canonical publisher. */
export class ClaudeCanonicalEventPublisher extends CanonicalLiveEventPublisher {
  constructor(sink: ProviderEventSinkPort) {
    super("claude", sink);
  }
}
