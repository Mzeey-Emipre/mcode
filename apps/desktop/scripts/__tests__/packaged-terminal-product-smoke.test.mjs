import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  PRODUCT_SMOKE_FAULTS,
  MACOS_LOOPBACK_PROFILE,
  appendBoundedOutputTail,
  attachLaunchOutputTail,
  assertLoopbackIsolationReceipt,
  buildProductBootEnv,
  buildLinuxProductVerifierLaunch,
  buildLoopbackIsolationPlan,
  buildProductLaunch,
  closeTerminalAndWaitForWorkloadCleanup,
  cleanupLoopbackIsolation,
  classifyProductSmokeOutcome,
  diagnoseDarwinSpawnHelper,
  describeLinuxProductNamespaceProof,
  hashPackagedResources,
  hasLinuxProductNamespaceProof,
  LINUX_SUDO_PRESERVE_ENV,
  loadProcessCleanupWorkload,
  openTerminal,
  parseProductSmokeArguments,
  pollProcessCleanup,
  releaseProductProcess,
  runTerminalWorkload,
  sendTerminalCommand,
  formatProbeTimeoutDiagnostics,
  summarizeReleaseProbe,
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
      command: "sudo",
    });
    expect(buildLoopbackIsolationPlan("linux", executable).args).toEqual([
      "-n",
      `--preserve-env=${LINUX_SUDO_PRESERVE_ENV}`,
      "unshare",
      "--net",
      "/bin/sh",
      "-c",
      expect.any(String),
    ]);
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
    expect(outerLinuxLaunch.args.slice(0, 6)).toEqual([
      "-a",
      "sudo",
      "-n",
      `--preserve-env=${LINUX_SUDO_PRESERVE_ENV}`,
      "unshare",
      "--net",
    ]);
    expect(outerLinuxLaunch.args.join(" ")).toContain("ip_cmd");
    expect(outerLinuxLaunch.args.join(" ")).toContain(
      'MCODE_TERMINAL_PRODUCT_NAMESPACE=1 exec /usr/bin/setpriv --reuid="$SUDO_UID" --regid="$SUDO_GID" --init-groups -- "$MCODE_RELEASE_NODE" "$MCODE_RELEASE_SCRIPT" "$@"',
    );
    expect(outerLinuxLaunch.args).not.toContain("--user");
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
    const missingLoopbackInterfaces = () => ({
      eth0: [{ address: "192.0.2.10" }],
    });
    const extraNetworkInterfaces = () => ({
      docker0: [{ address: "192.0.2.20" }],
      lo: [{ address: "127.0.0.1" }],
      bsdummy6: [{ address: "192.0.2.30" }],
    });
    const manyNetworkInterfaces = () => Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [`eth${index}`, []]),
    );
    const unreadableInterfaces = () => {
      throw new Error("network interface directory unavailable");
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
        networkInterfaces: missingLoopbackInterfaces,
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
      hasLinuxProductNamespaceProof({
        env: { MCODE_TERMINAL_PRODUCT_NAMESPACE: "1" },
        networkInterfaces: () => [],
      }),
    ).toBe(false);
    expect(
      describeLinuxProductNamespaceProof({
        env: {},
        networkInterfaces: onlyLoopbackInterfaces,
      }),
    ).toEqual({
      markerPresent: false,
      interfaces: ["lo"],
      interfaceCount: 1,
      interfacesTruncated: false,
    });
    const boundedDiagnostics = describeLinuxProductNamespaceProof({
      env: { MCODE_TERMINAL_PRODUCT_NAMESPACE: "1" },
      networkInterfaces: manyNetworkInterfaces,
    });
    expect(boundedDiagnostics.interfaces).toHaveLength(32);
    expect(boundedDiagnostics.interfaces).toEqual([...boundedDiagnostics.interfaces].sort());
    expect(boundedDiagnostics.interfaceCount).toBe(40);
    expect(boundedDiagnostics.interfacesTruncated).toBe(true);
    expect(
      describeLinuxProductNamespaceProof({
        env: { MCODE_TERMINAL_PRODUCT_NAMESPACE: "1" },
        networkInterfaces: unreadableInterfaces,
      }),
    ).toEqual({
      markerPresent: true,
      interfaces: null,
      interfaceCount: null,
      interfacesTruncated: false,
    });
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
    expect(linuxLaunch.args).not.toContain("sudo");
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
    ).toThrow(/isolated product verifier.*interfaces=\["bsdummy6","docker0","lo"\]/);
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

  it("probes the packaged Darwin helper with its cwd and command arguments", () => {
    const helperPath = path.join(
      mkdtempSync(path.join(tmpdir(), "mcode-helper-")),
      "spawn-helper",
    );
    const resolvedHelperPath = path.resolve(helperPath);
    const cwd = path.dirname(resolvedHelperPath);
    const calls = [];
    const report = diagnoseDarwinSpawnHelper({
      targetPlatform: "darwin",
      hostPlatform: "darwin",
      helperPath,
      runCommand: (command, args, options) => {
        calls.push({ command, args, options });
        return { status: 0, signal: null, stdout: "", stderr: "" };
      },
    });

    expect(calls.map(({ command, args }) => [command, args])).toEqual([
      ["/usr/bin/codesign", ["-dvv", resolvedHelperPath]],
      ["/usr/bin/codesign", ["--verify", "--strict", resolvedHelperPath]],
      [resolvedHelperPath, [cwd, "/usr/bin/true"]],
      [
        "/usr/bin/sandbox-exec",
        ["-p", MACOS_LOOPBACK_PROFILE, resolvedHelperPath, cwd, "/usr/bin/true"],
      ],
    ]);
    expect(calls.every(({ options }) => options.cwd === cwd)).toBe(true);
    expect(report).toMatchObject({
      helperPath: resolvedHelperPath,
      cwd,
      direct: { ok: true },
      sandboxed: { ok: true },
    });
  });

  it("fails closed and records helper metadata when the launch probe fails", () => {
    const helperPath = path.join(
      mkdtempSync(path.join(tmpdir(), "mcode-helper-")),
      "spawn-helper",
    );
    const resolvedHelperPath = path.resolve(helperPath);
    const calls = [];
    expect(() =>
      diagnoseDarwinSpawnHelper({
        targetPlatform: "darwin",
        hostPlatform: "darwin",
        helperPath,
        runCommand: (command, args, options) => {
          calls.push({ command, args, options });
          return command === resolvedHelperPath
            ? { status: 23, signal: null, stdout: "", stderr: "posix_spawnp failed" }
            : { status: 0, signal: null, stdout: "", stderr: "" };
        },
      }),
    ).toThrow("Darwin spawn-helper launchability diagnostic failed");

    expect(calls.at(-2)).toMatchObject({
      command: "/usr/bin/xattr",
      args: ["-l", resolvedHelperPath],
    });
    expect(calls.at(-1)).toMatchObject({
      command: "/usr/bin/otool",
      args: ["-L", resolvedHelperPath],
    });
  });

  it("does not run Darwin helper diagnostics for non-Darwin targets or hosts", () => {
    let calls = 0;
    expect(
      diagnoseDarwinSpawnHelper({
        targetPlatform: "linux",
        helperPath: "/tmp/target/node-pty/spawn-helper",
        runCommand: () => {
          calls += 1;
          return { status: 0 };
        },
      }),
    ).toBeNull();
    expect(
      diagnoseDarwinSpawnHelper({
        targetPlatform: "darwin",
        hostPlatform: "linux",
        helperPath: "/tmp/target/node-pty/spawn-helper",
        runCommand: () => {
          calls += 1;
          return { status: 0 };
        },
      }),
    ).toBeNull();
    expect(calls).toBe(0);
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

  it("closes Terminal before polling workload PIDs without tearing down the app", async () => {
    const events = [];
    const workloadPids = [101, 202, 303];
    const page = {
      evaluate: async () => {
        throw new Error("app teardown must remain outside workload cleanup");
      },
      getByRole: () => ({
        first: () => ({
          count: async () => 1,
          click: async () => events.push("close"),
        }),
      }),
    };
    const cleanup = await closeTerminalAndWaitForWorkloadCleanup(page, workloadPids, {
      pollCleanup: async (pids) => {
        events.push(["poll", pids]);
        return { aliveAfterCleanup: [], passed: true };
      },
    });

    expect(events).toEqual(["close", ["poll", workloadPids]]);
    expect(cleanup.passed).toBe(true);
  });

  it("reports only alive workload roles and PIDs when inner cleanup fails", async () => {
    const events = [];
    const workloadPids = [401, 402, 403];
    const page = {
      getByRole: () => ({
        first: () => ({
          count: async () => 1,
          click: async () => events.push("close"),
        }),
      }),
    };

    let failure;
    try {
      await closeTerminalAndWaitForWorkloadCleanup(page, workloadPids, {
        pollCleanup: async (pids) => {
          events.push(["poll", pids]);
          return { aliveAfterCleanup: [401, 403], passed: false };
        },
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toContain("parent=401");
    expect(failure.message).toContain("grandchild=403");
    expect(failure.message).not.toContain("child=402");
    expect(failure.message.length).toBeLessThanOrEqual(512);
    expect(events).toEqual(["close", ["poll", workloadPids]]);
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

  it("sends packaged workload commands as literal text before Enter", async () => {
    const calls = [];
    await sendTerminalCommand(
      {
        keyboard: {
          insertText: async (text) => calls.push(["insertText", text]),
          press: async (key) => calls.push(["press", key]),
        },
      },
      "node -e \"console.log('WF:cleanup:parent')\"",
    );
    expect(calls).toEqual([
      ["insertText", "node -e \"console.log('WF:cleanup:parent')\""],
      ["press", "Enter"],
    ]);
  });

  it("bounds renderer probe timeout evidence to the last terminal lines", () => {
    const probe = {
      cols: 80,
      rows: 24,
      cursor: { x: 4, y: 5 },
      normalizedLines: Array.from({ length: 20 }, (_, index) =>
        `line-${index}-${"x".repeat(170)}`,
      ),
    };
    const summary = summarizeReleaseProbe(probe);
    const diagnostics = formatProbeTimeoutDiagnostics({
      probe,
      focus: {
        hasFocus: true,
        tagName: "TEXTAREA",
        className: "xterm-helper-textarea",
        testId: null,
      },
    });
    expect(summary).toMatchObject({
      cols: 80,
      rows: 24,
      cursor: { x: 4, y: 5 },
    });
    expect(summary.normalizedLines).toHaveLength(16);
    expect(summary.normalizedLines[0]).toContain("line-4-");
    expect(summary.normalizedLines.at(-1)).toContain("line-19-");
    expect(diagnostics).toContain('"cols":80');
    expect(diagnostics).toContain('"tagName":"TEXTAREA"');
    expect(diagnostics.length).toBeLessThanOrEqual(4_096);
  });

  it("runs the finite wrap command before the foreground cleanup workload", async () => {
    const commands = [];
    let pageLocatorCalls = 0;
    let terminalProbeReads = 0;
    let probeIndex = 0;
    const probes = [
      {
        cols: 80,
        rows: 24,
        lines: [],
        normalizedLines: [],
      },
      {
        cols: 100,
        rows: 24,
        lines: [],
        normalizedLines: [],
      },
      {
        cols: 100,
        rows: 24,
        lines: [{ text: "MCODE_RELEASE_WRAP_" + "x".repeat(120), wrapped: true }],
        normalizedLines: ["MCODE_RELEASE_WRAP_" + "x".repeat(120)],
      },
      {
        cols: 100,
        rows: 24,
        lines: [{ text: "MCODE_RELEASE_WRAP_" + "x".repeat(120), wrapped: true }],
        normalizedLines: [
          "MCODE_RELEASE_WRAP_" + "x".repeat(120),
          "WF:cleanup:parent:10",
          "WF:cleanup:child:11",
          "WF:cleanup:grandchild:12",
        ],
      },
    ];
    const serializedProbe = () => JSON.stringify(probes[probeIndex]);
    const page = {
      keyboard: {
        insertText: async (command) => commands.push(command),
        press: async (key) => {
          if (key === "Enter") probeIndex += 1;
        },
      },
      locator: () => {
        pageLocatorCalls += 1;
        throw new Error("runTerminalWorkload must use the supplied terminal locator");
      },
      setViewportSize: async () => {
        probeIndex = 1;
      },
      waitForTimeout: async () => undefined,
    };
    const terminal = {
      getAttribute: async () => {
        terminalProbeReads += 1;
        return serializedProbe();
      },
    };

    const result = await runTerminalWorkload(page, terminal, {
      program: { source: "setInterval(() => {}, 1_000)" },
      synchronizationMarker: "WF:cleanup:parent",
    });

    expect(commands).toHaveLength(2);
    expect(commands[0]).toContain("MCODE_RELEASE_WRAP_");
    expect(commands[1]).toContain("node -e");
    expect(result.output).toContain("WF:cleanup:parent:10");
    expect(result.finalProbe.lines.some((line) => line.wrapped)).toBe(true);
    expect(terminalProbeReads).toBeGreaterThan(0);
    expect(pageLocatorCalls).toBe(0);
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

  it("uses a 30 second default Terminal readiness bound", async () => {
    const terminal = {
      count: async () => 1,
      isVisible: async () => false,
    };
    let now = 0;
    let reachedTenSeconds = false;
    let waitCalls = 0;
    const originalDateNow = Date.now;
    Date.now = () => now;
    try {
      await expect(
        waitForTerminalControl({
          evaluate: async () => true,
          locator: (selector) =>
            selector === "html"
              ? { getAttribute: async () => null }
              : { first: () => terminal },
          waitForTimeout: async (durationMs) => {
            now += durationMs;
            waitCalls += 1;
            if (now >= 10_000) reachedTenSeconds = true;
          },
        }),
      ).rejects.toThrow("Timed out waiting for visible Terminal control");
    } finally {
      Date.now = originalDateNow;
    }
    expect(reachedTenSeconds).toBe(true);
    expect(waitCalls).toBe(300);
    expect(now).toBe(30_000);
  });

  it("keeps exactly the last 8192 launch-output characters", () => {
    const tail = appendBoundedOutputTail("old\n", "a".repeat(8_192));
    const combined = appendBoundedOutputTail(tail, "b".repeat(10));
    expect(combined).toHaveLength(8_192);
    expect(combined).toBe("a".repeat(8_182) + "b".repeat(10));
  });

  it("attaches a non-empty launch tail without replacing the original error", () => {
    const error = new Error("renderer create failed");
    const boundedTail = appendBoundedOutputTail("old\n", "x".repeat(8_192));
    expect(attachLaunchOutputTail(error, boundedTail)).toBe(error);
    expect(error.message).toContain("renderer create failed");
    expect(error.message).toContain("Launch output tail:");
    expect(error.message.endsWith("x".repeat(8_192))).toBe(true);
    expect(error.message).not.toContain("old");
    expect(attachLaunchOutputTail(error, "")).toBe(error);
    expect(error.message.match(/Launch output tail:/g)).toHaveLength(1);
    const existingError = new Error("renderer create failed\nlaunch output tail:\nlaunch diagnostics");
    expect(attachLaunchOutputTail(existingError, "launch diagnostics")).toBe(existingError);
    expect(existingError.message.match(/launch output tail:/gi)).toHaveLength(1);
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
