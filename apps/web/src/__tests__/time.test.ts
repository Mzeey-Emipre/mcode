import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { formatDuration, relativeTime } from "@/lib/time";

describe("formatDuration", () => {
  it("formats seconds below a minute", () => {
    expect(formatDuration(59)).toBe("59s");
  });

  it("formats the minute threshold", () => {
    expect(formatDuration(60)).toBe("1m");
  });

  it("formats minutes with remaining seconds", () => {
    expect(formatDuration(75)).toBe("1m 15s");
  });

  it("formats the hour threshold", () => {
    expect(formatDuration(3600)).toBe("1h");
  });

  it("formats hours with remaining minutes", () => {
    expect(formatDuration(7070)).toBe("1h 57m");
  });

  it("formats days with remaining hours", () => {
    expect(formatDuration(90061)).toBe("1d 1h");
  });
});

describe("relativeTime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("< 1 minute ago returns 'now'", () => {
    vi.setSystemTime(new Date("2026-03-23T12:00:30Z"));
    expect(relativeTime("2026-03-23T12:00:00Z")).toBe("now");
  });

  it("5 minutes ago returns '5m'", () => {
    vi.setSystemTime(new Date("2026-03-23T12:05:00Z"));
    expect(relativeTime("2026-03-23T12:00:00Z")).toBe("5m");
  });

  it("3 hours ago returns '3h'", () => {
    vi.setSystemTime(new Date("2026-03-23T15:00:00Z"));
    expect(relativeTime("2026-03-23T12:00:00Z")).toBe("3h");
  });

  it("2 days ago returns '2d'", () => {
    vi.setSystemTime(new Date("2026-03-25T12:00:00Z"));
    expect(relativeTime("2026-03-23T12:00:00Z")).toBe("2d");
  });

  it("45 days ago returns '1mo'", () => {
    vi.setSystemTime(new Date("2026-05-07T12:00:00Z"));
    expect(relativeTime("2026-03-23T12:00:00Z")).toBe("1mo");
  });

  it("future date clamped to 'now'", () => {
    vi.setSystemTime(new Date("2026-03-23T12:00:00Z"));
    expect(relativeTime("2026-03-23T13:00:00Z")).toBe("now");
  });
});
