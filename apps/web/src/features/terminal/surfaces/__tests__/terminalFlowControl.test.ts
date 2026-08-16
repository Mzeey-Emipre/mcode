import { describe, it, expect, vi } from "vitest";
import { ClientTerminalFlowControl } from "../terminalFlowControl";

describe("ClientTerminalFlowControl", () => {
  it("requests pause when pending bytes cross the high-water mark", () => {
    const onPause = vi.fn();
    const onResume = vi.fn();
    const fc = new ClientTerminalFlowControl({
      onPause,
      onResume,
      highBytes: 100,
      lowBytes: 40,
    });
    fc.written(80);
    expect(onPause).not.toHaveBeenCalled();
    fc.written(50); // pending = 130 > 100
    expect(onPause).toHaveBeenCalledOnce();
  });

  it("requests resume when pending drops below the low-water mark", () => {
    const onPause = vi.fn();
    const onResume = vi.fn();
    const fc = new ClientTerminalFlowControl({
      onPause,
      onResume,
      highBytes: 100,
      lowBytes: 40,
    });
    fc.written(150); // trips pause
    expect(onPause).toHaveBeenCalledOnce();
    fc.acked(120); // pending = 30 < 40
    expect(onResume).toHaveBeenCalledOnce();
  });

  it("does not re-pause while already paused", () => {
    const onPause = vi.fn();
    const onResume = vi.fn();
    const fc = new ClientTerminalFlowControl({
      onPause,
      onResume,
      highBytes: 100,
      lowBytes: 40,
    });
    fc.written(150);
    fc.written(50); // still paused — should not fire again
    expect(onPause).toHaveBeenCalledOnce();
  });

  it("does not re-resume while already un-paused", () => {
    const onPause = vi.fn();
    const onResume = vi.fn();
    const fc = new ClientTerminalFlowControl({
      onPause,
      onResume,
      highBytes: 100,
      lowBytes: 40,
    });
    fc.written(150);
    fc.acked(120); // un-pauses
    fc.acked(10); // still un-paused — should not fire again
    expect(onResume).toHaveBeenCalledOnce();
  });
});
