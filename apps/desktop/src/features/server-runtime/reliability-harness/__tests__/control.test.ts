import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { ReliabilityHarnessControlPlane, readReliabilityHarnessCapability } from "../control.js";

describe("Desktop reliability control plane", () => {
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
    const serverFault = vi.fn().mockResolvedValue(undefined);
    const plane = new ReliabilityHarnessControlPlane(capabilityPath, {
      plannedRestart: vi.fn().mockResolvedValue(undefined),
      serverFault,
    });
    try {
      const rendezvous = await plane.start();
      for (const control of ["server-exit", "server-hang", "transport-loss", "persistence-failure"]) {
        expect(await post(rendezvous.port, token, { control })).toBe(202);
      }
      expect(serverFault).toHaveBeenCalledTimes(4);
      expect(serverFault.mock.calls.map(([command]) => command.control)).toEqual([
        "server-exit",
        "server-hang",
        "transport-loss",
        "persistence-failure",
      ]);
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
