import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHAT_HIGHLIGHT_MAX_CACHE_BYTES,
  CHAT_HIGHLIGHT_MAX_CACHE_ENTRY_BYTES,
  CHAT_HIGHLIGHT_MAX_SOURCE_BYTES,
  CHAT_HIGHLIGHT_MAX_TRACKED_SUBSCRIBERS,
  createChatHighlightCoordinator,
  type ChatHighlightCoordinator,
  type ChatHighlightResponse,
  type ChatHighlightScheduler,
  type ChatHighlightWorker,
} from "../chat-highlight-coordinator";
import type { WorkerResponse } from "../shiki-worker-client";

interface PendingRequest {
  id: string;
  resolve: (response: WorkerResponse | null) => void;
}

function createHarness() {
  const worker: ChatHighlightWorker = {
    postMessage: vi.fn(),
  };
  const pending = new Map<string, PendingRequest["resolve"]>();
  let nextId = 0;
  let generation = 0;
  const frames: FrameRequestCallback[] = [];
  const idleCallbacks: IdleRequestCallback[] = [];
  const scheduler: ChatHighlightScheduler = {
    requestAnimationFrame: vi.fn((callback) => {
      frames.push(callback);
      return frames.length;
    }),
    cancelAnimationFrame: vi.fn(),
    requestIdleCallback: vi.fn((callback) => {
      idleCallbacks.push(callback);
      return idleCallbacks.length;
    }),
    cancelIdleCallback: vi.fn(),
  };
  const coordinator = createChatHighlightCoordinator({
    getWorker: () => worker,
    workerGeneration: () => generation,
    pending,
    nextRequestId: () => `chat-${nextId++}`,
    scheduler,
  });

  function flushFrame() {
    frames.shift()?.(performance.now());
  }

  function flushIdle() {
    idleCallbacks.shift()?.({
      didTimeout: false,
      timeRemaining: () => 50,
    });
  }

  function resolveNext(response: ChatHighlightResponse | null) {
    const [id, resolve] = pending.entries().next().value as [string, PendingRequest["resolve"]];
    pending.delete(id);
    resolve(response ? { ...response, id } : null);
  }

  return {
    coordinator,
    worker,
    pending,
    scheduler,
    frames,
    idleCallbacks,
    flushFrame,
    flushIdle,
    resolveNext,
    setGeneration(value: number) {
      generation = value;
    },
  };
}

function request(
  coordinator: ChatHighlightCoordinator,
  code: string,
  onResult: (html: string | null) => void,
  visible = true,
) {
  return coordinator.request({
    code,
    language: "ts",
    theme: "github-dark",
    visible,
    onResult,
  });
}

