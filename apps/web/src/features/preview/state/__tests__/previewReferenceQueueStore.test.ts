import { describe, it, expect, beforeEach } from "vitest";
import { usePreviewReferenceQueueStore } from "../previewReferenceQueueStore";
import type { PendingAttachment } from "@/components/chat/AttachmentPreview";

const dummyAtt = (id: string): PendingAttachment => ({
  id,
  name: `${id}.png`,
  mimeType: "image/png",
  sizeBytes: 100,
  previewUrl: `blob:${id}`,
  filePath: "/tmp/x",
});

describe("previewReferenceQueueStore", () => {
  beforeEach(() => {
    usePreviewReferenceQueueStore.setState({
      signal: 0,
      queueByThread: {},
    });
  });

  it("drains queued preview references for one thread once", () => {
    const { enqueuePreviewReference, drainPreviewReferences } = usePreviewReferenceQueueStore.getState();
    enqueuePreviewReference("thread-a", dummyAtt("1"));
    expect(drainPreviewReferences("thread-a")).toHaveLength(1);
    expect(drainPreviewReferences("thread-a")).toHaveLength(0);
  });

  it("keeps queues isolated per thread", () => {
    const { enqueuePreviewReference, drainPreviewReferences } = usePreviewReferenceQueueStore.getState();
    enqueuePreviewReference("thread-a", dummyAtt("1"));
    expect(drainPreviewReferences("thread-b")).toHaveLength(0);
    expect(drainPreviewReferences("thread-a")).toHaveLength(1);
  });
});
