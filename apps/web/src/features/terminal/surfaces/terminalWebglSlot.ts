/**
 * Ensures at most one xterm WebGL renderer is active across the persistent
 * terminal pool. Extra contexts trigger context loss, ReadPixels stalls, and
 * viewport corruption on thread switch in Electron.
 */

const releaseByPtyId = new Map<string, () => void>();

/**
 * Takes the sole WebGL slot for `ptyId`, releasing any other PTY's WebGL first.
 */
export function claimWebglSlot(ptyId: string, release: () => void): void {
  for (const [id, releaseFn] of releaseByPtyId) {
    if (id !== ptyId) {
      try {
        releaseFn();
      } catch (err) {
        console.error("[terminal] WebGL release callback failed", id, err);
      }
    }
  }
  releaseByPtyId.clear();
  releaseByPtyId.set(ptyId, release);
}

/**
 * Releases WebGL for `ptyId` if it currently owns the slot.
 */
export function releaseWebglSlot(ptyId: string): void {
  const release = releaseByPtyId.get(ptyId);
  if (release) {
    release();
    releaseByPtyId.delete(ptyId);
  }
}

/**
 * Clears slot bookkeeping without calling release (terminal already torn down).
 */
export function clearWebglSlot(ptyId: string): void {
  releaseByPtyId.delete(ptyId);
}
