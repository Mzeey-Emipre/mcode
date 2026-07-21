import type { Page, WebSocketRoute } from "@playwright/test";
import { getDefaultSettings, type Settings } from "@mcode/contracts";

/**
 * Recursively merge `patch` onto `base`, mirroring the server's deep-merge
 * semantics for `settings.update`. Plain objects merge key-by-key; arrays and
 * primitives in `patch` overwrite. Lets the mocked `settings.update` echo a
 * full, merged Settings object the way the real server does, so optimistic
 * reads in the store reflect the change.
 */
function deepMerge(base: unknown, patch: unknown): unknown {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
    return patch;
  }
  const baseObj =
    base && typeof base === "object" && !Array.isArray(base)
      ? (base as Record<string, unknown>)
      : {};
  const out: Record<string, unknown> = { ...baseObj };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    out[key] = deepMerge(baseObj[key], value);
  }
  return out;
}

/**
 * Optional overrides for RPC responses. Keyed by method name.
 * The value is either:
 * - a static result that will be returned verbatim, or
 * - a function called with the request params at invocation time. The return
 *   value (or its resolved value) is sent as the result. Functional handlers
 *   let tests record calls or shape responses based on params.
 */
export type RpcOverrides = Record<
  string,
  unknown | ((params?: unknown) => unknown | Promise<unknown>)
>;

/**
 * Controller returned by {@link mockWebSocketServer} to send server-initiated
 * push notifications to the client.
 */
export interface WsController {
  /** Send a JSON-RPC notification (no `id`) to the connected client. */
  sendNotification(method: string, params?: unknown): Promise<void>;
  /**
   * Send a server-initiated push event using the transport's
   * `{ type: "push", channel, data }` wire shape so that `pushEmitter`
   * listeners in ws-events.ts receive the event correctly.
   */
  sendPush(channel: string, data: unknown): Promise<void>;
}

/**
 * Mock the WebSocket server so the WS transport connects and RPC calls
 * resolve instead of hanging forever. Returns proper JSON-RPC error
 * responses for parse failures and unknown methods.
 *
 * Returns a {@link WsController} that can push server-initiated notifications.
 */
