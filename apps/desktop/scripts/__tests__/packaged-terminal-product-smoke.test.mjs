import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  PRODUCT_SMOKE_FAULTS,
  assertLoopbackIsolationReceipt,
  buildLoopbackIsolationPlan,
  buildProductLaunch,
  cleanupLoopbackIsolation,
  classifyProductSmokeOutcome,
  hashPackagedResources,
  parseProductSmokeArguments,
  pollProcessCleanup,
  validateProductSmokeLaunchInput,
} from "../desktop-packaging/package-validation/packaged-terminal-product-smoke.mjs";

describe("packaged Terminal product smoke contract", () => {
  it("accepts only the packaged modern release boundary", () => {
    expect(
      validateProductSmokeLaunchInput({
        env: {
          MCODE_TERMINAL_RELEASE_TEST: "1",
          MCODE_TERMINAL_BACKEND: "modern",
          MCODE_TERMINAL_RELEASE_FAULT: PRODUCT_SMOKE_FAULTS[0],
        },
        resourcesPresent: true,
        fault: PRODUCT_SMOKE_FAULTS[0],
      }),
    ).toMatchObject({ releaseTest: true, backend: "modern" });
    expect(() =>
      validateProductSmokeLaunchInput({
        env: { MCODE_TERMINAL_BACKEND: "modern" },
        resourcesPresent: true,
      }),
    ).toThrow("MCODE_TERMINAL_RELEASE_TEST=1");
    expect(() =>
      validateProductSmokeLaunchInput({
        env: {
          MCODE_TERMINAL_RELEASE_TEST: "1",
          MCODE_TERMINAL_BACKEND: "modern",
          MCODE_TERMINAL_RELEASE_UNKNOWN: "fault",
        },
        resourcesPresent: true,
      }),
    ).toThrow("Unknown release-test input");
  });

  it("rejects repeated command options", () => {
    expect(() => parseProductSmokeArguments(["--fault", "a", "--fault", "b"])).toThrow(
      "Repeated product smoke option",
    );
  });

  it("classifies only observed startup and recovery state", () => {
    const base = {
      capabilities: {
        initial: { backend: "legacy", host: undefined },
        history: [{ backend: "legacy" }],
      },
      sessions: [],
      retry: { backend: "modern", host: { state: "healthy", generation: "1" } },
      newSession: null,
      typedErrors: [],
    };
    expect(
      classifyProductSmokeOutcome({
        fault: "missing-native-artifact",
        observation: base,
      }),
    ).toMatchObject({ passed: true, expectedBackend: "legacy" });
    expect(
      classifyProductSmokeOutcome({
        fault: "post-start-host-exit",
        observation: {
          capabilities: {
            initial: { backend: "modern", host: { state: "healthy", generation: "1" } },
            history: [
              { backend: "modern", host: { state: "unhealthy", generation: "1" } },
              { backend: "modern", host: { state: "healthy", generation: "2" } },
            ],
          },
          sessions: [{ state: "failed", exitReason: "host-crash" }],
          retry: null,
          newSession: { state: "running" },
          typedErrors: ["HOST_UNHEALTHY"],
        },
      }),
    ).toMatchObject({ passed: true, expectedBackend: "modern", replacementCount: 1 });
  });

  it("constructs OS isolation without proxy settings", () => {
    const executable = path.join(mkdtempSync(path.join(tmpdir(), "mcode-product-")), "Mcode");
    writeFileSync(executable, "placeholder");
    expect(buildLoopbackIsolationPlan("linux", executable)).toMatchObject({
      mode: "linux-network-namespace",
      command: "unshare",
    });
    const relativeExecutable = path.relative(process.cwd(), executable);
    expect(buildLoopbackIsolationPlan("win32", relativeExecutable).executablePath).toBe(
      path.resolve(executable),
    );
    expect(buildLoopbackIsolationPlan("darwin", executable).args.join(" ")).toContain(
      'localhost:*',
    );
    expect(buildLoopbackIsolationPlan("darwin", executable).args.join(" ")).toContain(
      "(allow default)",
    );
    expect(buildLoopbackIsolationPlan("darwin", executable).args.join(" ")).not.toContain(
      "127.0.0.1:*",
    );
    const linuxLaunch = buildProductLaunch({
      target: { executablePath: executable },
      isolationReceipt: { mode: "linux-network-namespace" },
      launchArgs: ["--remote-debugging-port=39000"],
    });
    expect(linuxLaunch.command).toBe("xvfb-run");
    expect(linuxLaunch.args.slice(0, 5)).toEqual([
      "-a",
      "unshare",
      "--user",
      "--map-root-user",
      "--net",
    ]);
    expect(linuxLaunch.args.at(-1)).toBe("--remote-debugging-port=39000");
    expect(linuxLaunch.env.MCODE_RELEASE_PROGRAM).toBe(path.resolve(executable));
    expect(() =>
      assertLoopbackIsolationReceipt({ mode: "none", loopbackAllowed: false }),
    ).toThrow("not installed");
  });

  it("keeps process cleanup polling bounded", async () => {
    let calls = 0;
    const result = await pollProcessCleanup([7, 7], {
      intervalMs: 1,
      timeoutMs: 20,
      isAlive: () => calls++ < 1,
    });
    expect(result).toMatchObject({ pids: [7], aliveAfterCleanup: [], passed: true });
    expect(result.cleanupDurationMs).toBeLessThanOrEqual(20);
  });

  it("hashes only Terminal and native artifacts", () => {
    const root = mkdtempSync(path.join(tmpdir(), "mcode-product-hash-"));
    try {
      const host = path.join(root, "app.asar.unpacked", "dist", "server");
      const nodePty = path.join(root, "app.asar.unpacked", "node_modules", "node-pty", "build", "Release");
      const koffi = path.join(root, "app.asar.unpacked", "node_modules", "koffi", "build", "koffi", "linux_x64");
      mkdirSync(host, { recursive: true });
      mkdirSync(nodePty, { recursive: true });
      mkdirSync(koffi, { recursive: true });
      writeFileSync(path.join(root, "app.asar"), "app");
      writeFileSync(path.join(host, "pty-host.cjs"), "host");
      writeFileSync(path.join(nodePty, "pty.node"), "pty");
      writeFileSync(path.join(koffi, "koffi.node"), "koffi");
      const unrelated = path.join(root, "unrelated");
      mkdirSync(unrelated);
      for (let index = 0; index < 100; index += 1) writeFileSync(path.join(unrelated, `${index}.txt`), "noise");
      const before = hashPackagedResources(root);
      writeFileSync(path.join(unrelated, "0.txt"), "changed noise");
      expect(hashPackagedResources(root)).toEqual(before);
      writeFileSync(path.join(nodePty, "pty.node"), "changed pty");
      expect(hashPackagedResources(root)).not.toEqual(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
