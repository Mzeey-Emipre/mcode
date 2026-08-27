import { useCallback, useEffect, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { createVList, type VList, type VListPlugin } from "vlist";
import "vlist/styles";

type ProbeRowKind = "message" | "narrative-flow" | "narrative-indicator" | "permission-request" | "turn-changes";

type ProbeRow = {
  readonly id: string;
  readonly kind: ProbeRowKind;
  readonly title: string;
  readonly initialDraft: string;
};

type LifecycleEvent = {
  readonly type: "effect-mount" | "effect-cleanup" | "ref-attach" | "ref-detach" | "body-cleanup" | "control";
  readonly rowId: string;
  readonly poolItemId?: string | null;
};

type TransitionObservation = {
  readonly cause: "set-items" | "native-scroll";
  readonly visibleRowIdsBefore: readonly string[];
  readonly visibleRowIdsAfter: readonly string[];
  readonly beforeReactPreUnmount: readonly TransitionRowObservation[];
  readonly afterReactPreUnmountBeforeVListPhase2: readonly TransitionRowObservation[];
  readonly afterVListPhase2: readonly TransitionRowObservation[];
  readonly incomingRowsAfterVListPhase2: readonly PoolHostObservation[];
};

type TransitionRowObservation = {
  readonly rowId: string;
  readonly poolHostToken: string | null;
  readonly portalHostConnected: boolean;
  readonly effectCleanupCount: number;
  readonly refDetachCount: number;
};

type PoolHostObservation = {
  readonly rowId: string;
  readonly poolHostToken: string | null;
};

type RenderedRow = {
  readonly rowId: string;
  readonly kind: string;
};

type FocusObservation = {
  readonly activeProbeInputRowId: string | null;
  readonly previousInputConnected?: boolean;
  readonly previousInputActive?: boolean;
};

type LifecycleProbeResult = {
  readonly renderedRows: {
    readonly afterA: readonly RenderedRow[];
    readonly afterAToB: readonly RenderedRow[];
    readonly afterBToA: readonly RenderedRow[];
    readonly beforeNativeScroll: readonly RenderedRow[];
    readonly afterFirstNativeScroll: readonly RenderedRow[];
    readonly afterNativeScrollRecycle: readonly RenderedRow[];
  };
  readonly values: {
    readonly a: {
      readonly draftAfterEdit: string;
      readonly buttonAfterClick: string | null;
      readonly draftAfterReturn: string;
      readonly buttonAfterReturn: string | null;
    };
    readonly b: {
      readonly draftBeforeFocus: string;
      readonly buttonBeforeClick: string | null;
      readonly buttonAfterClick: string | null;
    };
  };
  readonly focus: {
    readonly afterAFocus: FocusObservation;
    readonly afterAToB: FocusObservation;
    readonly afterBFocus: FocusObservation;
    readonly afterBToA: FocusObservation;
  };
  readonly bodyPortals: {
    readonly afterA: Readonly<Record<string, boolean>>;
    readonly afterAToB: Readonly<Record<string, boolean>>;
    readonly afterBToA: Readonly<Record<string, boolean>>;
    readonly afterDispose: Readonly<Record<string, boolean>>;
  };
  readonly transitions: readonly TransitionObservation[];
  readonly events: readonly LifecycleEvent[];
  readonly prepend: {
    readonly anchorRowId: string;
    readonly anchorTopBefore: number;
    readonly anchorTopAfter: number;
    readonly draftBefore: string;
    readonly draftAfter: string;
    readonly effectMountCountBefore: number;
    readonly effectMountCountAfter: number;
    readonly refAttachCountBefore: number;
    readonly refAttachCountAfter: number;
    readonly portalHostTokenBefore: string | null;
    readonly portalHostTokenAfter: string | null;
    readonly visibleRowIdsAfter: readonly string[];
  };
};

type PortalEntry = {
  readonly row: ProbeRow;
  readonly host: HTMLElement;
  readonly bodyPortalHost: HTMLElement;
};

type PendingOutgoingRow = {
  readonly row: ProbeRow;
  readonly host: HTMLElement;
  readonly poolHostToken: string | null;
};

type PendingTransition = {
  readonly cause: TransitionObservation["cause"];
  readonly visibleRowIdsBefore: readonly string[];
  readonly visibleRowsAfter: readonly ProbeRow[];
  readonly outgoingRows: readonly PendingOutgoingRow[];
  readonly beforeReactPreUnmount: readonly TransitionRowObservation[];
  readonly afterReactPreUnmountBeforeVListPhase2: readonly TransitionRowObservation[];
};

type PendingRelocatedRow = {
  readonly rowId: string;
  readonly host: HTMLElement;
  readonly targetIndex: number;
};

const A_ROW: ProbeRow = {
  id: "message:thread-vlist-probe:A",
  kind: "message",
  title: "Assistant message A",
  initialDraft: "draft-A",
};

const B_ROW: ProbeRow = {
  id: "narrative-flow:turn-vlist-probe:B",
  kind: "narrative-flow",
  title: "Narrative flow B",
  initialDraft: "draft-B",
};

const STATIC_ROWS: readonly ProbeRow[] = [
  {
    id: "narrative-indicator:turn-vlist-probe",
    kind: "narrative-indicator",
    title: "Narrative indicator",
    initialDraft: "indicator-draft",
  },
  {
    id: "permission-request:permission-vlist-probe",
    kind: "permission-request",
    title: "Permission request",
    initialDraft: "permission-draft",
  },
  {
    id: "turn-changes:message-vlist-probe",
    kind: "turn-changes",
    title: "Turn changes",
    initialDraft: "changes-draft",
  },
];

const SCROLL_ROWS: readonly ProbeRow[] = Array.from({ length: 12 }, (_, index) => ({
  id: `message:scroll-vlist-probe:${index}`,
  kind: "message" as const,
  title: `Scroll message ${index}`,
  initialDraft: `scroll-draft-${index}`,
}));

const PREPEND_ROWS: readonly ProbeRow[] = Array.from({ length: 2 }, (_, index) => ({
  id: `message:prepend-vlist-probe:${index}`,
  kind: "message" as const,
  title: `Prepended message ${index}`,
  initialDraft: `prepend-draft-${index}`,
}));

const BODY_PORTAL_ROW_IDS = [A_ROW.id, B_ROW.id, ...STATIC_ROWS.map((row) => row.id), ...SCROLL_ROWS.map((row) => row.id)];

function rowsWithPrimary(primary: ProbeRow): ProbeRow[] {
  return [primary, ...STATIC_ROWS];
}

function waitForFrames(count = 2): Promise<void> {
  return new Promise((resolve) => {
    let remaining = count;
    const nextFrame = (): void => {
      remaining -= 1;
      if (remaining === 0) {
        resolve();
        return;
      }
      requestAnimationFrame(nextFrame);
    };
    requestAnimationFrame(nextFrame);
  });
}

function eventCount(events: readonly LifecycleEvent[], type: LifecycleEvent["type"], rowId: string): number {
  return events.filter((event) => event.type === type && event.rowId === rowId).length;
}

function getInput(rowId: string): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>(`[data-vlist-probe-input="${rowId}"]`);
  if (!input) throw new Error(`The probe input for ${rowId} was not rendered.`);
  return input;
}