export async function mockWebSocketServer(
  page: Page,
  overrides: RpcOverrides = {},
): Promise<WsController> {
  // Server-of-record for settings within this page session. `settings.update`
  // merges onto it and echoes the result; `settings.get` reads from it, so a
  // UI-driven setting change (e.g. theme) round-trips and updates the store.
  let currentSettings: Settings =
    "settings.get" in overrides && typeof overrides["settings.get"] !== "function"
      ? (overrides["settings.get"] as Settings)
      : getDefaultSettings();

  let resolveWs: (ws: WebSocketRoute) => void;
  let wsResolved = false;
  const wsReady = new Promise<WebSocketRoute>((r) => {
    resolveWs = r;
  });

  // The normal test server uses a four-digit Vite port, while agent runtimes
  // use five-digit ports for both Vite and Mcode. Resolve the controller only
  // after the socket sends an RPC method so pushes target Mcode, not HMR.
  await page.routeWebSocket(/ws:\/\/(?:localhost|127\.0\.0\.1):\d{5}/, (ws) => {
    ws.onMessage(async (data) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        ws.send(
          JSON.stringify({
            id: null,
            error: { code: -32700, message: "Parse error" },
          }),
        );
        return;
      }
      const method = msg.method as string;
      if (!wsResolved && typeof method === "string") {
        wsResolved = true;
        resolveWs(ws);
      }
      // Check overrides first
      if (method in overrides) {
        const handler = overrides[method];
        // If the override is a function, call it now with the request's params
        // so the test can observe the call timing/args. Static values are sent
        // verbatim. The try/catch ensures a thrown handler returns a JSON-RPC
        // error response; without it the RPC stays unresolved and the test
        // hangs until Playwright's outer timeout fires.
        try {
          const result =
            typeof handler === "function"
              ? await (handler as (params?: unknown) => unknown | Promise<unknown>)(msg.params)
              : handler;
          ws.send(JSON.stringify({ id: msg.id, result }));
        } catch (err) {
          ws.send(
            JSON.stringify({
              id: msg.id,
              error: {
                code: -32000,
                message: err instanceof Error ? err.message : "Override handler failed",
              },
            }),
          );
        }
        return;
      }
      if (method === "conversation.page" && "message.list" in overrides) {
        const handler = overrides["message.list"];
        try {
          const messageResult =
            typeof handler === "function"
              ? await (handler as (params?: unknown) => unknown | Promise<unknown>)(msg.params)
              : handler;
          const paginated = Array.isArray(messageResult)
            ? { messages: messageResult, hasMore: false, answeredPlanMessageIds: [] }
            : messageResult as { messages?: unknown[]; hasMore?: boolean; answeredPlanMessageIds?: unknown[] };
          ws.send(JSON.stringify({
            id: msg.id,
            result: {
              messages: paginated.messages ?? [],
              hasMore: paginated.hasMore ?? false,
              answeredPlanMessageIds: paginated.answeredPlanMessageIds ?? [],
              narrativeByMessage: {},
            },
          }));
        } catch (err) {
          ws.send(
            JSON.stringify({
              id: msg.id,
              error: {
                code: -32000,
                message: err instanceof Error ? err.message : "Override handler failed",
              },
            }),
          );
        }
        return;
      }
      // Default responses
      let result: unknown;
      // `message.list` matches the generic *.list branch below but must return a
      // paginated shape; returning [] leaves loadMessages in an error state.
      if (method === "message.list") {
        result = { messages: [], hasMore: false, answeredPlanMessageIds: [] };
      } else if (method === "conversation.page") {
        result = {
          messages: [],
          hasMore: false,
          answeredPlanMessageIds: [],
          narrativeByMessage: {},
        };
      } else if (method === "thread.recent") {
        result = [];
      } else if (method === "permission.listPending") {
        result = [];
      } else if (method === "thread.getTasks") {
        result = [];
      } else if (method === "snapshot.listByThread") {
        result = [];
      } else if (method === "providers.listAvailability") {
        result = [];
      } else if (method === "provider.catalog") {
        const request = msg.params as {
          providerId: "claude" | "codex" | "copilot" | "cursor" | "gemini";
          workspaceId?: string;
          threadId?: string;
          cwd?: string;
        };
        result = {
          providerId: request.providerId,
          context: request.workspaceId
            ? { scope: "workspace", workspaceId: request.workspaceId, ...(request.threadId ? { threadId: request.threadId } : {}) }
            : request.cwd
              ? { scope: "path", cwd: request.cwd }
              : { scope: "user" },
          freshness: { status: "fresh", fetchedAt: new Date().toISOString() },
          diagnostics: [],
          entries: [],
          selectableAgents: [],
        };
      } else if (method === "narrative.list") {
        // Assistant messages mount <PersistedNarrative>, which calls this RPC and
        // spreads the result into buildPersistedNarrativeItems. The generic
        // *.list `[]` default lacks tools/thoughts/hooks and crashes on
        // `tools.length`; return the contract's empty-narrative shape instead.
        result = { tools: [], thoughts: [], hooks: [] };
      } else if (method?.endsWith(".list") || method === "provider.listModels") result = [];
      else if (method === "git.currentBranch") result = "main";
      else if (method === "agent.activeCount") result = 0;
      else if (method === "agent.listRunning") result = [];
      else if (method === "push.subscribeThread" || method === "push.unsubscribeThread") result = undefined;
      else if (method === "agent.dismissPlanQuestions") result = undefined;
      else if (method === "plan.list") result = [];
      else if (method === "thread.syncPrs") result = [];
      else if (method === "workspace.touchLastOpened") result = null;
      else if (method === "workspace.enrich") result = { items: [] };
      else if (method === "app.version") result = "0.0.1-test";
      else if (method === "config.discover") result = {};
      else if (method === "terminal.listActive") result = [];
      else if (method === "git.listWorktrees") result = [];
      else if (method === "git.branchComparison") result = null;
      // Settings round-trip through the page-session store-of-record so a
      // UI-driven change (theme, concurrency) is reflected on the next read.
      else if (method === "settings.get") result = currentSettings;
      else if (method === "settings.update") {
        currentSettings = deepMerge(currentSettings, msg.params) as Settings;
        result = currentSettings;
      }
      else if (method === "provider.getUsage") {
        const providerId =
          msg.params && typeof msg.params === "object" && "providerId" in msg.params
            ? String((msg.params as { providerId?: unknown }).providerId)
            : "claude";
        result = { providerId, quotaCategories: [] };
      }
      else if (method === "workspace.reorder") result = { ok: true };
      // ADR-0010: TerminalView calls terminal.reattach on every mount to replay
      // the server's retained scrollback into a fresh xterm. Without a default
      // response the new mount path hangs forever, causing every terminal spec
      // to time out. Return { gapped: false }: no replay gap, nothing trimmed,
      // so the reattach gate flushes immediately and the view finishes mounting.
      else if (method === "terminal.reattach") result = { gapped: false };
      // terminal.resume is called after reattach to release the server-side
      // pause buffer so the first prompt reaches the client.
      else if (method === "terminal.resume") result = null;
      // terminal.pause is used only for client backpressure; default to success.
      else if (method === "terminal.pause") result = null;
      else {
        ws.send(
          JSON.stringify({
            id: msg.id,
            error: { code: -32601, message: "Method not found" },
          }),
        );
        return;
      }
      ws.send(JSON.stringify({ id: msg.id, result }));
    });
  });

  return {
    async sendNotification(method: string, params?: unknown): Promise<void> {
      const ws = await wsReady;
      ws.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
    },
    async sendPush(channel: string, data: unknown): Promise<void> {
      const ws = await wsReady;
      ws.send(JSON.stringify({ type: "push", channel, data }));
    },
  };
}

