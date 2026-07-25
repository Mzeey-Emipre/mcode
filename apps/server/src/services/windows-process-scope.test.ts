import { describe, expect, it, vi } from "vitest";
import {
  WindowsProcessScope,
  type WindowsProcessScopeNative,
} from "./windows-process-scope.js";

function createNative(processIds: number[] = []): WindowsProcessScopeNative {
  return {
    jobHandle: { kind: "job" },
    closeHandle: vi.fn(() => 1),
    assignProcessToJobObject: vi.fn(() => 1),
    openProcess: vi.fn(() => ({ kind: "process" })),
    terminateJobObject: vi.fn(() => 1),
    queryInformationJobObject: vi.fn((_job, _infoClass, buffer) => {
      buffer.writeUInt32LE(processIds.length, 0);
      buffer.writeUInt32LE(Math.min(processIds.length, 128), 4);
      processIds.slice(0, 128).forEach((pid, index) => {
        if (process.arch === "ia32") buffer.writeUInt32LE(pid, 8 + index * 4);
        else buffer.writeBigUInt64LE(BigInt(pid), 8 + index * 8);
      });
      return 1;
    }),
    getLastError: vi.fn(() => 5),
  };
}

describe("WindowsProcessScope", () => {
  it("owns, enumerates, terminates, waits, and closes one process tree", async () => {
    const processIds = [101, 102];
    const native = createNative(processIds);
    const scope = new WindowsProcessScope(native);

    expect(scope.assign(101)).toEqual({ ok: true });
    await expect(scope.reconcile(101, async () => [
      { pid: 101, parentPid: null, startMarker: "root", depth: 0 },
      { pid: 102, parentPid: 101, startMarker: "child", depth: 1 },
    ])).resolves.toEqual({ ok: true });
    expect(scope.ownsProcessTree).toBe(true);
    expect(scope.queryProcessIds()).toEqual({
      ok: true,
      processIds: [101, 102],
      overflow: false,
    });
    expect(scope.terminate(7)).toEqual({ ok: true });
    processIds.length = 0;
    await expect(scope.waitForEmpty(50)).resolves.toEqual({ ok: true });

    scope.close();
    scope.close();
    expect(native.closeHandle).toHaveBeenCalledTimes(2);
    expect(native.terminateJobObject).toHaveBeenCalledWith(native.jobHandle, 7);
  });

  it("reports assignment failure and closes the process handle", () => {
    const native = createNative();
    vi.mocked(native.assignProcessToJobObject).mockReturnValue(0);
    const scope = new WindowsProcessScope(native);

    expect(scope.assign(101)).toEqual({
      ok: false,
      error: "AssignProcessToJobObject failed (5)",
    });
    expect(scope.ownsProcessTree).toBe(false);
    expect(native.closeHandle).toHaveBeenCalledOnce();
  });

  it("bounds process enumeration and reports overflow", () => {
    const native = createNative(Array.from({ length: 129 }, (_, index) => index + 1));
    const scope = new WindowsProcessScope(native);

    const result = scope.queryProcessIds();

    expect(result.ok).toBe(true);
    expect(result.processIds).toHaveLength(128);
    expect(result.overflow).toBe(true);
  });

  it("is safely unavailable without native bindings", async () => {
    const scope = new WindowsProcessScope(null);

    expect(scope.ready).toBe(false);
    expect(scope.assign(1).ok).toBe(false);
    expect(scope.terminate().ok).toBe(false);
    await expect(scope.waitForEmpty(1)).resolves.toMatchObject({ ok: false });
    expect(() => scope.close()).not.toThrow();
  });

  it("assigns pre-existing descendants shallowest-first and converges", async () => {
    const members: number[] = [];
    const native = createNative(members);
    vi.mocked(native.assignProcessToJobObject).mockImplementation((_job, process) => {
      const pid = (process as { pid?: number }).pid;
      if (pid) members.push(pid);
      return 1;
    });
    vi.mocked(native.openProcess).mockImplementation((_access, _inherit, pid) => ({ pid }));
    const scope = new WindowsProcessScope(native);
    expect(scope.assign(101).ok).toBe(true);
    const tree = [
      { pid: 101, parentPid: null, startMarker: "root", depth: 0 },
      { pid: 102, parentPid: 101, startMarker: "child", depth: 1 },
      { pid: 103, parentPid: 102, startMarker: "grandchild", depth: 2 },
    ] as const;

    await expect(scope.reconcile(101, async () => tree)).resolves.toEqual({ ok: true });

    expect(scope.ownsProcessTree).toBe(true);
    expect(members).toEqual([101, 102, 103]);
  });

  it("captures a child spawned during reconciliation on the next pass", async () => {
    const members: number[] = [];
    const native = createNative(members);
    vi.mocked(native.assignProcessToJobObject).mockImplementation((_job, process) => {
      const pid = (process as { pid?: number }).pid;
      if (pid) members.push(pid);
      return 1;
    });
    vi.mocked(native.openProcess).mockImplementation((_access, _inherit, pid) => ({ pid }));
    const scope = new WindowsProcessScope(native);
    expect(scope.assign(101).ok).toBe(true);
    let captures = 0;

    await expect(scope.reconcile(101, async () => {
      captures += 1;
      return captures < 3
        ? [
            { pid: 101, parentPid: null, startMarker: "root", depth: 0 },
            { pid: 102, parentPid: 101, startMarker: "child", depth: 1 },
          ]
        : [
            { pid: 101, parentPid: null, startMarker: "root", depth: 0 },
            { pid: 102, parentPid: 101, startMarker: "child", depth: 1 },
            { pid: 103, parentPid: 102, startMarker: "grandchild", depth: 2 },
          ];
    })).resolves.toEqual({ ok: true });

    expect(members).toContain(103);
    expect(scope.ownsProcessTree).toBe(true);
  });

  it("fails closed when reconciliation never converges", async () => {
    const members: number[] = [];
    const native = createNative(members);
    vi.mocked(native.openProcess).mockImplementation((_access, _inherit, pid) => ({ pid }));
    const scope = new WindowsProcessScope(native);
    expect(scope.assign(101).ok).toBe(true);
    let nextPid = 102;

    const result = await scope.reconcile(101, async () => [
      { pid: 101, parentPid: null, startMarker: "root", depth: 0 },
      { pid: nextPid++, parentPid: 101, startMarker: `child-${nextPid}`, depth: 1 },
    ]);

    expect(result.ok).toBe(false);
    expect(scope.ownsProcessTree).toBe(false);
  });
});
