import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  PRODUCT_SMOKE_FAULTS,
  appendBoundedOutputTail,
  activateSeededWorkspace,
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

    const distinctNamespaceReadlink = (subject) =>
      subject.includes("/proc/self") ? "net:[self]" : "net:[init]";
    const sameNamespaceReadlink = () => "net:[same]";
    expect(
      hasLinuxProductNamespaceProof({
        env: { MCODE_TERMINAL_PRODUCT_NAMESPACE: "1" },
        readlink: sameNamespaceReadlink,
      }),
    ).toBe(false);
    expect(
      hasLinuxProductNamespaceProof({
        env: { MCODE_TERMINAL_PRODUCT_NAMESPACE: "1" },
        readlink: distinctNamespaceReadlink,
      }),
    ).toBe(true);
    expect(
      shouldReexecLinuxProductVerifier({ command: "product", platform: "linux", env: {} }),
    ).toBe(true);
    expect(
      shouldReexecLinuxProductVerifier({
        command: "product",
        platform: "linux",
        env: { MCODE_TERMINAL_PRODUCT_NAMESPACE: "1" },
        readlink: sameNamespaceReadlink,
      }),
    ).toBe(true);
    expect(
      shouldReexecLinuxProductVerifier({
        command: "product",
        platform: "linux",
        env: { MCODE_TERMINAL_PRODUCT_NAMESPACE: "1" },
        readlink: distinctNamespaceReadlink,
      }),
    ).toBe(false);

    const linuxLaunch = buildProductLaunch({
      target: { executablePath: executable },
      isolationReceipt: { mode: "linux-network-namespace" },
      launchArgs: ["--remote-debugging-port=39000"],
      platform: "linux",
      env: { MCODE_TERMINAL_PRODUCT_NAMESPACE: "1" },
      readlink: distinctNamespaceReadlink,
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
        readlink: sameNamespaceReadlink,
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
    const missingTerminalPage = {
      getByRole: () => ({
        first: () => ({ count: async () => 0 }),
      }),
      getByTestId: () => {
        throw new Error("terminal content should not be queried");
      },
    };
    await expect(openTerminal(missingTerminalPage)).rejects.toThrow(
      "Terminal control is missing",
    );

    const missingNewTerminalPage = {
      getByRole: (_role, { name }) => ({
        first: () => ({
          count: async () => (name === "Terminal" ? 1 : 0),
          click: async () => undefined,
        }),
      }),
      getByTestId: () => {
        throw new Error("terminal content should not be queried");
      },
    };
    await expect(openTerminal(missingNewTerminalPage)).rejects.toThrow(
      "New terminal control is missing",
    );
  });

  it("keeps a seeded workspace activation a no-op when Terminal is present", async () => {
    let projectLookups = 0;
    await activateSeededWorkspace({
      getByRole: (_role, { name }) => {
        if (name === "Terminal") {
          return { first: () => ({ count: async () => 1 }) };
        }
        projectLookups += 1;
        throw new Error("Project control should not be queried");
      },
    });
    expect(projectLookups).toBe(0);
  });

  it("opens the first seeded workspace and waits for Terminal", async () => {
    let terminalVisible = false;
    let clicks = 0;
    const terminal = {
      count: async () => (terminalVisible ? 1 : 0),
      isVisible: async () => terminalVisible,
    };
    await activateSeededWorkspace({
      getByRole: (_role, { name }) => ({
        first: () => name === "Terminal"
          ? terminal
          : {
              count: async () => 1,
              click: async () => {
                clicks += 1;
                terminalVisible = true;
              },
            },
      }),
      waitForTimeout: async () => undefined,
    });
    expect(clicks).toBe(1);
    expect(terminalVisible).toBe(true);
  });

  it("fails clearly when the seeded workspace project control is missing", async () => {
    await expect(
      activateSeededWorkspace({
        getByRole: (_role, { name }) => ({
          first: () => name === "Terminal"
            ? { count: async () => 0 }
            : { count: async () => 0 },
        }),
      }),
    ).rejects.toThrow("Seeded workspace project control is missing");
  });

  it("keeps exactly the last 8192 launch-output characters", () => {
    const tail = appendBoundedOutputTail("old\n", "a".repeat(8_192));
    const combined = appendBoundedOutputTail(tail, "b".repeat(10));
    expect(combined).toHaveLength(8_192);
    expect(combined).toBe("a".repeat(8_182) + "b".repeat(10));
  });

  it("waits for the packaged renderer page after CDP connects", async () => {
    const pages = [];
    const rendererPage = { url: "file:///packaged-renderer.html" };
    setTimeout(() => pages.push(rendererPage), 1);
    await expect(
      waitForRendererPage(
        { contexts: () => [{ pages: () => pages }] },
        { timeoutMs: 50, intervalMs: 1 },
      ),
    ).resolves.toBe(rendererPage);
  });

  it("reports launch diagnostics when the packaged renderer page is missing", async () => {
    const wait = waitForRendererPage(
      { contexts: () => [{ pages: () => [] }] },
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
