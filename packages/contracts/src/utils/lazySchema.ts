/**
 * Defers Zod schema construction to first use, then caches the result.
 * Reduces module-load cost for large or deeply-nested schemas.
 */
export function lazySchema<T>(factory: () => T): () => T {
  let cached: T | undefined;
  return () => (cached ??= factory());
}
