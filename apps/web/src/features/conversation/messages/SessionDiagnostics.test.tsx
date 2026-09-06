import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { createMockMessage } from "@/__tests__/mocks/transport";
import { createEmptyThreadRecord, patchThreadRecord } from "@/stores/thread-record";
import { resetThreadStoreForTests } from "@/stores/thread-store-test-utils";
import { useThreadStore } from "@/stores/threadStore";
import { SessionDiagnostics } from "./SessionDiagnostics";

const THREAD_ID = "thread-a";

function seedSessionNotices() {
  const state = useThreadStore.getState();
  useThreadStore.setState({
    records: patchThreadRecord(state.records, THREAD_ID, {
      sessionNotices: [
        createMockMessage({
          id: "config-notice",
          thread_id: THREAD_ID,
          role: "system",
          content: "Ignored legacy configuration.",
          systemNotice: {
            kind: "configuration",
            presentation: "timeline",
            scope: "session",
            noticeKey: "config-notice",
          },
        }),
        createMockMessage({
          id: "diagnostic-notice",
          thread_id: THREAD_ID,
          role: "system",
          content: "Provider diagnostics remain available here.",
          systemNotice: {
            kind: "diagnostic",
            presentation: "timeline",
            scope: "session",
            noticeKey: "diagnostic-notice",
          },
        }),
        createMockMessage({
          id: "auth-recovery-notice",
          thread_id: THREAD_ID,
          role: "system",
          content: "Provider authentication recovered.",
          systemNotice: {
            kind: "authentication-recovered",
            presentation: "timeline",
            scope: "turn",
            noticeKey: "auth-recovery-notice",
          },
        }),
      ],
    }),
  });
}

describe("SessionDiagnostics", () => {
  beforeEach(() => {
    resetThreadStoreForTests({
      records: new Map([[THREAD_ID, createEmptyThreadRecord()]]),
    });
    seedSessionNotices();
  });

  it("keeps Composer-presented configuration notices out of diagnostics", () => {
    const { queryByText, getByText } = render(<SessionDiagnostics threadId={THREAD_ID} />);

    expect(queryByText("Ignored legacy configuration.")).not.toBeInTheDocument();
    expect(queryByText("Provider authentication recovered.")).not.toBeInTheDocument();
    expect(getByText("Provider diagnostics remain available here.")).toBeInTheDocument();
  });
});