function getButton(rowId: string): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(`[data-vlist-probe-button="${rowId}"]`);
  if (!button) throw new Error(`The probe button for ${rowId} was not rendered.`);
  return button;
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!setter) throw new Error("The browser does not expose the native input value setter.");
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function bodyPortalExists(rowId: string): boolean {
  return document.querySelector(`[data-vlist-probe-body="${rowId}"]`) !== null;
}

function captureBodyPortals(): Readonly<Record<string, boolean>> {
  return Object.fromEntries(BODY_PORTAL_ROW_IDS.map((rowId) => [rowId, bodyPortalExists(rowId)]));
}

function captureRenderedRows(): readonly RenderedRow[] {
  return [...document.querySelectorAll<HTMLElement>("[data-vlist-probe-row]")].map((row) => ({
    rowId: row.dataset.vlistProbeRow ?? "",
    kind: row.dataset.vlistProbeKind ?? "",
  }));
}

function captureFocus(previousInput?: HTMLInputElement): FocusObservation {
  const activeElement = document.activeElement;
  const activeProbeInputRowId = activeElement instanceof HTMLInputElement
    ? activeElement.dataset.vlistProbeInput ?? null
    : null;
  return {
    activeProbeInputRowId,
    ...(previousInput
      ? {
          previousInputConnected: previousInput.isConnected,
          previousInputActive: activeElement === previousInput,
        }
      : {}),
  };
}

