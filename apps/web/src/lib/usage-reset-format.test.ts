import { describe, expect, it } from "vitest";
import { formatUsageResetText } from "./usage-reset-format";

describe("formatUsageResetText", () => {
  const now = new Date("2026-07-03T12:00:00.000Z");

  it("formats relative and compact exact reset text", () => {
    expect(formatUsageResetText("2026-07-03T14:14:00.000Z", now)).toContain(
      "Resets in 2h 14m -",
    );
    expect(formatUsageResetText("2026-07-03T14:14:00.000Z", now)).toContain("Jul 3");
  });

  it("formats day and hour resets", () => {
    expect(formatUsageResetText("2026-07-05T15:00:00.000Z", now)).toContain(
      "Resets in 2d 3h -",
    );
  });

  it("rejects expired timestamps", () => {
    expect(formatUsageResetText("2026-07-03T11:59:59.000Z", now)).toBeNull();
  });

  it("rejects invalid timestamps", () => {
    expect(formatUsageResetText("not-a-date", now)).toBeNull();
  });

  it("rejects missing timestamps", () => {
    expect(formatUsageResetText(undefined, now)).toBeNull();
    expect(formatUsageResetText(null, now)).toBeNull();
  });
});
