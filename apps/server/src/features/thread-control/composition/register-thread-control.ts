import { Lifecycle, type DependencyContainer } from "tsyringe";

import {
  ExternalThreadControlMcpRuntime,
  ExternalThreadControlPairingService,
  InternalThreadControlMcpAuthority,
  InternalThreadControlMcpRuntime,
  ThreadCompletionService,
  ThreadControlMutationReservationService,
  ThreadControlService,
  ThreadTeardownService,
} from "../index.js";
import { ThreadControlApprovalRepo } from "../authority/persistence/thread-control-approval-repo.js";
import { ThreadControlAuditRepo } from "../authority/persistence/thread-control-audit-repo.js";

/** Register thread-control mutation, approval, authority, and lifecycle services. */
export function registerThreadControlServices(container: DependencyContainer): void {
  container.register(
    ThreadControlMutationReservationService,
    { useClass: ThreadControlMutationReservationService },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    ThreadControlApprovalRepo,
    { useClass: ThreadControlApprovalRepo },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    ThreadControlAuditRepo,
    { useClass: ThreadControlAuditRepo },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    ThreadControlService,
    { useClass: ThreadControlService },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    InternalThreadControlMcpAuthority,
    { useClass: InternalThreadControlMcpAuthority },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    InternalThreadControlMcpRuntime,
    { useClass: InternalThreadControlMcpRuntime },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    ExternalThreadControlPairingService,
    { useClass: ExternalThreadControlPairingService },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    ExternalThreadControlMcpRuntime,
    { useClass: ExternalThreadControlMcpRuntime },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    ThreadTeardownService,
    { useClass: ThreadTeardownService },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    ThreadCompletionService,
    { useClass: ThreadCompletionService },
    { lifecycle: Lifecycle.Singleton },
  );
}
