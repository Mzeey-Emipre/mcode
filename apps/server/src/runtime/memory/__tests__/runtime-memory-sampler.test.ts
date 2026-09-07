import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import { describe, expect, it } from "vitest";
import { sampleRuntimeMemory } from "../runtime-memory-sampler.js";

const PROCESS_MEMORY_TOLERANCE_BYTES = 8 * 1024 * 1024;

describe("sampleRuntimeMemory", () => {
  it("uses the configured soft budget for Bun process RSS", () => {
    const measurement = sampleRuntimeMemory(
      256,
      {
        versions: { bun: "1.4.0" },
        memoryUsage: () => ({ rss: 128 * 1024 * 1024 }),
      },
      () => ({ used_heap_size: 1, heap_size_limit: 1 }),
    );

    expect(measurement).toEqual({
      source: "process-rss",
      usedBytes: 128 * 1024 * 1024,
      budgetBytes: 256 * 1024 * 1024,
    });
  });

  it("keeps Electron and Node measurements on the V8 heap limit", () => {
    const measurement = sampleRuntimeMemory(
      256,
      {
        versions: {},
        memoryUsage: () => ({ rss: 999 }),
      },
      () => ({ used_heap_size: 80, heap_size_limit: 100 }),
    );

    expect(measurement).toEqual({ source: "v8-heap", usedBytes: 80, budgetBytes: 100 });
  });

  it("rejects invalid Bun soft budgets instead of treating them as normal pressure", () => {
    const runtime = {
      versions: { bun: "1.4.0" },
      memoryUsage: () => ({ rss: 1 }),
    };

    expect(() => sampleRuntimeMemory(0, runtime)).toThrow(RangeError);
    expect(() => sampleRuntimeMemory(Number.NaN, runtime)).toThrow(RangeError);
  });

  it("measures Bun process RSS with the production sampler", () => {
    const serverRoot = NodePath.resolve(import.meta.dirname, "../../../..");
    const script = [
      'import { sampleRuntimeMemory } from "./src/runtime/memory/runtime-memory-sampler.ts";',
      'import { memoryUsage } from "bun:jsc";',
      "const jscBefore = memoryUsage().current;",
      "const before = sampleRuntimeMemory(256);",
      "const bytes = new Uint8Array(2 * 1024 * 1024);",
      "for (let offset = 0; offset < bytes.length; offset += 4096) bytes[offset] = 1;",
      "const after = sampleRuntimeMemory(256);",
      "const jscAfter = memoryUsage().current;",
      "console.log(JSON.stringify({ before, after, jscBefore, jscAfter }));",
    ].join(" ");
    const result = NodeChildProcess.spawnSync("bun", ["-e", script], {
      cwd: serverRoot,
      encoding: "utf-8",
      timeout: 10_000,
    });

    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout) as {
      before: { source: string; usedBytes: number; budgetBytes: number };
      after: { source: string; usedBytes: number; budgetBytes: number };
      jscBefore: number;
      jscAfter: number;
    };
    expect(output.before.source).toBe("process-rss");
    expect(output.before.usedBytes).toBeGreaterThan(0);
    expect(output.before.budgetBytes).toBe(256 * 1024 * 1024);
    expect(output.after.source).toBe("process-rss");
    expect(output.after.usedBytes).toBeGreaterThan(0);
    expect(output.after.budgetBytes).toBe(256 * 1024 * 1024);
    expect(Math.abs(output.before.usedBytes - output.jscBefore)).toBeLessThanOrEqual(PROCESS_MEMORY_TOLERANCE_BYTES);
    expect(Math.abs(output.after.usedBytes - output.jscAfter)).toBeLessThanOrEqual(PROCESS_MEMORY_TOLERANCE_BYTES);
  });
});