function ProbeRowView({
  row,
  bodyPortalHost,
  record,
}: {
  readonly row: ProbeRow;
  readonly bodyPortalHost: HTMLElement;
  readonly record: (event: LifecycleEvent) => void;
}) {
  const [draft, setDraft] = useState(row.initialDraft);
  const [clickCount, setClickCount] = useState(0);
  useEffect(() => {
    record({ type: "effect-mount", rowId: row.id });
    return () => {
      record({ type: "effect-cleanup", rowId: row.id });
      bodyPortalHost.remove();
      record({ type: "body-cleanup", rowId: row.id });
    };
  }, [bodyPortalHost, record, row.id]);

  const setRowElement = useCallback((element: HTMLElement | null): void => {
    if (element) {
      record({
        type: "ref-attach",
        rowId: row.id,
        poolItemId: element.closest<HTMLElement>(".vlist-prototype-item")?.dataset.id ?? null,
      });
      return;
    }
    record({ type: "ref-detach", rowId: row.id });
  }, [record, row.id]);

  return (
    <>
      <section
        ref={setRowElement}
        data-vlist-probe-row={row.id}
        data-vlist-probe-kind={row.kind}
        style={{ border: "1px solid #5b6475", borderRadius: 6, margin: 6, padding: 8, background: "#171d29", color: "#edf2f7" }}
      >
        <strong>{row.title}</strong>
        <p style={{ margin: "6px 0" }}>{row.kind}</p>
        <label>
          Draft
          <input
            data-vlist-probe-input={row.id}
            value={draft}
            onChange={(event) => setDraft(event.currentTarget.value)}
          />
        </label>
        <button
          type="button"
          data-vlist-probe-button={row.id}
          onClick={() => {
            setClickCount((count) => count + 1);
            record({ type: "control", rowId: row.id });
          }}
        >
          {`${row.title} action ${clickCount}`}
        </button>
      </section>
      {createPortal(
        <output data-vlist-probe-body={row.id}>{`document portal for ${row.id}`}</output>,
        bodyPortalHost,
      )}
    </>
  );
}

function ProbePortals({ entries, record }: { readonly entries: readonly PortalEntry[]; readonly record: (event: LifecycleEvent) => void }) {
  return entries.map((entry) => createPortal(
    <ProbeRowView row={entry.row} bodyPortalHost={entry.bodyPortalHost} record={record} />,
    entry.host,
    entry.row.id,
  ));
}

class VListReactAdapterProbe {
  private readonly container: HTMLElement;
  private readonly reactContainer: HTMLElement;
  private readonly parkingContainer: HTMLElement;
  private readonly reactRoot: Root;
  private readonly rowsById = new Map<string, ProbeRow>();
  private readonly portalHostsByRowId = new Map<string, HTMLElement>();
  private readonly bodyPortalHosts = new Map<string, HTMLElement>();
  private readonly poolHostTokens = new WeakMap<HTMLElement, string>();
  private readonly portalHostTokens = new WeakMap<HTMLElement, string>();
  private readonly events: LifecycleEvent[] = [];
  private readonly transitions: TransitionObservation[] = [];
  private readonly list: VList<ProbeRow>;
  private nextPoolHostToken = 0;
  private nextPortalHostToken = 0;
  private rows: readonly ProbeRow[] = [];
  private reactRowsById = new Map<string, ProbeRow>();
  private pendingTransition: PendingTransition | null = null;
  private pendingRelocatedRows: readonly PendingRelocatedRow[] = [];
  private pendingPrependCount = 0;
  private nextTransitionCause: TransitionObservation["cause"] = "native-scroll";

  constructor() {
    this.container = document.createElement("div");
    this.container.dataset.vlistProbe = "container";
    this.container.style.cssText = "height:180px;width:620px;overflow:hidden;padding:8px;background:#0f1720";
    document.body.appendChild(this.container);

    this.reactContainer = document.createElement("div");
    this.reactContainer.dataset.vlistProbe = "react-root";
    document.body.appendChild(this.reactContainer);
    this.reactRoot = createRoot(this.reactContainer);

    this.parkingContainer = document.createElement("div");
    this.parkingContainer.hidden = true;
    this.parkingContainer.dataset.vlistProbe = "parking";
    document.body.appendChild(this.parkingContainer);

    const reactLifecyclePlugin: VListPlugin<ProbeRow> = {
      name: "react-lifecycle-probe",
      priority: 100,
      hooks: {
        onCalculate: (state) => this.preUnmountRows(state),
        onCommit: (state) => this.commitRows(state),
      },
    };

    this.list = createVList<ProbeRow>({
      container: this.container,
      classPrefix: "vlist-prototype",
      overscan: 0,
      item: {
        height: 84,
        template: (row) => {
          const portalHost = document.createElement("div");
          portalHost.dataset.vlistProbeHost = row.id;
          this.portalHostsByRowId.set(row.id, portalHost);
          return portalHost;
        },
      },
    }, [reactLifecyclePlugin]);
    this.list.element.style.height = "180px";
    this.getViewport().style.cssText = "height:180px;overflow:auto";
  }

