function waitForFrames(page, count = 2) {
  return page.evaluate(async (frameCount) => {
    for (let index = 0; index < frameCount; index += 1) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  }, count);
}

function percentile(sortedSamples, quantile) {
  return sortedSamples[Math.ceil(sortedSamples.length * quantile) - 1] ?? Number.NaN;
}

/** Summarize one bounded duration sample set in milliseconds. */
export function summarizeSamples(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    samples: sorted.length,
    minMs: sorted[0] ?? Number.NaN,
    medianMs: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    maxMs: sorted.at(-1) ?? Number.NaN,
  };
}

async function installFixtureRuntime(page) {
  await page.evaluate(async () => {
    const workspaceModule = await import("/src/stores/workspaceStore.ts");
    const threadModule = await import("/src/stores/threadStore.ts");
    const recordModule = await import("/src/stores/thread-record.ts");
    const diffModule = await import("/src/stores/diffStore.ts");

    const workspaceStore = workspaceModule.useWorkspaceStore;
    const threadStore = threadModule.useThreadStore;
    const diffStore = diffModule.useDiffStore;
    const workspace = workspaceStore.getState().workspaces[0];
    if (!workspace) throw new Error("The performance fixture needs one seeded workspace.");

    const now = "2026-08-09T21:00:00.000Z";
    const baseThread = (id, title) => ({
      id,
      workspace_id: workspace.id,
      title,
      status: "idle",
      mode: "local",
      worktree_path: null,
      branch: "main",
      checkout_state: "named",
      base_branch: null,
      worktree_managed: false,
      issue_number: null,
      pr_number: null,
      pr_status: null,
      has_file_changes: false,
      sdk_session_id: null,
      created_at: now,
      updated_at: now,
      model: null,
      provider: "codex",
      deleted_at: null,
      last_context_tokens: null,
      context_window: null,
      reasoning_level: null,
      interaction_mode: null,
      orchestration_mode: null,
      permission_mode: null,
      context_window_mode: null,
      thinking: null,
      codex_fast_mode: null,
      copilot_agent: null,
      default_open_in_app: null,
      parent_thread_id: null,
      forked_from_message_id: null,
      last_compact_summary: null,
    });

    const message = (threadId, index, content, role = index % 2 ? "assistant" : "user") => ({
      id: `${threadId}-message-${index}`,
      thread_id: threadId,
      role,
      content,
      tool_calls: null,
      files_changed: null,
      cost_usd: null,
      tokens_used: null,
      timestamp: now,
      sequence: index + 1,
      attachments: null,
      model: role === "assistant" ? "gpt-5.6" : null,
    });

    const makeMessages = (threadId, count, suffix = "") => Array.from(
      { length: count },
      (_, index) => message(
        threadId,
        index,
        `Fixture message ${index} ${suffix} ${"word ".repeat(30)}`,
      ),
    );

    const activate = (threadId, title, messages, patch = {}) => {
      const thread = baseThread(threadId, title);
      workspaceStore.setState((state) => ({
        ...state,
        activeWorkspaceId: workspace.id,
        activeThreadId: threadId,
        threads: [thread, ...state.threads.filter((item) => item.id !== threadId)],
      }));
      const record = {
        ...recordModule.createEmptyThreadRecord(),
        messages,
        oldestLoadedSequence: messages[0]?.sequence ?? 0,
        ...patch,
      };
      threadStore.setState((state) => ({
        ...state,
        currentThreadId: threadId,
        records: new Map(state.records).set(threadId, record),
      }));
    };

    window.__issue1240 = {
      workspaceId: workspace.id,
      workspaceStore,
      threadStore,
      diffStore,
      recordModule,
      baseThread,
      message,
      makeMessages,
      activate,
      revision: 0,
    };
  });
}

async function timeFixture(page, sampleCount, operation) {
  const samples = [];
  const checks = [];
  await operation(-1);
  for (let index = 0; index < sampleCount; index += 1) {
    const result = await operation(index);
    samples.push(result.durationMs);
    checks.push(result.check);
  }
  return { samples, checks };
}