/**
 * Intercept the Vite-bundled zustand.js to inject a store registry on
 * `window.__mcodeStores`. Uses a regex to locate the
 * `const api = { ... subscribe ... };` block so the patch survives
 * formatting or whitespace changes.
 */
export async function interceptZustandStores(page: Page): Promise<void> {
  await page.route("**/zustand.js*", async (route) => {
    let response: Awaited<ReturnType<typeof route.fetch>>;
    try {
      response = await route.fetch();
    } catch {
      response = await route.fetch();
    }
    const originalBody = await response.text();

    const apiBlockPattern = /const api\s*=\s*\{[\s\S]*?subscribe[\s\S]*?\};/m;
    const match = apiBlockPattern.exec(originalBody);
    if (!match) {
      throw new Error(
        "[E2E] Could not find zustand `const api = { ... subscribe ... }` block to patch",
      );
    }

    const injection = `\n\tif (typeof window !== "undefined") {
\t\twindow.__mcodeStores = window.__mcodeStores || [];
\t\twindow.__mcodeStores.push(api);
\t}`;

    const patchedBody =
      originalBody.slice(0, match.index + match[0].length) +
      injection +
      originalBody.slice(match.index + match[0].length);

    await route.fulfill({
      status: response.status(),
      headers: Object.fromEntries(
        response.headersArray().map((h) => [h.name, h.value]),
      ),
      body: patchedBody,
    });
  });
}

/** Minimal browser-side view of a Zustand store handle in `window.__mcodeStores`. */
type StoreHandle = {
  getState: () => Record<string, unknown>;
  setState: (patch: Record<string, unknown>) => void;
};

/** Identifying keys for the workspace store in the `__mcodeStores` registry. */
const WORKSPACE_STORE_KEYS = ["activeThreadId", "threads", "workspaces"] as const;
/**
 * Identifying keys for the thread store. `loadMessages` is unique to the thread
 * store, and `records` is its per-thread state Map; together they single it out.
 */
const THREAD_STORE_KEYS = ["records", "loadMessages"] as const;

/**
 * Activate a single workspace and thread so the chat view mounts and the app's
 * own `loadMessages` runs for the thread. Sets only workspace-store fields the
 * web app reads to pick and render the active thread.
 */
export async function activateThread(
  page: Page,
  workspace: Record<string, unknown> & { id: string },
  thread: Record<string, unknown> & { id: string },
): Promise<void> {
  await page.evaluate(
    ({ ws, th, wsKeys }) => {
      const stores =
        (window as unknown as { __mcodeStores?: StoreHandle[] }).__mcodeStores ?? [];
      const wsStore = stores.find((s) => wsKeys.every((k) => k in s.getState()));
      if (!wsStore) throw new Error("[E2E] workspace store not found");
      wsStore.setState({
        workspaces: [ws],
        threads: [th],
        activeWorkspaceId: ws.id,
        activeThreadId: th.id,
        loading: false,
        error: null,
      });
    },
    { ws: workspace, th: thread, wsKeys: [...WORKSPACE_STORE_KEYS] },
  );
}

