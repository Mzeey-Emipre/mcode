import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { container, inject, injectable, type DependencyContainer } from "tsyringe";

import {
  AGENT_TURN_COMMAND_PORT,
  AgentRuntimeCommandPort,
  AgentTurnCommandPort,
  type AgentTurnCommand,
} from "../agent-turn-command-port.js";

/** Represents a feature that can send a turn without depending on AgentService. */
@injectable()
class FeatureCommandConsumer {
  constructor(@inject(AGENT_TURN_COMMAND_PORT) readonly commands: AgentTurnCommandPort) {}
}

/** Represents the runtime owner that binds after feature command resolution. */
@injectable()
class RuntimeOwner {
  readonly sendMessage = vi.fn(async (_command: AgentTurnCommand) => undefined);

  constructor(@inject(AgentRuntimeCommandPort) runtime: AgentRuntimeCommandPort) {
    runtime.bind({ sendMessage: this.sendMessage, runtimeSnapshots: () => [] });
  }
}

function registerCommandGraph(dependencies: DependencyContainer): void {
  dependencies.registerSingleton(AgentRuntimeCommandPort);
  dependencies.register(AGENT_TURN_COMMAND_PORT, {
    useFactory: (child) => new AgentTurnCommandPort(child.resolve(AgentRuntimeCommandPort)),
  });
  dependencies.registerSingleton(FeatureCommandConsumer);
  dependencies.registerSingleton(RuntimeOwner);
}

describe("Agent turn command port", () => {
  it("resolves feature commands and the runtime owner without a DI backedge", async () => {
    const dependencies = container.createChildContainer();
    registerCommandGraph(dependencies);

    const consumer = dependencies.resolve(FeatureCommandConsumer);
    const owner = dependencies.resolve(RuntimeOwner);
    await consumer.commands.sendMessage({
      threadId: "thread-1",
      content: "plan",
      model: "gpt-5",
      attachments: [],
    });

    expect(owner.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ threadId: "thread-1" }));
  });
});