  private record = (event: LifecycleEvent): void => {
    this.events.push(event);
  };

  private getBodyPortalHost(rowId: string): HTMLElement {
    const existing = this.bodyPortalHosts.get(rowId);
    if (existing?.isConnected) return existing;
    const bodyPortalHost = document.createElement("div");
    bodyPortalHost.dataset.vlistProbeBodyHost = rowId;
    document.body.appendChild(bodyPortalHost);
    this.bodyPortalHosts.set(rowId, bodyPortalHost);
    return bodyPortalHost;
  }

  private getPoolHostToken(poolHost: HTMLElement | null): string | null {
    if (!poolHost) return null;
    const existing = this.poolHostTokens.get(poolHost);
    if (existing) return existing;
    const token = `pool-host-${this.nextPoolHostToken}`;
    this.nextPoolHostToken += 1;
    this.poolHostTokens.set(poolHost, token);
    return token;
  }

  private getPortalHostToken(portalHost: HTMLElement | null): string | null {
    if (!portalHost) return null;
    const existing = this.portalHostTokens.get(portalHost);
    if (existing) return existing;
    const token = `portal-host-${this.nextPortalHostToken}`;
    this.nextPortalHostToken += 1;
    this.portalHostTokens.set(portalHost, token);
    return token;
  }

  private getViewport(): HTMLElement {
    const viewport = this.list?.element.querySelector<HTMLElement>(".vlist-prototype-viewport")
      ?? this.container.querySelector<HTMLElement>(".vlist-prototype-viewport");
    if (!viewport) throw new Error("vlist did not create its viewport.");
    return viewport;
  }

  private getVisibleRows(state: { readonly visibleCount: number; readonly visibleIndices: Int32Array }): ProbeRow[] {
    const visibleRows: ProbeRow[] = [];
    for (let offset = 0; offset < state.visibleCount; offset += 1) {
      const row = this.rows[state.visibleIndices[offset] ?? -1];
      const ownedRow = row ? this.rowsById.get(row.id) : undefined;
      if (ownedRow) visibleRows.push(ownedRow);
    }
    return visibleRows;
  }

  private renderRows(rows: readonly ProbeRow[]): void {
    const entries = rows.map((row): PortalEntry => {
      const host = this.portalHostsByRowId.get(row.id);
      if (!host?.isConnected) throw new Error(`vlist did not keep a portal host for ${row.id}.`);
      return { row, host, bodyPortalHost: this.getBodyPortalHost(row.id) };
    });
    flushSync(() => {
      this.reactRoot.render(<ProbePortals entries={entries} record={this.record} />);
    });
    this.reactRowsById = new Map(rows.map((row) => [row.id, row]));
  }

  private captureOutgoingRows(rows: readonly PendingOutgoingRow[]): readonly TransitionRowObservation[] {
    return rows.map(({ row, host, poolHostToken }) => ({
      rowId: row.id,
      poolHostToken,
      portalHostConnected: host.isConnected,
      effectCleanupCount: eventCount(this.events, "effect-cleanup", row.id),
      refDetachCount: eventCount(this.events, "ref-detach", row.id),
    }));
  }

  private applyPendingPrepend(state: {
    readonly visibleCount: number;
    readonly visibleIndices: Int32Array;
    readonly visibleOffsets: Float64Array;
    readonly visibleSizes: Float64Array;
    scrollPosition: number;
    startIndex: number;
  }): void {
    if (this.pendingPrependCount === 0) return;
    const addedHeight = this.pendingPrependCount * 84;
    state.scrollPosition += addedHeight;
    this.getViewport().scrollTop = state.scrollPosition;
    for (let offset = 0; offset < state.visibleCount; offset += 1) {
      const index = (state.visibleIndices[offset] ?? 0) + this.pendingPrependCount;
      state.visibleIndices[offset] = index;
      state.visibleOffsets[offset] = index * 84;
      state.visibleSizes[offset] = 84;
    }
    state.startIndex += this.pendingPrependCount;
    this.pendingPrependCount = 0;
  }

