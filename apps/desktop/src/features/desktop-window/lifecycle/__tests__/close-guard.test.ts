import { describe, expect, it, vi } from "vitest";

import { attachCloseGuard } from "../close-guard.js";

function createCloseFixture(getActiveAgentCount: () => Promise<number>, response = 1) {
  let closeListener: ((event: { preventDefault(): void }) => Promise<void>) | undefined;
  const window = {
    on: vi.fn((event: string, listener: typeof closeListener) => {
      if (event === "close") closeListener = listener;
    }),
  };
  const showMessageBox = vi.fn(async () => ({ response }));
  const quit = vi.fn();
  attachCloseGuard(window as never, {
    getActiveAgentCount,
    showMessageBox,
    quit,
  });
  return {
    window,
    showMessageBox,
    quit,
    close: async () => {
      const preventDefault = vi.fn();
      await closeListener?.({ preventDefault });
      return preventDefault;
    },
    closeListener: () => closeListener!,
  };
}

describe("Desktop Window close guard", () => {
  it("allows close with zero active agents", async () => {
    const fixture = createCloseFixture(async () => 0);

    const preventDefault = await fixture.close();

    expect(preventDefault).not.toHaveBeenCalled();
    expect(fixture.showMessageBox).not.toHaveBeenCalled();
    expect(fixture.quit).not.toHaveBeenCalled();
  });

  it("confirms one active agent with singular grammar", async () => {
    const fixture = createCloseFixture(async () => 1);

    const preventDefault = await fixture.close();

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(fixture.showMessageBox).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        title: "Agents Running",
        message: "1 agent is still working. They'll resume when you reopen Mcode.",
        buttons: ["Continue", "Cancel"],
        defaultId: 0,
        cancelId: 1,
      }),
    );
  });

  it("uses plural grammar for multiple active agents", async () => {
    const fixture = createCloseFixture(async () => 2);

    await fixture.close();

    expect(fixture.showMessageBox).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        message: "2 agents are still working. They'll resume when you reopen Mcode.",
      }),
    );
  });

  it("allows close when the active-agent provider is unavailable", async () => {
    const fixture = createCloseFixture(async () => {
      throw new Error("health unavailable");
    });

    const preventDefault = await fixture.close();

    expect(preventDefault).not.toHaveBeenCalled();
    expect(fixture.showMessageBox).not.toHaveBeenCalled();
  });

  it("quits after Continue and stays open after Cancel", async () => {
    const continueFixture = createCloseFixture(async () => 1, 0);
    const cancelFixture = createCloseFixture(async () => 1, 1);

    await continueFixture.close();
    await cancelFixture.close();

    expect(continueFixture.quit).toHaveBeenCalledOnce();
    expect(cancelFixture.quit).not.toHaveBeenCalled();
  });

  it("prevents duplicate close dialogs while the first health check is pending", async () => {
    let resolveCount!: (count: number) => void;
    const count = new Promise<number>((resolve) => {
      resolveCount = resolve;
    });
    const fixture = createCloseFixture(() => count, 0);
    const firstEvent = { preventDefault: vi.fn() };
    const secondEvent = { preventDefault: vi.fn() };

    const firstClose = fixture.closeListener()(firstEvent);
    await fixture.closeListener()(secondEvent);
    resolveCount(1);
    await firstClose;

    expect(secondEvent.preventDefault).toHaveBeenCalledOnce();
    expect(fixture.showMessageBox).toHaveBeenCalledOnce();
  });
});
