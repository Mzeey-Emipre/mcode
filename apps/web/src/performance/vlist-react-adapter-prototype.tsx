import { useCallback, useEffect, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { createVList, type VList } from "vlist";
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
  readonly fromRowId: string;
  readonly toRowId: string;
  readonly previousPoolHostToken: string | null;
  readonly currentPoolHostToken: string | null;
  readonly previousPortalHostConnectedAfterVListMutation: boolean;
  readonly effectCleanupCountBeforeVListMutation: number;
  readonly effectCleanupCountAfterVListMutation: number;
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
};

type PortalEntry = {
  readonly row: ProbeRow;
  readonly host: HTMLElement;
  readonly bodyPortalHost: HTMLElement;
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

const BODY_PORTAL_ROW_IDS = [A_ROW.id, B_ROW.id, ...STATIC_ROWS.map((row) => row.id)];

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
  private readonly reactRoot: Root;
  private readonly portalHosts = new Map<string, HTMLElement>();
  private readonly bodyPortalHosts = new Map<string, HTMLElement>();
  private readonly poolHostTokens = new WeakMap<HTMLElement, string>();
  private readonly events: LifecycleEvent[] = [];
  private readonly list: VList<ProbeRow>;
  private nextPoolHostToken = 0;
  private rows: readonly ProbeRow[] = [];

  constructor() {
    this.container = document.createElement("div");
    this.container.dataset.vlistProbe = "container";
    this.container.style.cssText = "height:420px;width:620px;overflow:hidden;padding:8px;background:#0f1720";
    document.body.appendChild(this.container);

    this.reactContainer = document.createElement("div");
    this.reactContainer.dataset.vlistProbe = "react-root";
    document.body.appendChild(this.reactContainer);
    this.reactRoot = createRoot(this.reactContainer);

    this.list = createVList<ProbeRow>({
      container: this.container,
      classPrefix: "vlist-prototype",
      overscan: 0,
      item: {
        height: 84,
        template: (row) => {
          const portalHost = document.createElement("div");
          portalHost.dataset.vlistProbeHost = row.id;
          this.portalHosts.set(row.id, portalHost);
          return portalHost;
        },
      },
    });
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

  private renderPortals(): void {
    const entries = this.rows.map((row): PortalEntry => {
      const host = this.portalHosts.get(row.id);
      if (!host?.isConnected) throw new Error(`vlist did not keep a portal host for ${row.id}.`);
      return { row, host, bodyPortalHost: this.getBodyPortalHost(row.id) };
    });
    flushSync(() => {
      this.reactRoot.render(<ProbePortals entries={entries} record={this.record} />);
    });
  }

  private async waitForPortalHosts(rows: readonly ProbeRow[]): Promise<void> {
    for (let frame = 0; frame < 10; frame += 1) {
      if (rows.every((row) => this.portalHosts.get(row.id)?.isConnected)) return;
      await waitForFrames(1);
    }
    throw new Error("vlist did not render every portal host.");
  }

  async show(rows: readonly ProbeRow[]): Promise<TransitionObservation | null> {
    const previousPrimary = this.rows[0];
    const previousPortalHost = previousPrimary ? this.portalHosts.get(previousPrimary.id) : undefined;
    const previousPoolHostToken = this.getPoolHostToken(previousPortalHost?.parentElement ?? null);
    const effectCleanupCountBeforeVListMutation = previousPrimary
      ? eventCount(this.events, "effect-cleanup", previousPrimary.id)
      : 0;

    this.rows = rows;
    this.list.setItems([...rows]);
    await this.waitForPortalHosts(rows);

    const currentPrimary = rows[0];
    const currentPortalHost = this.portalHosts.get(currentPrimary.id);
    if (!currentPortalHost) throw new Error(`vlist did not return a portal host for ${currentPrimary.id}.`);
    const transition = previousPrimary
      ? {
          fromRowId: previousPrimary.id,
          toRowId: currentPrimary.id,
          previousPoolHostToken,
          currentPoolHostToken: this.getPoolHostToken(currentPortalHost.parentElement),
          previousPortalHostConnectedAfterVListMutation: previousPortalHost?.isConnected ?? false,
          effectCleanupCountBeforeVListMutation,
          effectCleanupCountAfterVListMutation: eventCount(this.events, "effect-cleanup", previousPrimary.id),
        }
      : null;

    this.renderPortals();
    await waitForFrames();
    return transition;
  }

  getEvents(): readonly LifecycleEvent[] {
    return this.events;
  }

  async dispose(): Promise<void> {
    this.reactRoot.unmount();
    await waitForFrames();
    this.list.destroy();
    this.container.remove();
    this.reactContainer.remove();
    for (const bodyPortalHost of this.bodyPortalHosts.values()) {
      bodyPortalHost.remove();
    }
  }
}

/** Runs the vlist React portal lifecycle rejection probe. */
export async function runVListReactAdapterLifecycleProbe(): Promise<LifecycleProbeResult> {
  const adapter = new VListReactAdapterProbe();
  const transitions: TransitionObservation[] = [];
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

    const toB = await adapter.show(rowsWithPrimary(B_ROW));
    if (toB) transitions.push(toB);
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

    const toA = await adapter.show(rowsWithPrimary(A_ROW));
    if (toA) transitions.push(toA);
    const renderedRowsAfterBToA = captureRenderedRows();
    const bodyPortalsAfterBToA = captureBodyPortals();
    const focusAfterBToA = captureFocus(bInput);
    const aDraftAfterReturn = getInput(A_ROW.id).value;
    const aButtonAfterReturn = getButton(A_ROW.id).textContent;

    await adapter.dispose();
    return {
      renderedRows: {
        afterA: renderedRowsAfterA,
        afterAToB: renderedRowsAfterAToB,
        afterBToA: renderedRowsAfterBToA,
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
      transitions,
      events: adapter.getEvents(),
    };
  } catch (error) {
    await adapter.dispose();
    throw error;
  }
}
