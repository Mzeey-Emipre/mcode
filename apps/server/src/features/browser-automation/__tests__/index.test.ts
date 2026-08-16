import "reflect-metadata";
import { describe, expect, it } from "vitest";
import * as browserAutomation from "../index";

describe("browser automation feature boundary", () => {
  it("exposes only the composition-root browser automation symbols", () => {
    expect(Object.keys(browserAutomation).sort()).toStrictEqual([
      "BrowserAutomationBroker",
      "BrowserAutomationCredentialRegistry",
      "BrowserAutomationMcpHandler",
      "BrowserAutomationSessionLease",
      "BrowserAutomationTelemetry",
      "browserAutomationPermissionCapability",
    ]);
  });
});
