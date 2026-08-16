/**
 * Client-side flow-control state machine for a single PTY.
 *
 * Call `written(n)` each time xterm.write is called with `n` bytes.
 * Call `acked(n)` when xterm's write callback fires, indicating `n` bytes
 * have been processed. The machine requests server pause when
 * `pending = written - acked` crosses highBytes, and requests resume when
 * pending drops below lowBytes.
 *
 * Both callbacks (onPause / onResume) are idempotent at the transport layer,
 * so duplicate calls are safe if they occur.
 */

/** Options for constructing a {@link ClientTerminalFlowControl} instance. */
export interface ClientFlowControlOptions {
  /** Called when pending bytes cross highBytes. Idempotent. */
  onPause: () => void;
  /** Called when pending bytes drop below lowBytes. Idempotent. */
  onResume: () => void;
  /** Pending-bytes threshold that triggers a pause request. */
  highBytes: number;
  /** Pending-bytes threshold that triggers a resume request. */
  lowBytes: number;
}

/** Client-side per-PTY backpressure state machine. */
export class ClientTerminalFlowControl {
  private pending = 0;
  private paused = false;

  constructor(private readonly opts: ClientFlowControlOptions) {}

  /**
   * Record that `n` bytes have been dispatched to xterm.write.
   * May trigger an onPause callback if the backlog crosses highBytes.
   */
  written(n: number): void {
    this.pending += n;
    if (!this.paused && this.pending > this.opts.highBytes) {
      this.paused = true;
      this.opts.onPause();
    }
  }

  /**
   * Record that xterm has processed `n` bytes (write callback fired).
   * May trigger an onResume callback if the backlog drops below lowBytes.
   */
  acked(n: number): void {
    this.pending = Math.max(0, this.pending - n);
    if (this.paused && this.pending < this.opts.lowBytes) {
      this.paused = false;
      this.opts.onResume();
    }
  }
}
