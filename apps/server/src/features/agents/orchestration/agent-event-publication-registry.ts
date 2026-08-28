import type { AgentEvent } from "@mcode/contracts";

/** Binds normalized renderer publication after server composition has started. */
export class AgentEventPublicationRegistry {
  private publisher: ((event: AgentEvent) => void) | undefined;
  private startPipeline: (() => void) | undefined;

  /** Connect the single renderer publication owner. */
  bind(publisher: (event: AgentEvent) => void): void {
    this.publisher = publisher;
  }

  /** Register the ingress startup owned by the runtime facade. */
  registerPipelineStart(startPipeline: () => void): void {
    this.startPipeline = startPipeline;
  }

  /** Start provider ingress only after renderer publication is configured. */
  start(): void {
    this.startPipeline?.();
  }

  /** Return whether renderer publication is available. */
  isBound(): boolean {
    return this.publisher !== undefined;
  }

  /** Publish an event only after a renderer owner has been bound. */
  publish(event: AgentEvent): void {
    this.publisher?.(event);
  }
}