  private parkRelocatedRows(visibleRowsAfter: readonly ProbeRow[]): readonly PendingRelocatedRow[] {
    return visibleRowsAfter.flatMap((row) => {
      const previousRow = this.reactRowsById.get(row.id);
      if (!previousRow) return [];
      const host = this.portalHostsByRowId.get(row.id);
      if (!host) throw new Error(`The adapter lost the retained portal host for ${row.id}.`);
      const currentIndex = Number(host.parentElement?.dataset.index ?? Number.NaN);
      const targetIndex = this.rows.findIndex((candidate) => candidate.id === row.id);
      if (currentIndex === targetIndex && previousRow === row) return [];
      this.parkingContainer.appendChild(host);
      return [{ rowId: row.id, host, targetIndex }];
    });
  }

  private restoreRelocatedRows(): void {
    for (const { rowId, host, targetIndex } of this.pendingRelocatedRows) {
      const replacementHost = this.portalHostsByRowId.get(rowId);
      const targetPoolHost = replacementHost?.parentElement;
      if (!replacementHost || !targetPoolHost || targetPoolHost.dataset.index !== String(targetIndex)) {
        throw new Error(`vlist did not create the expected relocated host for ${rowId}.`);
      }
      replacementHost.remove();
      targetPoolHost.appendChild(host);
      this.portalHostsByRowId.set(rowId, host);
    }
    this.pendingRelocatedRows = [];
  }

  private preUnmountRows(state: {
    readonly visibleCount: number;
    readonly visibleIndices: Int32Array;
    readonly visibleOffsets: Float64Array;
    readonly visibleSizes: Float64Array;
    scrollPosition: number;
    startIndex: number;
  }): void {
    this.applyPendingPrepend(state);
    const visibleRowsAfter = this.getVisibleRows(state);
    const visibleRowIdsAfter = new Set(visibleRowsAfter.map((row) => row.id));
    const outgoingRows = [...this.reactRowsById.values()]
      .filter((row) => !visibleRowIdsAfter.has(row.id))
      .map((row): PendingOutgoingRow => {
        const host = this.portalHostsByRowId.get(row.id);
        if (!host) throw new Error(`The adapter lost the portal host for ${row.id}.`);
        return { row, host, poolHostToken: this.getPoolHostToken(host.parentElement) };
      });
    this.pendingRelocatedRows = this.parkRelocatedRows(visibleRowsAfter);
    if (outgoingRows.length === 0 && this.pendingRelocatedRows.length === 0) return;

    const retainedRows = visibleRowsAfter.filter((row) => this.reactRowsById.has(row.id));
    const beforeReactPreUnmount = this.captureOutgoingRows(outgoingRows);
    const visibleRowIdsBefore = [...this.reactRowsById.keys()];
    this.renderRows(retainedRows);
    if (outgoingRows.length === 0) return;

    this.pendingTransition = {
      cause: this.nextTransitionCause,
      visibleRowIdsBefore,
      visibleRowsAfter,
      outgoingRows,
      beforeReactPreUnmount,
      afterReactPreUnmountBeforeVListPhase2: this.captureOutgoingRows(outgoingRows),
    };
    this.nextTransitionCause = "native-scroll";
  }

  private commitRows(state: { readonly visibleCount: number; readonly visibleIndices: Int32Array }): void {
    const visibleRows = this.getVisibleRows(state);
    this.restoreRelocatedRows();
    this.renderRows(visibleRows);
    const transition = this.pendingTransition;
    if (!transition) return;

    this.transitions.push({
      cause: transition.cause,
      visibleRowIdsBefore: transition.visibleRowIdsBefore,
      visibleRowIdsAfter: transition.visibleRowsAfter.map((row) => row.id),
      beforeReactPreUnmount: transition.beforeReactPreUnmount,
      afterReactPreUnmountBeforeVListPhase2: transition.afterReactPreUnmountBeforeVListPhase2,
      afterVListPhase2: this.captureOutgoingRows(transition.outgoingRows),
      incomingRowsAfterVListPhase2: transition.visibleRowsAfter
        .filter((row) => !transition.visibleRowIdsBefore.includes(row.id))
        .map((row) => {
          const host = this.portalHostsByRowId.get(row.id);
          return {
            rowId: row.id,
            poolHostToken: this.getPoolHostToken(host?.parentElement ?? null),
          };
        }),
    });
    this.pendingTransition = null;
  }

