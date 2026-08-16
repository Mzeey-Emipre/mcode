import { Lifecycle, type DependencyContainer } from "tsyringe";

import { CleanupJobRepo } from "../cleanup/persistence/cleanup-job-repo.js";
import { ThreadRepo } from "../persistence/thread-repo.js";

/** Register thread-control repositories and their string-keyed aliases. */
export function registerThreadRepositories(container: DependencyContainer): void {
  container.register(
    ThreadRepo,
    { useClass: ThreadRepo },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register("ThreadRepo", {
    useFactory: (c) => c.resolve(ThreadRepo),
  });
}

/** Register cleanup persistence after agent task persistence. */
export function registerCleanupRepository(container: DependencyContainer): void {
  container.register(
    CleanupJobRepo,
    { useClass: CleanupJobRepo },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register("CleanupJobRepo", {
    useFactory: (c) => c.resolve(CleanupJobRepo),
  });
}
