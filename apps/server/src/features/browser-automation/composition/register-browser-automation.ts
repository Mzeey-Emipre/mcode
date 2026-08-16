import type { DependencyContainer } from "tsyringe";

import {
  BrowserAutomationCredentialRegistry,
  BrowserAutomationSessionLease,
} from "../index.js";

/** Register browser automation credentials and the shared session lease. */
export function registerBrowserAutomation(container: DependencyContainer): void {
  const credentials = new BrowserAutomationCredentialRegistry();
  container.registerInstance(BrowserAutomationCredentialRegistry, credentials);
  container.registerInstance(
    BrowserAutomationSessionLease,
    new BrowserAutomationSessionLease(credentials),
  );
}