  private async waitForCommittedRows(rows: readonly ProbeRow[]): Promise<void> {
    for (let frame = 0; frame < 10; frame += 1) {
      if (rows.every((row) => this.reactRowsById.has(row.id)
        && this.portalHostsByRowId.get(row.id)?.isConnected)) return;
      await waitForFrames(1);
    }
    throw new Error("vlist did not commit every requested React row.");
  }

  async show(rows: readonly ProbeRow[]): Promise<void> {
    this.rows = rows;
    this.rowsById.clear();
    for (const row of rows) this.rowsById.set(row.id, row);
    this.nextTransitionCause = "set-items";
    this.list.setItems([...rows]);
    await this.waitForCommittedRows(rows.slice(0, 1));
    await waitForFrames();
  }

  async scrollNativelyTo(index: number): Promise<void> {
    const expectedRow = this.rows[index];
    if (!expectedRow) throw new Error(`The native scroll target ${index} is outside the row range.`);
    const viewport = this.getViewport();
    viewport.scrollTop = index * 84;
    viewport.dispatchEvent(new Event("scroll"));
    await this.waitForCommittedRows([expectedRow]);
    await waitForFrames();
  }

  async prependWithAnchor(rows: readonly ProbeRow[], anchorRow: ProbeRow): Promise<void> {
    this.rows = [...rows, ...this.rows];
    for (const row of rows) this.rowsById.set(row.id, row);
    this.pendingPrependCount = rows.length;
    this.nextTransitionCause = "set-items";
    this.list.prependItems([...rows]);
    await this.waitForCommittedRows([anchorRow]);
    await waitForFrames();
  }

  getRowTop(rowId: string): number {
    const row = document.querySelector<HTMLElement>(`[data-vlist-probe-row="${rowId}"]`);
    if (!row) throw new Error(`The probe row for ${rowId} was not rendered.`);
    return row.getBoundingClientRect().top;
  }

  getPortalHostTokenForRow(rowId: string): string | null {
    return this.getPortalHostToken(this.portalHostsByRowId.get(rowId) ?? null);
  }

  getEvents(): readonly LifecycleEvent[] {
    return this.events;
  }

  getTransitions(): readonly TransitionObservation[] {
    return this.transitions;
  }

  async dispose(): Promise<void> {
    this.reactRoot.unmount();
    await waitForFrames();
    this.list.destroy();
    this.container.remove();
    this.reactContainer.remove();
    this.parkingContainer.remove();
    for (const bodyPortalHost of this.bodyPortalHosts.values()) {
      bodyPortalHost.remove();
    }
  }
}