/** Run the shared frontend renderer matrix against one Playwright page. */
export async function runRendererMatrix(page, runtime, sampleCount = 7) {
  await installFixtureRuntime(page);
  const consoleErrors = [];
  const pageErrors = [];
  const onConsole = (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  };
  const onPageError = (error) => pageErrors.push(String(error));
  page.on("console", onConsole);
  page.on("pageerror", onPageError);

  await page.evaluate(() => {
    window.__issue1240LongTasks = [];
    window.__issue1240LayoutShifts = [];
    new PerformanceObserver((list) => {
      window.__issue1240LongTasks.push(...list.getEntries().map((entry) => entry.duration));
    }).observe({ type: "longtask", buffered: true });
    new PerformanceObserver((list) => {
      window.__issue1240LayoutShifts.push(...list.getEntries().map((entry) => entry.value));
    }).observe({ type: "layout-shift", buffered: true });
  });

  const message100 = await timeFixture(page, sampleCount, async (sample) => {
    const result = await page.evaluate(async (sampleIndex) => {
      const fixture = window.__issue1240;
      const revision = ++fixture.revision;
      const threadId = `perf-message-100-${revision}`;
      const startedAt = performance.now();
      fixture.activate(
        threadId,
        `Message 100 sample ${sampleIndex}`,
        fixture.makeMessages(threadId, 100, String(revision)),
      );
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const list = document.querySelector('[data-testid="message-list"]');
      return {
        durationMs: performance.now() - startedAt,
        check: {
          mountedMessages: list?.querySelectorAll("[data-message-id]").length ?? 0,
          descendants: list?.querySelectorAll("*").length ?? 0,
          totalMessages: fixture.threadStore.getState().records.get(threadId)?.messages.length ?? 0,
        },
      };
    }, sample);
    return result;
  });

  const message1000 = await timeFixture(page, sampleCount, async (sample) => {
    return page.evaluate(async (sampleIndex) => {
      const fixture = window.__issue1240;
      const revision = ++fixture.revision;
      const threadId = `perf-message-1000-${revision}`;
      const startedAt = performance.now();
      fixture.activate(
        threadId,
        `Message 1000 sample ${sampleIndex}`,
        fixture.makeMessages(threadId, 1000, String(revision)),
      );
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const list = document.querySelector('[data-testid="message-list"]');
      return {
        durationMs: performance.now() - startedAt,
        check: {
          mountedMessages: list?.querySelectorAll("[data-message-id]").length ?? 0,
          descendants: list?.querySelectorAll("*").length ?? 0,
          totalMessages: fixture.threadStore.getState().records.get(threadId)?.messages.length ?? 0,
        },
      };
    }, sample);
  });

  const threadSwitch = await timeFixture(page, sampleCount, async (sample) => {
    return page.evaluate(async (sampleIndex) => {
      const fixture = window.__issue1240;
      const revision = ++fixture.revision;
      const leftId = `perf-switch-left-${revision}`;
      const rightId = `perf-switch-right-${revision}`;
      fixture.activate(leftId, "Switch left", fixture.makeMessages(leftId, 1000, "left"));
      const rightThread = fixture.baseThread(rightId, "Switch right");
      const rightRecord = {
        ...fixture.recordModule.createEmptyThreadRecord(),
        messages: fixture.makeMessages(rightId, 1000, "right"),
        oldestLoadedSequence: 1,
      };
      fixture.workspaceStore.setState((state) => ({
        ...state,
        threads: [rightThread, ...state.threads.filter((item) => item.id !== rightId)],
      }));
      fixture.threadStore.setState((state) => ({
        ...state,
        records: new Map(state.records).set(rightId, rightRecord),
      }));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const startedAt = performance.now();
      fixture.workspaceStore.setState({ activeThreadId: rightId });
      fixture.threadStore.setState({ currentThreadId: rightId });
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return {
        durationMs: performance.now() - startedAt,
        check: {
          activeThreadId: fixture.workspaceStore.getState().activeThreadId,
          currentThreadId: fixture.threadStore.getState().currentThreadId,
          visibleThreadId: document.querySelector("[data-message-id]")?.getAttribute("data-thread-id") ?? null,
          sampleIndex,
        },
      };
    }, sample);
  });

  const streaming = await timeFixture(page, sampleCount, async (sample) => {
    return page.evaluate(async (sampleIndex) => {
      const fixture = window.__issue1240;
      const revision = ++fixture.revision;
      const threadId = `perf-stream-${revision}`;
      fixture.activate(threadId, "Streaming fixture", fixture.makeMessages(threadId, 100, "stream"));
      const startedAt = performance.now();
      for (let index = 0; index < 200; index += 1) {
        fixture.threadStore.getState().handleAgentEvent({
          type: "textDelta",
          threadId,
          delta: `token-${index} `,
          isFinalResponse: true,
        });
      }
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const record = fixture.threadStore.getState().records.get(threadId);
      return {
        durationMs: performance.now() - startedAt,
        check: {
          streamingLength: record?.streaming.length ?? 0,
          expectedLength: Array.from({ length: 200 }, (_, index) => `token-${index} `).join("").length,
          sampleIndex,
        },
      };
    }, sample);
  });

  const denseNarrative = await timeFixture(page, sampleCount, async (sample) => {
    return page.evaluate(async (sampleIndex) => {
      const fixture = window.__issue1240;
      const revision = ++fixture.revision;
      const threadId = `perf-narrative-${revision}`;
      const messageId = `${threadId}-assistant`;
      const assistant = fixture.message(
        threadId,
        0,
        "Dense narrative fixture completed.",
        "assistant",
      );
      assistant.id = messageId;
      const tools = Array.from({ length: 60 }, (_, index) => ({
        id: `${messageId}-tool-${index}`,
        message_id: messageId,
        parent_tool_call_id: null,
        tool_name: index % 3 === 0 ? "Bash" : index % 3 === 1 ? "Read" : "Edit",
        input_summary: `Fixture input ${index}`,
        output_summary: `Fixture output ${index}`,
        status: "completed",
        started_at: "2026-08-09T21:00:00.000Z",
        completed_at: "2026-08-09T21:00:00.010Z",
        sort_order: index * 3,
      }));
      const thoughts = Array.from({ length: 20 }, (_, index) => ({
        id: `${messageId}-thought-${index}`,
        message_id: messageId,
        text: `Narration segment ${index} ${"detail ".repeat(20)}`,
        started_at: "2026-08-09T21:00:00.000Z",
        ended_at: "2026-08-09T21:00:00.010Z",
        sort_order: index * 3 + 1,
      }));
      const hooks = Array.from({ length: 10 }, (_, index) => ({
        id: `${messageId}-hook-${index}`,
        message_id: messageId,
        hook_name: "PreToolUse",
        tool_name: "Bash",
        phase: "permission",
        payload: "{}",
        duration_ms: 3,
        did_block: false,
        started_at: "2026-08-09T21:00:00.000Z",
        ended_at: "2026-08-09T21:00:00.003Z",
        sort_order: index * 3 + 2,
      }));
      const startedAt = performance.now();
      fixture.activate(threadId, "Dense narrative fixture", [assistant], {
        narrativeByMessage: { [messageId]: { tools, thoughts, hooks } },
      });
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const row = document.querySelector(`[data-message-id="${messageId}"]`);
      const list = document.querySelector('[data-testid="message-list"]');
      return {
        durationMs: performance.now() - startedAt,
        check: {
          sourceRows: tools.length + thoughts.length + hooks.length,
          descendants: list?.querySelectorAll("*").length ?? 0,
          visible: Boolean(row),
          thoughtVisible: list?.textContent?.includes("Narration segment 0") ?? false,
          toolVisible: list?.textContent?.includes("Fixture input 0") ?? false,
          sampleIndex,
        },
      };
    }, sample);
  });

  const markdownShiki = await timeFixture(page, sampleCount, async (sample) => {
    return page.evaluate(async (sampleIndex) => {
      const fixture = window.__issue1240;
      const revision = ++fixture.revision;
      const threadId = `perf-markdown-${revision}`;
      const blocks = Array.from({ length: 10 }, (_, block) => {
        const code = Array.from(
          { length: 100 },
          (_, line) => `const fixture_${block}_${line}: number = ${line};`,
        ).join("\n");
        return `## Block ${block}\n\n\`\`\`typescript\n${code}\n\`\`\``;
      }).join("\n\n");
      const assistant = fixture.message(threadId, 0, blocks, "assistant");
      const startedAt = performance.now();
      fixture.activate(threadId, "Markdown and Shiki fixture", [assistant]);
      const deadline = startedAt + 8_000;
      let highlightedBlocks = 0;
      do {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        highlightedBlocks = document.querySelectorAll(
          `[data-thread-id="${threadId}"] .shiki`,
        ).length;
      } while (highlightedBlocks < 10 && performance.now() < deadline);
      return {
        durationMs: performance.now() - startedAt,
        check: {
          highlightedBlocks,
          codeBlocks: document.querySelectorAll(`[data-thread-id="${threadId}"] [data-code-block]`).length,
          sampleIndex,
        },
      };
    }, sample);
  });

  const panelTransitions = await timeFixture(page, sampleCount, async (sample) => {
    return page.evaluate(async (sampleIndex) => {
      const fixture = window.__issue1240;
      const threadId = fixture.threadStore.getState().currentThreadId;
      if (!threadId) throw new Error("The panel fixture needs an active thread.");
      const startedAt = performance.now();
      fixture.diffStore.getState().showRightPanel(fixture.workspaceId, threadId);
      fixture.diffStore.getState().setRightPanelTab(fixture.workspaceId, threadId, "preview");
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      fixture.diffStore.getState().setRightPanelTab(fixture.workspaceId, threadId, "terminal");
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const state = fixture.diffStore.getState().getRightPanel(fixture.workspaceId, threadId);
      return {
        durationMs: performance.now() - startedAt,
        check: {
          visible: state.visible,
          activeTab: state.activeTab,
          browserTabOpen: state.openTabs.includes("preview"),
          terminalTabOpen: state.openTabs.includes("terminal"),
          terminalShell: Boolean(document.querySelector('[data-testid="terminal-pool-slot"]')),
          sampleIndex,
        },
      };
    }, sample);
  });

  await waitForFrames(page);
  const observations = await page.evaluate(() => ({
    longTasks: window.__issue1240LongTasks,
    layoutShifts: window.__issue1240LayoutShifts,
    usedJsHeapBytes: performance.memory?.usedJSHeapSize ?? null,
    totalJsHeapBytes: performance.memory?.totalJSHeapSize ?? null,
    documentDescendants: document.querySelectorAll("*").length,
  }));

  page.off("console", onConsole);
  page.off("pageerror", onPageError);
  const metrics = Object.fromEntries(
    Object.entries({
      message100,
      message1000,
      threadSwitch,
      streaming,
      denseNarrative,
      markdownShiki,
      panelTransitions,
    }).map(([name, result]) => [name, {
      ...summarizeSamples(result.samples),
      checks: result.checks,
    }]),
  );

  return {
    runtime,
    sampleCount,
    metrics,
    observations,
    consoleErrors,
    pageErrors,
  };
}
