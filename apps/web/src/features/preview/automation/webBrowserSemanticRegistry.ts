const MAX_REGISTERED_ELEMENTS = 256;
const MAX_SEMANTIC_ID_CHARS = 1_024;

/** Retains bounded, document-scoped element identities without mutating page DOM. */
export class WebBrowserSemanticRegistry {
  private readonly idsByElement = new WeakMap<Element, string>();
  private readonly elementsById = new Map<string, Element>();
  private nextSyntheticId = 1;

  /** Returns a stable identity for one element, preferring its real DOM identity. */
  register(ownerDocument: Document, element: Element, preferredId?: string): string {
    const existing = this.idsByElement.get(element);
    if (existing) {
      const retained = this.elementsById.get(existing);
      if (retained === element && element.ownerDocument === ownerDocument && element.isConnected) return existing;
      if (!retained && element.ownerDocument === ownerDocument && element.isConnected) {
        this.retain(existing, element);
        return existing;
      }
      this.idsByElement.delete(element);
      if (retained === element) this.elementsById.delete(existing);
    }
    const usablePreferred = preferredId && preferredId.length <= MAX_SEMANTIC_ID_CHARS
      ? preferredId
      : undefined;
    const preferredOwner = usablePreferred ? this.elementsById.get(usablePreferred) : undefined;
    const id = usablePreferred && (!preferredOwner || preferredOwner === element)
      ? usablePreferred
      : this.nextSyntheticIdFor(ownerDocument);
    this.retain(id, element);
    return id;
  }

  private retain(id: string, element: Element): void {
    this.idsByElement.set(element, id);
    this.elementsById.set(id, element);
    while (this.elementsById.size > MAX_REGISTERED_ELEMENTS) {
      const oldest = this.elementsById.keys().next().value;
      if (oldest === undefined) break;
      this.elementsById.delete(oldest);
    }
  }

  /** Resolves a registry identity only while its element remains in the same document. */
  resolve(ownerDocument: Document, id: string): HTMLElement | null {
    const element = this.elementsById.get(id);
    if (!element) return null;
    if (element.ownerDocument !== ownerDocument || !element.isConnected) {
      this.elementsById.delete(id);
      return null;
    }
    return element as HTMLElement;
  }

  private nextSyntheticIdFor(ownerDocument: Document): string {
    let id: string;
    do {
      id = `element-${this.nextSyntheticId++}`;
    } while (
      this.elementsById.has(id) ||
      ownerDocument.getElementById(id) !== null ||
      ownerDocument.querySelector(`[data-automation-id="${id}"]`) !== null
    );
    return id;
  }
}

const registriesByDocument = new WeakMap<Document, WebBrowserSemanticRegistry>();

/** Returns the bounded semantic registry associated with one document lifetime. */
export function getWebBrowserSemanticRegistry(ownerDocument: Document): WebBrowserSemanticRegistry {
  const existing = registriesByDocument.get(ownerDocument);
  if (existing) return existing;
  const registry = new WebBrowserSemanticRegistry();
  registriesByDocument.set(ownerDocument, registry);
  return registry;
}
