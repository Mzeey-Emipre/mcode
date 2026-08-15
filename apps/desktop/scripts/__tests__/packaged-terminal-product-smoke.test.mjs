import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  PRODUCT_SMOKE_FAULTS,
  appendBoundedOutputTail,
  assertLoopbackIsolationReceipt,
  buildProductBootEnv,
  buildLinuxProductVerifierLaunch,
  buildLoopbackIsolationPlan,
  buildProductLaunch,
  cleanupLoopbackIsolation,
  classifyProductSmokeOutcome,
  hashPackagedResources,
  hasLinuxProductNamespaceProof,
  loadProcessCleanupWorkload,
  openTerminal,
  parseProductSmokeArguments,
  pollProcessCleanup,
  releaseProductProcess,
  shouldReexecLinuxProductVerifier,
  validateProductSmokeLaunchInput,
  waitForTerminalControl,
  waitForRendererPage,
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
    const outerLinuxLaunch = buildLinuxProductVerifierLaunch({
      nodePath: "/usr/bin/node",
      scriptPath: "/tmp/packaged-terminal-product-smoke.mjs",
      args: ["product", "--release-dir", "/tmp/release"],
    });
    expect(outerLinuxLaunch.command).toBe("xvfb-run");
    expect(outerLinuxLaunch.args.slice(0, 5)).toEqual([
      "-a",
      "unshare",
      "--user",
      "--map-root-user",
      "--net",
    ]);
    expect(outerLinuxLaunch.args.join(" ")).toContain("ip_cmd");
    expect(outerLinuxLaunch.args.join(" ")).toContain(
      'exec "$MCODE_RELEASE_NODE" "$MCODE_RELEASE_SCRIPT" "$@"',
    );
    expect(outerLinuxLaunch.env.MCODE_TERMINAL_PRODUCT_NAMESPACE).toBe("1");
    const hostileVerifierArgs = [
      "product",
      "--release-dir",
      "release dir/'\" $;*?",
      "--receipt-dir",
      "receipt;$(touch should-not-run)",
      "--fault",
      "fault ' \" $;*?",
    ];
    const hostileLaunch = buildLinuxProductVerifierLaunch({ args: hostileVerifierArgs });
    const shellArgumentDelimiter = hostileLaunch.args.indexOf(
      "--",
      hostileLaunch.args.indexOf("-c") + 1,
    );
    expect(hostileLaunch.args.slice(shellArgumentDelimiter + 1)).toEqual(hostileVerifierArgs);

    const onlyLoopbackInterfaces = () => ({
      lo: [{ address: "127.0.0.1" }],
    });
    const extraNetworkInterfaces = () => ({
      eth0: [{ address: "192.0.2.10" }],
      lo: [{ address: "127.0.0.1" }],
    });
    const unreadableInterfaces = () => {
      throw new Error("network interfaces unavailable");
    };
    expect(
      hasLinuxProductNamespaceProof({
        env: {},
        networkInterfaces: onlyLoopbackInterfaces,
      }),
    ).toBe(false);
    expect(
      hasLinuxProductNamespaceProof({
        env: { MCODE_TERMINAL_PRODUCT_NAMESPACE: "1" },
        networkInterfaces: onlyLoopbackInterfaces,
      }),
    ).toBe(true);
    expect(
      hasLinuxProductNamespaceProof({
        env: { MCODE_TERMINAL_PRODUCT_NAMESPACE: "1" },
        networkInterfaces: extraNetworkInterfaces,
      }),
    ).toBe(false);
    expect(
      hasLinuxProductNamespaceProof({
        env: { MCODE_TERMINAL_PRODUCT_NAMESPACE: "1" },
        networkInterfaces: unreadableInterfaces,
      }),
    ).toBe(false);
    expect(
      hasLinuxProductNamespaceProof({
        env: { MCODE_TERMINAL_PRODUCT_NAMESPACE: "1" },
        networkInterfaces: () => null,
      }),
    ).toBe(false);
    expect(
      shouldReexecLinuxProductVerifier({
        command: "product",
        platform: "linux",
        env: {},
        networkInterfaces: onlyLoopbackInterfaces,
      }),
    ).toBe(true);
    expect(
      shouldReexecLinuxProductVerifier({
        command: "product",
        platform: "linux",
        env: { MCODE_TERMINAL_PRODUCT_NAMESPACE: "1" },
        networkInterfaces: extraNetworkInterfaces,
      }),
    ).toBe(true);
    expect(
      shouldReexecLinuxProductVerifier({
        command: "product",
        platform: "linux",
        env: { MCODE_TERMINAL_PRODUCT_NAMESPACE: "1" },
        networkInterfaces: onlyLoopbackInterfaces,
      }),
    ).toBe(false);

    const linuxLaunch = buildProductLaunch({
      target: { executablePath: executable },
      isolationReceipt: { mode: "linux-network-namespace" },
      launchArgs: ["--remote-debugging-port=39000"],
      platform: "linux",
      env: { MCODE_TERMINAL_PRODUCT_NAMESPACE: "1" },
      networkInterfaces: onlyLoopbackInterfaces,
    });
    expect(linuxLaunch.command).toBe(path.resolve(executable));
    expect(linuxLaunch.args.at(-1)).toBe("--remote-debugging-port=39000");
    expect(linuxLaunch.args).toContain("--no-sandbox");
    expect(linuxLaunch.args).not.toContain("unshare");
    expect(() =>
      buildProductLaunch({
        target: { executablePath: executable },
        isolationReceipt: { mode: "linux-network-namespace" },
        launchArgs: [],
        platform: "linux",
        env: { MCODE_TERMINAL_PRODUCT_NAMESPACE: "1" },
        networkInterfaces: extraNetworkInterfaces,
      }),
    ).toThrow("isolated product verifier");
    expect(() =>
      buildProductLaunch({
        target: { executablePath: executable },
        isolationReceipt: { mode: "linux-network-namespace" },
        launchArgs: [],
        platform: "linux",
        env: { MCODE_TERMINAL_PRODUCT_NAMESPACE: "1" },
        networkInterfaces: true,
      }),
    ).toThrow("isolated product verifier");
    const macLaunch = buildProductLaunch({
      target: { executablePath: executable },
      isolationReceipt: { mode: "macos-network-sandbox" },
      launchArgs: ["--remote-debugging-port=39000"],
    });
    expect(macLaunch.args).toContain("--no-sandbox");
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

  it("releases every packaged process handle after a launch", () => {
    const calls = [];
    releaseProductProcess({
      kill: (signal) => calls.push(["kill", signal]),
      stdout: { destroy: () => calls.push(["stdout"]) },
      stderr: { destroy: () => calls.push(["stderr"]) },
      unref: () => calls.push(["unref"]),
    });
    expect(calls).toEqual([
      ["kill", "SIGTERM"],
      ["stdout"],
      ["stderr"],
      ["unref"],
    ]);
  });

  it("seeds a fresh packaged workspace from the target fixture", () => {
    const cleanEnv = buildProductBootEnv({
      env: {
        MCODE_AGENT_RUNTIME: "0",
        MCODE_AGENT_FIXTURE_REPO: "stale-fixture",
        MCODE_TERMINAL_RELEASE_FAULT: "stale-fault",
      },
      targetRoot: "C:\\packaged-target",
      bootFault: undefined,
    });
    expect(cleanEnv).toMatchObject({
      MCODE_AGENT_RUNTIME: "1",
      MCODE_AGENT_FIXTURE_REPO: "C:\\packaged-target",
      MCODE_TERMINAL_RELEASE_TEST: "1",
      MCODE_TERMINAL_BACKEND: "modern",
    });
    expect(cleanEnv).not.toHaveProperty("MCODE_TERMINAL_RELEASE_FAULT");
    expect(
      buildProductBootEnv({
        env: {},
        targetRoot: "/tmp/packaged-target",
        bootFault: "post-start-host-exit",
      }).MCODE_TERMINAL_RELEASE_FAULT,
    ).toBe("post-start-host-exit");
  });

  it("fails immediately when the packaged Terminal controls are missing", async () => {
    const missingTerminalSelectors = [];
    const missingTerminalPage = {
      locator: (selector) => {
        missingTerminalSelectors.push(selector);
        return {
          first: () => ({ count: async () => 0 }),
        };
      },
      getByTestId: () => {
        throw new Error("terminal content should not be queried");
      },
    };
    await expect(openTerminal(missingTerminalPage)).rejects.toThrow(
      "Terminal control is missing",
    );
    expect(missingTerminalSelectors).toEqual(['[data-rail-tab="terminal"]']);

  });

  it("opens the current Terminal without querying a New terminal control", async () => {
    const selectors = [];
    const waitCalls = [];
    let terminalClicked = false;
    const terminal = {
      waitFor: async (options) => waitCalls.push(options),
      click: async () => {
        terminalClicked = true;
      },
    };
    const page = {
      locator: (selector) => {
        selectors.push(selector);
        return {
          first: () => ({
            count: async () => 1,
            click: async () => undefined,
          }),
        };
      },
      getByRole: () => {
        throw new Error("New terminal control must not be queried");
      },
      getByTestId: (testId) => {
        expect(testId).toBe("terminal-render-content");
        return { last: () => terminal };
      },
    };

    await openTerminal(page);

    expect(selectors).toEqual(['[data-rail-tab="terminal"]']);
    expect(waitCalls).toEqual([{ state: "visible", timeout: 15_000 }]);
    expect(terminalClicked).toBe(true);
  });

  it("waits for a delayed visible Terminal control", async () => {
    let terminalVisible = false;
    const selectors = [];
    const terminal = {
      count: async () => 1,
      isVisible: async () => terminalVisible,
    };
    let waits = 0;
    await waitForTerminalControl({
      evaluate: async () => true,
      locator: (selector) => {
        selectors.push(selector);
        return selector === "html"
          ? { getAttribute: async () => null }
          : { first: () => terminal };
      },
      waitForTimeout: async () => {
        waits += 1;
        if (waits === 2) terminalVisible = true;
      },
    }, { timeoutMs: 50, intervalMs: 1 });
    expect(waits).toBe(2);
    expect(terminalVisible).toBe(true);
    expect(selectors).toContain('[data-rail-tab="terminal"]');
  });

  it("fails immediately when the release-test bridge is missing", async () => {
    let waits = 0;
    let locatorCalled = false;
    await expect(
      waitForTerminalControl({
        evaluate: async () => false,
        locator: () => {
          locatorCalled = true;
          return { first: () => ({ count: async () => 0, isVisible: async () => false }) };
        },
        waitForTimeout: async () => {
          waits += 1;
        },
      }),
    ).rejects.toThrow("Terminal release-test bridge is missing");
    expect(locatorCalled).toBe(false);
    expect(waits).toBe(0);
  });

  it("fails immediately on the renderer bootstrap error", async () => {
    let waits = 0;
    await expect(waitForTerminalControl({
      evaluate: async () => true,
      locator: (selector) =>
        selector === "html"
          ? { getAttribute: async () => "Terminal release-test workspace is missing" }
          : { first: () => ({ count: async () => 0, isVisible: async () => false }) },
      waitForTimeout: async () => { waits += 1; },
    })).rejects.toThrow("Terminal release-test workspace is missing");
    expect(waits).toBe(0);
  });

  it("times out when Terminal never becomes visible", async () => {
    const terminal = {
      count: async () => 1,
      isVisible: async () => false,
    };
    await expect(
      waitForTerminalControl({
        evaluate: async () => true,
        locator: (selector) =>
          selector === "html"
            ? { getAttribute: async () => null }
            : { first: () => terminal },
        waitForTimeout: async () => undefined,
      }, { timeoutMs: 5, intervalMs: 1 }),
    ).rejects.toThrow("Timed out waiting for visible Terminal control");
  });

  it("keeps exactly the last 8192 launch-output characters", () => {
    const tail = appendBoundedOutputTail("old\n", "a".repeat(8_192));
    const combined = appendBoundedOutputTail(tail, "b".repeat(10));
    expect(combined).toHaveLength(8_192);
    expect(combined).toBe("a".repeat(8_182) + "b".repeat(10));
  });

  it("waits for the packaged renderer page after CDP connects", async () => {
    const unrelatedPage = { url: () => "http://127.0.0.1:3000/" };
    let polls = 0;
    const rendererPage = {
      url: () => (polls > 1 ? "file:///packaged-renderer.html" : "about:blank"),
    };
    await expect(
      waitForRendererPage(
        {
          contexts: () => {
            polls += 1;
            return [
              { pages: () => [rendererPage] },
              { pages: () => [unrelatedPage] },
            ];
          },
        },
        { timeoutMs: 50, intervalMs: 1 },
      ),
    ).resolves.toBe(rendererPage);
    expect(polls).toBeGreaterThan(1);
  });

  it("reports launch diagnostics when the packaged renderer page is missing", async () => {
    const wait = waitForRendererPage(
      { contexts: () => [{ pages: () => [{ url: () => "about:blank" }] }] },
      {
        timeoutMs: 5,
        intervalMs: 1,
        getDiagnostics: () => ({ exitCode: 23, launchOutputTail: "renderer launch failed" }),
      },
    );
    await expect(wait).rejects.toThrow("outer child exit code: 23");
    await expect(wait).rejects.toThrow("launch output tail:\nrenderer launch failed");
  });

  it("loads the shared process-cleanup workload", async () => {
    await expect(loadProcessCleanupWorkload()).resolves.toMatchObject({
      id: "process-cleanup",
      synchronizationMarker: "WF:cleanup:parent",
    });
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