describe("chat highlight coordinator", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("starts visible work before offscreen work and uses idle capacity for offscreen work", () => {
    const harness = createHarness();
    const visibleResult = vi.fn();
    const offscreenResult = vi.fn();

    request(harness.coordinator, "visible", visibleResult, true);
    request(harness.coordinator, "offscreen", offscreenResult, false);

    expect(harness.worker.postMessage).toHaveBeenCalledTimes(1);
    expect(harness.worker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ code: "visible", language: "typescript" }),
    );

    harness.resolveNext({ id: "chat-0", type: "highlight", html: "visible-html" });
    expect(harness.worker.postMessage).toHaveBeenCalledTimes(1);
    harness.flushFrame();
    expect(visibleResult).toHaveBeenCalledWith("visible-html");

    harness.flushIdle();
    expect(harness.worker.postMessage).toHaveBeenCalledTimes(2);
    expect(harness.worker.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ code: "offscreen" }),
    );
  });

  it("deduplicates identical in-flight work and delivers at most one result per frame", () => {
    const harness = createHarness();
    const firstResult = vi.fn();
    const secondResult = vi.fn();

    request(harness.coordinator, "same", firstResult);
    request(harness.coordinator, "same", secondResult);
    expect(harness.worker.postMessage).toHaveBeenCalledTimes(1);

    harness.resolveNext({ id: "chat-0", type: "highlight", html: "same-html" });
    harness.flushFrame();
    expect(firstResult).toHaveBeenCalledTimes(1);
    expect(secondResult).not.toHaveBeenCalled();
    harness.flushFrame();
    expect(secondResult).toHaveBeenCalledWith("same-html");
  });

  it("bounds duplicate-key fan-out and releases subscriber and delivery capacity", () => {
    const harness = createHarness();
    const handles = Array.from({ length: CHAT_HIGHLIGHT_MAX_TRACKED_SUBSCRIBERS }, () =>
      request(harness.coordinator, "fan-out", vi.fn()),
    );
    const rejectedResult = vi.fn();

    request(harness.coordinator, "fan-out", rejectedResult);

    expect(rejectedResult).toHaveBeenCalledWith(null);
    expect(harness.worker.postMessage).toHaveBeenCalledTimes(1);

    handles[0]?.cancel();
    request(harness.coordinator, "replacement", vi.fn());
    expect(harness.worker.postMessage).toHaveBeenCalledTimes(2);

    harness.resolveNext({ id: "chat-0", type: "highlight", html: "fan-out-html" });
    handles[1]?.cancel();
    harness.flushFrame();
    while (harness.frames.length > 0) harness.flushFrame();
    request(harness.coordinator, "second-replacement", vi.fn());
    expect(harness.worker.postMessage).toHaveBeenCalledTimes(3);
  });

  it("rejects source at one-byte over the UTF-8 limit without posting oversized code", () => {
    const harness = createHarness();
    const prefix = "é".repeat((CHAT_HIGHLIGHT_MAX_SOURCE_BYTES - 2) / 2);
    const boundaryCode = `${prefix}aa`;
    const oversizedCode = `${prefix}aé`;
    const boundaryResult = vi.fn();

    request(harness.coordinator, boundaryCode, boundaryResult);
    expect(harness.worker.postMessage).toHaveBeenCalledTimes(1);

    harness.resolveNext({ id: "chat-0", type: "highlight", html: "boundary-html" });
    harness.flushFrame();
    expect(boundaryResult).toHaveBeenCalledWith("boundary-html");

    const oversizedResult = vi.fn();
    request(harness.coordinator, oversizedCode, oversizedResult);

    expect(harness.worker.postMessage).toHaveBeenCalledTimes(1);
    expect(oversizedResult).toHaveBeenCalledWith(null);
  });

  it("rejects oversized entries and evicts least-recently-used entries by retained bytes", () => {
    const harness = createHarness();
    const entry = "x".repeat(CHAT_HIGHLIGHT_MAX_CACHE_ENTRY_BYTES - 64);
    const oversized = "x".repeat(CHAT_HIGHLIGHT_MAX_CACHE_ENTRY_BYTES + 1);

    for (let index = 0; index < 9; index += 1) {
      request(harness.coordinator, String.fromCharCode(97 + index), vi.fn());
      harness.resolveNext({ id: `chat-${index}`, type: "highlight", html: entry });
    }
    while (harness.frames.length > 0) harness.flushFrame();
    expect(harness.coordinator.getCacheBytes()).toBeLessThanOrEqual(CHAT_HIGHLIGHT_MAX_CACHE_BYTES);

    const cachedA = vi.fn();
    request(harness.coordinator, "a", cachedA);
    expect(harness.worker.postMessage).toHaveBeenCalledTimes(10);
    harness.resolveNext({ id: "chat-9", type: "highlight", html: "a-again" });
    harness.flushFrame();
    expect(cachedA).toHaveBeenCalledWith("a-again");

    request(harness.coordinator, "oversized", vi.fn());
    harness.resolveNext({ id: "chat-10", type: "highlight", html: oversized });
    request(harness.coordinator, "oversized", vi.fn());
    expect(harness.worker.postMessage).toHaveBeenCalledTimes(12);
    expect(harness.coordinator.getCacheBytes()).toBeLessThanOrEqual(CHAT_HIGHLIGHT_MAX_CACHE_BYTES);
  });

  it("does not reuse cache entries from an earlier worker generation", () => {
    const harness = createHarness();
    const firstResult = vi.fn();
    request(harness.coordinator, "generation-cache", firstResult);
    harness.resolveNext({ id: "chat-0", type: "highlight", html: "cached" });
    while (harness.frames.length > 0) harness.flushFrame();

    harness.setGeneration(1);
    const secondResult = vi.fn();
    request(harness.coordinator, "generation-cache", secondResult);
    expect(harness.worker.postMessage).toHaveBeenCalledTimes(2);
    harness.resolveNext({ id: "chat-1", type: "highlight", html: "fresh" });
    harness.flushFrame();
    expect(secondResult).toHaveBeenCalledWith("fresh");
  });

  it("turns malformed worker responses into plain fallback without caching", () => {
    const harness = createHarness();
    const malformedResult = vi.fn();

    request(harness.coordinator, "malformed", malformedResult);
    harness.resolveNext({
      id: "chat-0",
      type: "highlight",
      html: 42,
      timing: { unexpected: true },
    } as unknown as ChatHighlightResponse);
    harness.flushFrame();

    expect(malformedResult).toHaveBeenCalledWith(null);
    const retryResult = vi.fn();
    request(harness.coordinator, "malformed", retryResult);
    expect(harness.worker.postMessage).toHaveBeenCalledTimes(2);
  });

  it("invalidates pending callbacks and subscribers on reset", () => {
    const harness = createHarness();
    const result = vi.fn();
    request(harness.coordinator, "reset", result);
    const [, resolve] = harness.pending.entries().next().value as [string, PendingRequest["resolve"]];

    harness.coordinator.reset();
    resolve({ id: "chat-0", type: "highlight", html: "late" });
    while (harness.frames.length > 0) harness.flushFrame();
    expect(result).not.toHaveBeenCalled();
    expect(harness.coordinator.getCacheBytes()).toBe(0);

    request(harness.coordinator, "after-reset", vi.fn());
    expect(harness.worker.postMessage).toHaveBeenCalledTimes(2);
  });

  it("demotes an unstarted visible job when every subscriber becomes offscreen", () => {
    const harness = createHarness();
    for (let index = 0; index < 4; index += 1) {
      request(harness.coordinator, `active-${index}`, vi.fn());
    }
    const result = vi.fn();
    const handle = request(harness.coordinator, "demote", result, true);
    expect(harness.worker.postMessage).toHaveBeenCalledTimes(4);

    handle.setVisible(false);
    while (harness.pending.size > 0) {
      harness.resolveNext({ id: "active", type: "highlight", html: "active" });
    }
    while (harness.frames.length > 0) harness.flushFrame();
    expect(harness.worker.postMessage).toHaveBeenCalledTimes(4);
    harness.flushIdle();
    expect(harness.worker.postMessage).toHaveBeenCalledTimes(5);
    harness.resolveNext({ id: "demote", type: "highlight", html: "demoted" });
    harness.flushFrame();
    expect(result).toHaveBeenCalledWith("demoted");
  });

  it("does not deliver cancelled, stale-generation, or failed results", () => {
    const harness = createHarness();
    const cancelledResult = vi.fn();
    const staleResult = vi.fn();
    const failedResult = vi.fn();

    const cancelled = request(harness.coordinator, "cancelled", cancelledResult);
    cancelled.cancel();
    harness.resolveNext({ id: "chat-0", type: "highlight", html: "stale" });
    harness.flushFrame();
    expect(cancelledResult).not.toHaveBeenCalled();

    request(harness.coordinator, "generation", staleResult);
    harness.setGeneration(1);
    harness.resolveNext({ id: "chat-1", type: "highlight", html: "stale" });
    harness.flushFrame();
    expect(staleResult).toHaveBeenCalledWith(null);

    request(harness.coordinator, "failed", failedResult);
    harness.resolveNext(null);
    harness.flushFrame();
    expect(failedResult).toHaveBeenCalledWith(null);
  });
});