/**
 * Wait until the app's own `loadMessages` has settled for the active thread:
 * the thread store's `currentThreadId` matches the workspace store's
 * `activeThreadId` and that thread's record reports `loading: false`. Because
 * `currentThreadId` is unset until hydration starts, this also avoids the
 * resolve-too-early race that a bare `loading === false` check would hit.
 */
export async function waitForActiveThreadLoaded(
  page: Page,
  timeout = 8000,
): Promise<void> {
  await page.waitForFunction(
    ({ wsKeys, tsKeys }) => {
      const stores =
        (window as unknown as { __mcodeStores?: StoreHandle[] }).__mcodeStores ?? [];
      const wsStore = stores.find((s) => wsKeys.every((k) => k in s.getState()));
      const threadStore = stores.find((s) => tsKeys.every((k) => k in s.getState()));
      if (!wsStore || !threadStore) return false;
      const activeThreadId = wsStore.getState().activeThreadId as string | null;
      if (!activeThreadId) return false;
      const ts = threadStore.getState() as {
        currentThreadId: string | null;
        records: Map<string, { loading: boolean }>;
      };
      const record = ts.records.get(activeThreadId);
      return (
        ts.currentThreadId === activeThreadId &&
        record != null &&
        record.loading === false
      );
    },
    { wsKeys: [...WORKSPACE_STORE_KEYS], tsKeys: [...THREAD_STORE_KEYS] },
    { timeout },
  );
}

/**
 * Patch messages onto the active thread's existing record (the one the app's
 * hydration already created). Patching rather than rebuilding the record keeps
 * this helper correct as the `ThreadRecord` shape evolves. Call only after
 * {@link waitForActiveThreadLoaded} so the base record exists.
 */
export async function setActiveThreadMessages(
  page: Page,
  messages: Array<Record<string, unknown>>,
): Promise<void> {
  await page.evaluate(
    ({ msgs, wsKeys, tsKeys }) => {
      const stores =
        (window as unknown as { __mcodeStores?: StoreHandle[] }).__mcodeStores ?? [];
      const wsStore = stores.find((s) => wsKeys.every((k) => k in s.getState()));
      const threadStore = stores.find((s) => tsKeys.every((k) => k in s.getState()));
      if (!wsStore || !threadStore) throw new Error("[E2E] stores not found");
      const activeThreadId = wsStore.getState().activeThreadId as string | null;
      if (!activeThreadId)
        throw new Error("[E2E] no active thread to inject messages into");
      const ts = threadStore.getState() as {
        records: Map<string, Record<string, unknown>>;
      };
      const records = new Map(ts.records);
      const current = records.get(activeThreadId) ?? {};
      records.set(activeThreadId, {
        ...current,
        messages: msgs,
        loading: false,
        error: null,
      });
      threadStore.setState({ records });
    },
    { msgs: messages, wsKeys: [...WORKSPACE_STORE_KEYS], tsKeys: [...THREAD_STORE_KEYS] },
  );
}

/**
 * Activate a thread, wait for its load to settle, then inject messages. The
 * common setup for chat-transcript specs. Pass an empty `messages` array to
 * stop after the thread is active and loaded (for event-driven specs).
 */
export async function seedActiveThread(
  page: Page,
  workspace: Record<string, unknown> & { id: string },
  thread: Record<string, unknown> & { id: string },
  messages: Array<Record<string, unknown>> = [],
): Promise<void> {
  await activateThread(page, workspace, thread);
  await waitForActiveThreadLoaded(page);
  if (messages.length > 0) {
    await setActiveThreadMessages(page, messages);
  }
}

/**
 * Invoke the thread store's `handleAgentEvent` through the production code path,
 * so specs exercise the real reducer rather than poking derived state.
 */
export async function dispatchAgentEvent(
  page: Page,
  threadId: string,
  event: Record<string, unknown>,
): Promise<void> {
  await page.evaluate(
    ({ tid, evt, tsKeys }) => {
      const stores =
        (window as unknown as { __mcodeStores?: StoreHandle[] }).__mcodeStores ?? [];
      const threadStore = stores.find((s) => tsKeys.every((k) => k in s.getState()));
      if (!threadStore) throw new Error("[E2E] thread store not found");
      (
        threadStore.getState() as {
          handleAgentEvent: (id: string, e: unknown) => void;
        }
      ).handleAgentEvent(tid, evt);
    },
    { tid: threadId, evt: event, tsKeys: [...THREAD_STORE_KEYS] },
  );
}
