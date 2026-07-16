import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

describe("pull request diff row memory", () => {
  it("keeps a real 20,000-line V8 model within the 16 MiB cache", () => {
    const webRoot = process.cwd();
    const script = resolve(webRoot, "scripts/check-pull-request-code-memory.mts");
    const tsxLoader = createRequire(import.meta.url).resolve("tsx");
    const result = spawnSync(
      process.execPath,
      ["--expose-gc", "--import", pathToFileURL(tsxLoader).href, script],
      { cwd: webRoot, encoding: "utf8", timeout: 30_000 },
    );

    expect(result.status, result.stderr || result.stdout).toBe(0);
    const report = JSON.parse(result.stdout) as {
      retainedBytes: number;
      reportedBytes: number;
      rawBytes: number;
    };
    expect(report).toEqual(
      expect.objectContaining({
        retainedBytes: expect.any(Number),
        reportedBytes: expect.any(Number),
        rawBytes: expect.any(Number),
      }),
    );
    expect(report.reportedBytes).toBeGreaterThanOrEqual(report.retainedBytes);
  });
});
