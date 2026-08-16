import { EventEmitter } from "events";
import { describe, expect, it, vi } from "vitest";
import { listenWithPortRetry } from "../http-listener.js";

class FakeServer extends EventEmitter {
  readonly attempts: number[] = [];

  listen(port: number): this {
    this.attempts.push(port);
    return this;
  }
}

describe("listenWithPortRetry", () => {
  it("runs only the successful attempt callback after a port collision", () => {
    const server = new FakeServer();
    const onListening = vi.fn();
    const onRetry = vi.fn();
    const onFailure = vi.fn();

    listenWithPortRetry(server, {
      host: "127.0.0.1",
      port: 19500,
      maxAttempts: 10,
      onListening,
      onRetry,
      onFailure,
    });
    server.emit("error", Object.assign(new Error("occupied"), { code: "EADDRINUSE" }));
    server.emit("listening");

    expect(server.attempts).toEqual([19500, 19501]);
    expect(onRetry).toHaveBeenCalledWith(19500, 19501);
    expect(onListening).toHaveBeenCalledOnce();
    expect(onListening).toHaveBeenCalledWith(19501);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("reports a terminal bind failure without retaining a listening callback", () => {
    const server = new FakeServer();
    const onListening = vi.fn();
    const onFailure = vi.fn();
    const error = Object.assign(new Error("denied"), { code: "EACCES" });

    listenWithPortRetry(server, {
      host: "127.0.0.1",
      port: 19500,
      maxAttempts: 10,
      onListening,
      onRetry: vi.fn(),
      onFailure,
    });
    server.emit("error", error);
    server.emit("listening");

    expect(onFailure).toHaveBeenCalledWith(19500, error);
    expect(onListening).not.toHaveBeenCalled();
  });
});
