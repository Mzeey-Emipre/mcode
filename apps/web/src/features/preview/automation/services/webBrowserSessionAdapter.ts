import type {
  BrowserAutomationHostDispatch,
  BrowserAutomationResponse,
} from "@mcode/contracts";
import {
  executeWebInteraction,
  observeWebHumanInput,
  type WebInteractionGuard,
} from "../webBrowserInteractionExecutor";
import type {
  BrowserSessionRuntimeAdapter,
} from "./browserSessionDriver";

export interface WebBrowserSessionAdapterOptions {
  resolveDocument: (dispatch: BrowserAutomationHostDispatch) => Document | null;
  resolveSignal: (dispatch: BrowserAutomationHostDispatch, signal: AbortSignal) => AbortSignal;
  getControlEpoch: (dispatch: BrowserAutomationHostDispatch) => number;
  getTargetGeneration: (dispatch: BrowserAutomationHostDispatch) => number;
  onHumanInput: (dispatch: BrowserAutomationHostDispatch) => void;
  onObserver: (dispatch: BrowserAutomationHostDispatch, dispose: () => void) => void;
  executeNonInteraction: (dispatch: BrowserAutomationHostDispatch, signal: AbortSignal) => Promise<BrowserAutomationResponse>;
}

function failureResponse(
  dispatch: BrowserAutomationHostDispatch,
  code: "TAB_UNAVAILABLE" | "UNSUPPORTED_OPERATION",
  message: string,
): BrowserAutomationResponse {
  return {
    contractVersion: dispatch.request.contractVersion,
    requestId: dispatch.request.requestId,
    sequence: dispatch.request.sequence,
    ok: false,
    error: { code, message, retryable: true },
  };
}

/** Web runtime adapter for every Browser v2 command, including DOM interaction. */
export class WebBrowserSessionAdapter implements BrowserSessionRuntimeAdapter {
  constructor(private readonly options: WebBrowserSessionAdapterOptions) {}

  async execute(
    dispatch: BrowserAutomationHostDispatch,
    signal: AbortSignal,
  ): Promise<BrowserAutomationResponse> {
    const operation = dispatch.request.operation;
    if (operation !== "click" && operation !== "type") {
      return this.options.executeNonInteraction(dispatch, signal);
    }
    const ownerDocument = this.options.resolveDocument(dispatch);
    if (!ownerDocument) return failureResponse(dispatch, "TAB_UNAVAILABLE", "Browser target is unavailable");
    const operationSignal = this.options.resolveSignal(dispatch, signal);
    const guard: WebInteractionGuard = {
      signal: operationSignal,
      deadline: dispatch.request.deadline,
      expectedControlEpoch: dispatch.request.expectedControlEpoch,
      targetGeneration: dispatch.target.targetGeneration,
      getControlEpoch: () => this.options.getControlEpoch(dispatch),
      getTargetGeneration: () => this.options.getTargetGeneration(dispatch),
    };
    this.options.onObserver(
      dispatch,
      observeWebHumanInput(ownerDocument, () => this.options.onHumanInput(dispatch)),
    );
    return executeWebInteraction(ownerDocument, dispatch, guard);
  }
}
