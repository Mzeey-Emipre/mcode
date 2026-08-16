import type { BrowserAutomationTargetIdentity } from "@mcode/contracts";

/** A same-origin iframe target retained for one visible web preview. */
export interface WebBrowserAutomationTarget {
  readonly identity: BrowserAutomationTargetIdentity;
  readonly iframe: HTMLIFrameElement;
  readonly connectionGeneration?: number;
}

/** Dispatch identity required to resolve a mounted web target without widening scope. */
export interface WebBrowserAutomationDispatchIdentity {
  readonly worktreeIdentity: string;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly tabId: string;
  readonly targetGeneration: number;
  readonly desktopInstanceId: string;
  readonly connectionGeneration: number;
}

const targets = new Map<string, WebBrowserAutomationTarget>();
let activeBinding: {
  readonly worktreeIdentity: string;
  readonly desktopInstanceId: string;
  readonly connectionGeneration: number;
} | null = null;

function key(identity: Pick<BrowserAutomationTargetIdentity, "workspaceId" | "threadId" | "tabId">): string {
  return JSON.stringify([identity.workspaceId, identity.threadId, identity.tabId]);
}

/** Register one visible iframe under its exact workspace, thread, and tab identity. */
export function registerWebBrowserAutomationTarget(target: WebBrowserAutomationTarget): void {
  const binding = activeBinding && activeBinding.worktreeIdentity === target.identity.worktreeIdentity
    ? activeBinding
    : null;
  targets.set(key(target.identity), binding
    ? {
      ...target,
      identity: { ...target.identity, connectionId: binding.desktopInstanceId },
      connectionGeneration: binding.connectionGeneration,
    }
    : target);
}

/** Bind mounted web targets to the broker connection that owns this runtime. */
export function bindWebBrowserAutomationTargets(
  worktreeIdentity: string,
  desktopInstanceId: string,
  connectionGeneration: number,
): void {
  activeBinding = { worktreeIdentity, desktopInstanceId, connectionGeneration };
  for (const [targetKey, target] of targets) {
    if (target.identity.worktreeIdentity !== worktreeIdentity) continue;
    targets.set(targetKey, {
      ...target,
      identity: { ...target.identity, connectionId: desktopInstanceId },
      connectionGeneration,
    });
  }
}

/** Clear the broker binding and invalidate mounted targets until the next lease. */
export function clearWebBrowserAutomationBinding(worktreeIdentity: string): void {
  if (activeBinding?.worktreeIdentity === worktreeIdentity) activeBinding = null;
  for (const [targetKey, target] of targets) {
    if (target.identity.worktreeIdentity !== worktreeIdentity) continue;
    targets.set(targetKey, {
      ...target,
      identity: { ...target.identity, connectionId: "pending-desktop" },
      connectionGeneration: undefined,
    });
  }
}

/** Remove one iframe registration only when it still owns the exact target identity and iframe. */
export function unregisterWebBrowserAutomationTarget(
  identity: BrowserAutomationTargetIdentity,
  owner: HTMLIFrameElement,
): void {
  const target = targets.get(key(identity));
  if (target?.identity.generation === identity.generation && target.iframe === owner) {
    targets.delete(key(identity));
  }
}

/** Resolve the currently mounted visible iframe for one exact target identity. */
export function resolveWebBrowserAutomationTarget(
  identity: WebBrowserAutomationDispatchIdentity,
): WebBrowserAutomationTarget | null {
  const target = targets.get(key(identity));
  if (!target || target.identity.generation !== identity.targetGeneration) return null;
  if (target.identity.worktreeIdentity !== identity.worktreeIdentity) return null;
  if (target.identity.connectionId !== identity.desktopInstanceId) return null;
  if (target.connectionGeneration !== identity.connectionGeneration) return null;
  return target;
}

/** Abort and release every web target during test or application teardown. */
export function clearWebBrowserAutomationTargets(): void {
  targets.clear();
  activeBinding = null;
}
