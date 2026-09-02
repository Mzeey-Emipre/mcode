import { instanceCachingFactory, Lifecycle, type DependencyContainer } from "tsyringe";
import { ThreadStartupRepo } from "../persistence/thread-startup-repo.js";
import { ThreadStartupService } from "../thread-startup-service.js";

/** Register thread startup persistence and lifecycle services. */
export function registerThreadStartupServices(container: DependencyContainer): void {
  container.register(
    ThreadStartupRepo,
    { useClass: ThreadStartupRepo },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(ThreadStartupService, {
    useFactory: instanceCachingFactory(
      (childContainer) => new ThreadStartupService(childContainer.resolve(ThreadStartupRepo)),
    ),
  });
}
