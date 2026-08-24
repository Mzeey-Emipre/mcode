import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import {
  ReliabilityHarnessControlPlane,
  readReliabilityHarnessCapability,
  readReliabilityHarnessForwardResponse,
} from "../control.js";

describe("Desktop reliability control plane", () => {
  it("rejects oversized server responses before parsing them", async () => {
    const response = new Response(JSON.stringify({ padding: "x".repeat(17 * 1024) }));

    await expect(readReliabilityHarnessForwardResponse(response, {
      control: "transport-loss",
    })).rejects.toThrow("response is too large");
  });

  it("rejects an oversized assistant stream field", async () => {
    const response = new Response(JSON.stringify({
      accepted: true,
      control: "assistant-stream",
      stream: {
        threadId: "thread-reliability",
        executionId: "execution-reliability",
        text: "x".repeat(4 * 1024 + 1),
      },
    }));

    await expect(readReliabilityHarnessForwardResponse(response, {
      control: "assistant-stream",
      threadId: "thread-reliability",
    })).rejects.toThrow("invalid response");
  });

  it("accepts only the explicit capability token and omits it from rendezvous", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcode-reliability-control-"));
    const token = "a".repeat(64);
    const capabilityPath = join(root, "capability.json");
    writeFileSync(capabilityPath, JSON.stringify({ version: 1, token, runId: "run" }), { mode: 0o600 });
    const plannedRestart = vi.fn().mockResolvedValue(undefined);
    const serverFault = vi.fn().mockResolvedValue(undefined);
    const plane = new ReliabilityHarnessControlPlane(capabilityPath, { plannedRestart, serverFault });
    try {
      const rendezvous = await plane.start();
      const published = readReliabilityHarnessCapability(capabilityPath);
      expect(published?.token).toBe(token);
      const rendezvousText = readFileSync(join(root, "desktop-reliability-rendezvous.json"), "utf8");
      expect(rendezvousText).not.toContain(token);

      expect(await post(rendezvous.port, "wrong-token", { control: "planned-restart" })).toBe(401);
      expect(plannedRestart).not.toHaveBeenCalled();
      expect(await post(rendezvous.port, token, { control: "planned-restart" })).toBe(202);
      expect(plannedRestart).toHaveBeenCalledOnce();
    } finally {
      await plane.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("forwards each server fault control through one narrow callback", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcode-reliability-control-"));
    const token = "b".repeat(64);
    const capabilityPath = join(root, "capability.json");
    writeFileSync(capabilityPath, JSON.stringify({ version: 1, token, runId: "run" }), { mode: 0o600 });
    const serverFault = vi.fn(async (command: { control: string }) => (
      command.control === "assistant-stream"
        ? {
          accepted: true as const,
          control: "assistant-stream" as const,
          stream: {
            threadId: "thread-reliability",
            executionId: "00000000-0000-4000-8000-000000000001",
            text: "Durable assistant prefix for restart recovery.",
          },
        }
        : undefined
    ));
    const plane = new ReliabilityHarnessControlPlane(capabilityPath, {
      plannedRestart: vi.fn().mockResolvedValue(undefined),
      serverFault,
    });
    try {
      const rendezvous = await plane.start();
      for (const control of ["server-exit", "server-hang", "transport-loss", "persistence-failure"]) {
        expect(await post(rendezvous.port, token, { control })).toBe(202);
      }
      expect(await postJson(rendezvous.port, token, {
        control: "assistant-stream",
        threadId: "thread-reliability",
      })).toEqual({
        status: 202,
        body: {
          accepted: true,
          control: "assistant-stream",
          stream: {
            threadId: "thread-reliability",
            executionId: "00000000-0000-4000-8000-000000000001",
            text: "Durable assistant prefix for restart recovery.",
          },
        },
      });
      expect(await post(rendezvous.port, token, {
        control: "assistant-stream",
        threadId: "x".repeat(129),
      })).toBe(400);
      expect(serverFault).toHaveBeenCalledTimes(5);
      expect(serverFault.mock.calls.map(([command]) => command.control)).toEqual([
        "server-exit",
        "server-hang",
        "transport-loss",
        "persistence-failure",
        "assistant-stream",
      ]);
      expect(serverFault.mock.calls.at(-1)![0]).toMatchObject({ threadId: "thread-reliability" });
    } finally {
      await plane.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not acknowledge a command when its callback fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcode-reliability-control-"));
    const token = "c".repeat(64);
    const capabilityPath = join(root, "capability.json");
    writeFileSync(capabilityPath, JSON.stringify({ version: 1, token, runId: "run" }), { mode: 0o600 });
    const plane = new ReliabilityHarnessControlPlane(capabilityPath, {
      plannedRestart: vi.fn().mockRejectedValue(new Error("planned restart failed")),
      serverFault: vi.fn().mockResolvedValue(undefined),
    });
    try {
      const rendezvous = await plane.start();
      expect(await post(rendezvous.port, token, { control: "planned-restart" })).toBe(400);
    } finally {
      await plane.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function post(port: number, token: string, body: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port,
      path: "/__mcode/reliability",
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    request.once("error", reject);
    request.end(JSON.stringify(body));
  });
}

function postJson(port: number, token: string, body: unknown): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port,
      path: "/__mcode/reliability",
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    }, (response) => {
      let responseBody = "";
      response.on("data", (chunk) => { responseBody += chunk.toString(); });
      response.once("end", () => resolve({
        status: response.statusCode ?? 0,
        body: JSON.parse(responseBody),
      }));
    });
    request.once("error", reject);
    request.end(JSON.stringify(body));
  });
}
