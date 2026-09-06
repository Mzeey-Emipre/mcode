import { act, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMockMessage } from "@/__tests__/mocks/transport";
import { createEmptyThreadRecord, patchThreadRecord } from "@/stores/thread-record";
import { resetThreadStoreForTests } from "@/stores/thread-store-test-utils";
import { useThreadStore } from "@/stores/threadStore";
import type { Message } from "@/transport";
import { ComposerProviderNoticeSurface } from "./ComposerProviderNoticeSurface";

const THREAD_A = "thread-a";
const THREAD_B = "thread-b";
const originalResizeObserver = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");

class ResizeObserverMock {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function providerNotice(
  id: string,
  threadId: string,
  kind: NonNullable<Message["systemNotice"]>["kind"],
  noticeKey = id,
  sessionId: string | null = `${threadId}-session`,
): Message {
  return createMockMessage({
    id,
    thread_id: threadId,
    role: "system",
    content: `${kind} evidence ${id}`,
    systemNotice: {
      kind,
      presentation: "timeline",
      scope: kind === "configuration" || kind === "deprecation" ? "session" : "turn",
      noticeKey,
      ...(sessionId === null ? {} : { sessionId }),
    },
  });
}

function seedThread(
  threadId: string,
  messages: readonly Message[] = [],
  sessionNotices: readonly Message[] = messages,
): void {
  const state = useThreadStore.getState();
  useThreadStore.setState({
    records: patchThreadRecord(state.records, threadId, {
      messages: [...messages],
      sessionNotices: [...sessionNotices],
    }),
  });
}

function NoticeHarness({
  threadId = THREAD_A,
  isMentionPickerOpen = false,
  isSlashPickerOpen = false,
}: {
  readonly threadId?: string;
  readonly isMentionPickerOpen?: boolean;
  readonly isSlashPickerOpen?: boolean;
}) {
  const composerRef = useRef<HTMLDivElement>(null);
  return (
    <>
      <div ref={composerRef} />
      <ComposerProviderNoticeSurface
        threadId={threadId}
        composerContainerRef={composerRef}
        isMentionPickerOpen={isMentionPickerOpen}
        isSlashPickerOpen={isSlashPickerOpen}
      >
        {(trigger) => <div data-testid="notice-trigger">{trigger}</div>}
      </ComposerProviderNoticeSurface>
    </>
  );
}

describe("ComposerProviderNoticeSurface", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: ResizeObserverMock,
    });
    resetThreadStoreForTests({
      records: new Map([
        [THREAD_A, createEmptyThreadRecord()],
        [THREAD_B, createEmptyThreadRecord()],
      ]),
    });
  });

  afterEach(() => {
    if (originalResizeObserver) Object.defineProperty(globalThis, "ResizeObserver", originalResizeObserver);
    else Reflect.deleteProperty(globalThis, "ResizeObserver");
  });

  it("dismisses a notice, keeps repeated evidence hidden, and reopens it on demand", async () => {
    const first = providerNotice("warning-1", THREAD_A, "warning", "same-warning");
    seedThread(THREAD_A, [first]);
    render(<NoticeHarness />);

    expect(screen.getByTestId("composer-provider-notice")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notice" }));
    expect(screen.queryByTestId("composer-provider-notice")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review provider notices" })).toBeInTheDocument();

    act(() => seedThread(THREAD_A, [first, providerNotice("warning-2", THREAD_A, "warning", "same-warning")]));
    expect(screen.queryByTestId("composer-provider-notice")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Review provider notices" }));
    expect(screen.getByTestId("composer-provider-notice")).toBeInTheDocument();
  });

  it("surfaces a new issue after dismissal and keeps dismissed state isolated by thread", () => {
    const first = providerNotice("warning-a", THREAD_A, "warning", "issue-a");
    seedThread(THREAD_A, [first]);
    seedThread(THREAD_B, [providerNotice("warning-b", THREAD_B, "security", "issue-b")]);
    const { rerender } = render(<NoticeHarness />);

    fireEvent.click(screen.getByRole("button", { name: "Dismiss notice" }));
    act(() => seedThread(THREAD_A, [first, providerNotice("warning-new", THREAD_A, "security", "issue-new")]));
    expect(screen.getByRole("button", { name: "Security warning" })).toBeInTheDocument();

    rerender(<NoticeHarness threadId={THREAD_B} />);
    expect(screen.getByRole("button", { name: "Security warning" })).toBeInTheDocument();
    rerender(<NoticeHarness threadId={THREAD_A} />);
    expect(screen.getByRole("button", { name: "Security warning" })).toBeInTheDocument();
  });

  it("does not treat an unrelated recovery as resolving a dismissed security notice", () => {
    const security = providerNotice("security", THREAD_A, "security", "security-key", "session-1");
    const recovery = providerNotice("recovered", THREAD_A, "authentication-recovered", "recovery-key", "session-1");
    seedThread(THREAD_A, [security]);
    render(<NoticeHarness />);

    fireEvent.click(screen.getByRole("button", { name: "Dismiss notice" }));
    act(() => seedThread(THREAD_A, [security, recovery]));
    expect(screen.queryByTestId("composer-provider-notice")).not.toBeInTheDocument();

    const nextSessionSecurity = providerNotice("security-next", THREAD_A, "security", "security-key", "session-2");
    act(() => seedThread(
      THREAD_A,
      [security, recovery, nextSessionSecurity],
      [nextSessionSecurity],
    ));
    expect(screen.getByTestId("composer-provider-notice")).toBeInTheDocument();
  });

  it("keeps configuration notices quiet until the user asks to review them", () => {
    seedThread(THREAD_A, [], [providerNotice("config", THREAD_A, "configuration")]);
    render(<NoticeHarness />);

    expect(screen.queryByTestId("composer-provider-notice")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Review provider notices" }));
    expect(screen.getByTestId("composer-provider-notice")).toBeInTheDocument();
    expect(screen.getByText("configuration evidence config")).toBeInTheDocument();
  });

  it("prioritizes attention and lets the user inspect other collected notice evidence", () => {
    const reroute = providerNotice("reroute", THREAD_A, "model-rerouted");
    const security = providerNotice("security", THREAD_A, "security");
    seedThread(
      THREAD_A,
      [reroute, security],
      [reroute, security, providerNotice("config", THREAD_A, "configuration")],
    );
    render(<NoticeHarness />);

    fireEvent.click(screen.getByRole("button", { name: "Security warning" }));
    expect(screen.getByText("security evidence security")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Other notice" }));
    expect(screen.getByText("model-rerouted evidence reroute")).toBeInTheDocument();
  });

  it("keeps notice header children transparent so the header owns hover feedback", () => {
    seedThread(THREAD_A, [
      providerNotice("security", THREAD_A, "security"),
      providerNotice("warning", THREAD_A, "warning"),
    ]);
    render(<NoticeHarness />);

    expect(screen.getByRole("button", { name: "Security warning" }))
      .toHaveClass("aria-expanded:bg-transparent", "dark:hover:bg-transparent");
    expect(screen.getByRole("button", { name: "Other notice" }))
      .toHaveClass("dark:hover:bg-transparent");
    expect(screen.getByRole("button", { name: "Dismiss notice" }))
      .toHaveClass("dark:hover:bg-transparent");
  });

  it("does not reactivate historical turn notices after the current session clears", () => {
    const historical = providerNotice("historical", THREAD_A, "security");
    seedThread(THREAD_A, [historical], []);

    render(<NoticeHarness />);

    expect(screen.queryByTestId("composer-provider-notice")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Review provider notices" })).not.toBeInTheDocument();
  });

  it("presents an unscoped provider notice", () => {
    seedThread(THREAD_A, [providerNotice("unscoped-warning", THREAD_A, "warning", "warning", null)]);

    render(<NoticeHarness />);

    expect(screen.getByTestId("composer-provider-notice")).toBeInTheDocument();
  });

  it("hides beneath mention and slash pickers, then restores after either closes", () => {
    seedThread(THREAD_A, [providerNotice("warning", THREAD_A, "warning")]);
    const { rerender } = render(<NoticeHarness />);

    expect(screen.getByTestId("composer-provider-notice")).toBeInTheDocument();
    rerender(<NoticeHarness isMentionPickerOpen />);
    expect(screen.queryByTestId("composer-provider-notice")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review provider notices" })).toBeInTheDocument();
    rerender(<NoticeHarness isSlashPickerOpen />);
    expect(screen.queryByTestId("composer-provider-notice")).not.toBeInTheDocument();
    rerender(<NoticeHarness />);
    expect(screen.getByTestId("composer-provider-notice")).toBeInTheDocument();
  });
});
