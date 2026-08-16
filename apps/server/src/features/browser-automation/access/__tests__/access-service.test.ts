import { describe, expect, it } from "vitest";
import { browserAutomationPermissionCapability } from "../access-service.js";

describe("browserAutomationPermissionCapability", () => {
  it("maps plan, supervised, and full turns to browser capabilities", () => {
    expect(browserAutomationPermissionCapability("full", "plan")).toBe("observe");
    expect(browserAutomationPermissionCapability("supervised", "build")).toBe("interact");
    expect(browserAutomationPermissionCapability("full", "build")).toBe("privileged");
  });
});
