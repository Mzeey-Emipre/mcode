import { describe, expect, it, vi } from "vitest";
import { ServerNotifications } from "../notifications.js";

function createWindow() {
  return {
    isMinimized: vi.fn().mockReturnValue(false),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
  };
}

function createNotificationSubject(overrides: {
  window?: ReturnType<typeof createWindow> | null;
  response?: number;
  supported?: boolean;
} = {}) {
  const window = overrides.window === undefined ? createWindow() : overrides.window;
  const showMessageBox = vi.fn().mockResolvedValue({ response: overrides.response ?? 0 });
  const restart = vi.fn().mockResolvedValue(undefined);
  const quit = vi.fn();
  let clickHandler: (() => void) | undefined;
  const notification = {
    on: vi.fn((_event: "click", listener: () => void) => {
      clickHandler = listener;
    }),
    show: vi.fn(),
  };
  const create = vi.fn().mockReturnValue(notification);
  const subject = new ServerNotifications({
    getMainWindow: () => window,
    dialog: { showMessageBox },
    restart,
    app: { quit },
    notification: {
      isSupported: vi.fn().mockReturnValue(overrides.supported ?? true),
      create,
    },
  });
  return { subject, window, showMessageBox, restart, quit, notification, create, getClickHandler: () => clickHandler };
}

describe("ServerNotifications", () => {
  it("restarts when the crash dialog receives the Restart decision", async () => {
    const subject = createNotificationSubject();

    await subject.subject.showCrashDialog(1);

    expect(subject.showMessageBox).toHaveBeenCalledWith(subject.window, {
      type: "error",
      title: "Server crashed",
      message: "The Mcode server exited unexpectedly (code 1).",
      buttons: ["Restart", "Quit"],
      defaultId: 0,
      cancelId: 1,
    });
    expect(subject.restart).toHaveBeenCalledOnce();
    expect(subject.quit).not.toHaveBeenCalled();
  });

  it("quits when the crash dialog receives the Quit decision", async () => {
    const subject = createNotificationSubject({ response: 1 });

    await subject.subject.showCrashDialog(null);

    expect(subject.restart).not.toHaveBeenCalled();
    expect(subject.quit).toHaveBeenCalledOnce();
  });

  it("restores and focuses a minimized window when recovery notification is clicked", () => {
    const subject = createNotificationSubject();
    subject.window!.isMinimized.mockReturnValue(true);

    subject.subject.showRecoveredNotification(1);
    subject.getClickHandler()!();

    expect(subject.create).toHaveBeenCalledWith({
      title: "Mcode server recovered",
      body: "The backend crashed (code 1) and restarted.",
    });
    expect(subject.window!.restore).toHaveBeenCalledOnce();
    expect(subject.window!.show).toHaveBeenCalledOnce();
    expect(subject.window!.focus).toHaveBeenCalledOnce();
    expect(subject.notification.show).toHaveBeenCalledOnce();
  });

  it("does not construct an unsupported recovery notification", () => {
    const subject = createNotificationSubject({ supported: false });

    subject.subject.showRecoveredNotification(1);

    expect(subject.create).not.toHaveBeenCalled();
    expect(subject.notification.show).not.toHaveBeenCalled();
  });
});
