/** Returns true only for the DEV child-continuation prototype URL. */
export function isChildContinuationPrototypeEnabled(): boolean {
  if (!import.meta.env.DEV || typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("prototype") === "child-continuation";
}