/** Runs the vlist React portal lifecycle probe. */
export async function runVListReactAdapterLifecycleProbe(): Promise<LifecycleProbeResult> {
  const adapter = new VListReactAdapterProbe();
  let adapterDisposed = false;
  try {
    await adapter.show(rowsWithPrimary(A_ROW));
    const renderedRowsAfterA = captureRenderedRows();
    const bodyPortalsAfterA = captureBodyPortals();
    const aInput = getInput(A_ROW.id);
    aInput.focus();
    const focusAfterAFocus = captureFocus();
    setInputValue(aInput, "edited-A");
    getButton(A_ROW.id).click();
    await waitForFrames();
    const aDraftAfterEdit = getInput(A_ROW.id).value;
    const aButtonAfterClick = getButton(A_ROW.id).textContent;

    await adapter.show(rowsWithPrimary(B_ROW));
    const renderedRowsAfterAToB = captureRenderedRows();
    const bodyPortalsAfterAToB = captureBodyPortals();
    const focusAfterAToB = captureFocus(aInput);
    const bInput = getInput(B_ROW.id);
    const bDraftBeforeFocus = bInput.value;
    const bButtonBeforeClick = getButton(B_ROW.id).textContent;
    bInput.focus();
    const focusAfterBFocus = captureFocus();
    getButton(B_ROW.id).click();
    await waitForFrames();
    const bButtonAfterClick = getButton(B_ROW.id).textContent;

    await adapter.show(rowsWithPrimary(A_ROW));
    const renderedRowsAfterBToA = captureRenderedRows();
    const bodyPortalsAfterBToA = captureBodyPortals();
    const focusAfterBToA = captureFocus(bInput);
    const aDraftAfterReturn = getInput(A_ROW.id).value;
    const aButtonAfterReturn = getButton(A_ROW.id).textContent;

    await adapter.show(SCROLL_ROWS);
    const renderedRowsBeforeNativeScroll = captureRenderedRows();
    await adapter.scrollNativelyTo(4);
    const renderedRowsAfterFirstNativeScroll = captureRenderedRows();
    await adapter.scrollNativelyTo(8);
    const renderedRowsAfterNativeScrollRecycle = captureRenderedRows();

    await adapter.dispose();
    adapterDisposed = true;
    const prependAdapter = new VListReactAdapterProbe();
    let prependAdapterDisposed = false;
    let prepend: LifecycleProbeResult["prepend"];
    try {
      await prependAdapter.show(SCROLL_ROWS);
      await prependAdapter.scrollNativelyTo(4);
      const anchorRow = SCROLL_ROWS[4];
      if (!anchorRow) throw new Error("The prepend probe anchor row is missing.");
      const anchorInput = getInput(anchorRow.id);
      setInputValue(anchorInput, "edited-before-prepend");
      await waitForFrames();
      const anchorTopBefore = prependAdapter.getRowTop(anchorRow.id);
      const effectMountCountBefore = eventCount(prependAdapter.getEvents(), "effect-mount", anchorRow.id);
      const refAttachCountBefore = eventCount(prependAdapter.getEvents(), "ref-attach", anchorRow.id);
      const portalHostTokenBefore = prependAdapter.getPortalHostTokenForRow(anchorRow.id);
      await prependAdapter.prependWithAnchor(PREPEND_ROWS, anchorRow);
      prepend = {
        anchorRowId: anchorRow.id,
        anchorTopBefore,
        anchorTopAfter: prependAdapter.getRowTop(anchorRow.id),
        draftBefore: "edited-before-prepend",
        draftAfter: getInput(anchorRow.id).value,
        effectMountCountBefore,
        effectMountCountAfter: eventCount(prependAdapter.getEvents(), "effect-mount", anchorRow.id),
        refAttachCountBefore,
        refAttachCountAfter: eventCount(prependAdapter.getEvents(), "ref-attach", anchorRow.id),
        portalHostTokenBefore,
        portalHostTokenAfter: prependAdapter.getPortalHostTokenForRow(anchorRow.id),
        visibleRowIdsAfter: captureRenderedRows().map(({ rowId }) => rowId),
      };
      await prependAdapter.dispose();
      prependAdapterDisposed = true;
    } catch (error) {
      if (!prependAdapterDisposed) await prependAdapter.dispose();
      throw error;
    }
    return {
      renderedRows: {
        afterA: renderedRowsAfterA,
        afterAToB: renderedRowsAfterAToB,
        afterBToA: renderedRowsAfterBToA,
        beforeNativeScroll: renderedRowsBeforeNativeScroll,
        afterFirstNativeScroll: renderedRowsAfterFirstNativeScroll,
        afterNativeScrollRecycle: renderedRowsAfterNativeScrollRecycle,
      },
      values: {
        a: {
          draftAfterEdit: aDraftAfterEdit,
          buttonAfterClick: aButtonAfterClick,
          draftAfterReturn: aDraftAfterReturn,
          buttonAfterReturn: aButtonAfterReturn,
        },
        b: {
          draftBeforeFocus: bDraftBeforeFocus,
          buttonBeforeClick: bButtonBeforeClick,
          buttonAfterClick: bButtonAfterClick,
        },
      },
      focus: {
        afterAFocus: focusAfterAFocus,
        afterAToB: focusAfterAToB,
        afterBFocus: focusAfterBFocus,
        afterBToA: focusAfterBToA,
      },
      bodyPortals: {
        afterA: bodyPortalsAfterA,
        afterAToB: bodyPortalsAfterAToB,
        afterBToA: bodyPortalsAfterBToA,
        afterDispose: captureBodyPortals(),
      },
      transitions: adapter.getTransitions(),
      events: adapter.getEvents(),
      prepend,
    };
  } catch (error) {
    if (!adapterDisposed) await adapter.dispose();
    throw error;
  }
}
