import { Lifecycle, type DependencyContainer } from "tsyringe";

import { SettingsService } from "../settings-service.js";

/** Register the user settings service and its string-keyed alias. */
export function registerSettingsService(container: DependencyContainer): void {
  container.register(
    SettingsService,
    { useClass: SettingsService },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register("SettingsService", {
    useFactory: (c) => c.resolve(SettingsService),
  });
}
