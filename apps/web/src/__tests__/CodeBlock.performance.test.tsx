import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

vi.mock("../hooks/useHighlighter", () => ({
  useHighlighter: vi.fn(),
}));

vi.mock("../hooks/useTheme", () => ({
  useShikiTheme: vi.fn(() => "github-dark"),
}));

describe("CodeBlock performance boundary", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("drains commit, insertion, and completion for one measured response", async () => {
    vi.stubEnv("VITE_MCODE_PERFORMANCE_MODE", "profiling");
    vi.resetModules();

    const [{ CodeBlock }, highlighterModule, performanceModule] = await Promise.all([
      import("../components/chat/CodeBlock"),
      import("../hooks/useHighlighter"),
      import("../performance/shiki-performance"),
    ]);
    performanceModule.setShikiPerformanceCapture(true);
    const requestStartedAtMs = performance.now();
    performanceModule.startShikiMeasurement("hl-1", requestStartedAtMs);
    performanceModule.recordShikiWorkerTiming("hl-1", {
      phase: "cold",
      workerStartupMs: 1,
      highlighterCreationMs: 2,
      grammarLoadMs: 3,
      codeToHtmlMs: 4,
      responseBytes: 42,
      workerPostedAtEpochMs: Date.now(),
    }, requestStartedAtMs + 1, Date.now() + 1);
    vi.mocked(highlighterModule.useHighlighter).mockReturnValue({
      html: '<pre class="shiki"><code>highlighted</code></pre>',
      measurementId: "hl-1",
    });

    render(<CodeBlock code="const x = 1;" language="typescript" isStreaming={false} />);

    const stages = performanceModule
      .drainShikiPerformanceObservations()
      .map((observation) => observation.stage);
    expect(stages).toEqual(expect.arrayContaining([
      "reactCommit",
      "htmlInsertion",
      "totalCompletion",
    ]));
  });
});
