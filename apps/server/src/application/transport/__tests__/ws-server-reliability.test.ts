import "reflect-metadata";
import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { WebSocketServer } from "ws";
import { createWsServer } from "../ws-server.js";

describe("reliability harness route", () => {
  let server: http.Server | undefined;
  let websocketServer: WebSocketServer | undefined;

  afterEach(async () => {
    if (websocketServer) {
      await new Promise<void>((resolve) => websocketServer!.close(() => resolve()));
      websocketServer = undefined;
    }
    if (!server) return;
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  it("is absent when no server adapter is provided", async () => {
    ({ httpServer: server, wss: websocketServer } = createWsServer({
      authToken: "auth",
      singleInstance: false,
      shutdown: () => undefined,
      agentService: { activeCount: () => 0 },
    } as never));
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Server did not bind");
    const status = await requestStatus(address.port);
    expect(status).toBe(404);
  });
});

function requestStatus(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: "127.0.0.1", port, path: "/__mcode/reliability" }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    request.once("error", reject);
  });
}
