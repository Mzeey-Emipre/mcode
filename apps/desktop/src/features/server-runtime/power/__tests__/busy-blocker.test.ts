import { describe, expect, it, vi } from "vitest";
import { BusyBlocker } from "../busy-blocker.js";

function createSender(id: number) {
  let destroyedListener: (() => void) | undefined;
  return {
    id,
    once: vi.fn((_event: "destroyed", listener: () => void) => {
      destroyedListener = listener;
    }),
    destroy: () => destroyedListener?.(),
  };
}

function createSubject() {
  const blocker = {
    start: vi.fn().mockReturnValue(7),
    stop: vi.fn(),
  };
  const subject = new BusyBlocker({ blocker, log: vi.fn() });
  return { subject, blocker };
}

describe("BusyBlocker", () => {
  it("starts one blocker for the first busy sender", () => {
    const { subject, blocker } = createSubject();
    const sender = createSender(1);

    subject.report(sender, true);

    expect(blocker.start).toHaveBeenCalledWith("prevent-app-suspension");
    expect(blocker.start).toHaveBeenCalledOnce();
    expect(sender.once).toHaveBeenCalledOnce();
  });

  it("keeps the blocker active until all senders are idle", () => {
    const { subject, blocker } = createSubject();
    const first = createSender(1);
    const second = createSender(2);

    subject.report(first, true);
    subject.report(second, true);
    subject.report(first, false);

    expect(blocker.start).toHaveBeenCalledOnce();
    expect(blocker.stop).not.toHaveBeenCalled();

    subject.report(second, false);

    expect(blocker.stop).toHaveBeenCalledWith(7);
    expect(blocker.stop).toHaveBeenCalledOnce();
  });

  it("treats repeated reports from one sender as idempotent", () => {
    const { subject, blocker } = createSubject();
    const sender = createSender(1);

    subject.report(sender, true);
    subject.report(sender, true);
    subject.report(sender, false);
    subject.report(sender, false);

    expect(blocker.start).toHaveBeenCalledOnce();
    expect(blocker.stop).toHaveBeenCalledOnce();
    expect(sender.once).toHaveBeenCalledOnce();
  });

  it("clears a destroyed busy sender and stops the blocker", () => {
    const { subject, blocker } = createSubject();
    const sender = createSender(1);

    subject.report(sender, true);
    sender.destroy();

    expect(blocker.stop).toHaveBeenCalledWith(7);
    expect(blocker.stop).toHaveBeenCalledOnce();

    subject.report(sender, true);
    expect(sender.once).toHaveBeenCalledTimes(2);
    expect(blocker.start).toHaveBeenCalledTimes(2);
  });
});
