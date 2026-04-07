import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  registerCommand,
  unregisterCommand,
  getCommand,
  getAllCommands,
  executeCommand,
  clearCommands,
} from "@/lib/command-registry";

describe("CommandRegistry", () => {
  beforeEach(() => {
    clearCommands();
  });

  it("registers and retrieves a command", () => {
    const handler = vi.fn();
    registerCommand({
      id: "test.hello",
      title: "Hello",
      category: "Test",
      handler,
    });
    expect(getCommand("test.hello")).toBeDefined();
    expect(getCommand("test.hello")!.title).toBe("Hello");
  });

  it("unregisters a command", () => {
    registerCommand({
      id: "test.remove",
      title: "Remove Me",
      category: "Test",
      handler: vi.fn(),
    });
    unregisterCommand("test.remove");
    expect(getCommand("test.remove")).toBeUndefined();
  });

  it("returns all registered commands", () => {
    registerCommand({ id: "a", title: "A", category: "Cat", handler: vi.fn() });
    registerCommand({ id: "b", title: "B", category: "Cat", handler: vi.fn() });
    expect(getAllCommands()).toHaveLength(2);
  });

  it("executes a command handler", () => {
    const handler = vi.fn();
    registerCommand({ id: "test.exec", title: "Exec", category: "Test", handler });
    executeCommand("test.exec");
    expect(handler).toHaveBeenCalledOnce();
  });

  it("returns false when executing non-existent command", () => {
    expect(executeCommand("nonexistent")).toBe(false);
  });

  it("register returns an unregister function", () => {
    const dispose = registerCommand({
      id: "test.dispose",
      title: "Dispose",
      category: "Test",
      handler: vi.fn(),
    });
    expect(getCommand("test.dispose")).toBeDefined();
    dispose();
    expect(getCommand("test.dispose")).toBeUndefined();
  });
});
