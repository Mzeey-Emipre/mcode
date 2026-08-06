import { ipcRenderer } from "electron";
import {
  PREVIEW_GUEST_AGENT_INPUT_CHANNEL,
  PREVIEW_GUEST_CLIPBOARD_TRUST_CHANNEL,
  PREVIEW_GUEST_HUMAN_INPUT_CHANNEL,
  PreviewGuestInputSuppressor,
  toPreviewGuestHumanInputMessage,
} from "./preview-guest-input-contract.js";

const suppressor = new PreviewGuestInputSuppressor();

setInterval(() => {
  suppressor.expire();
}, 1_000);

ipcRenderer.on(PREVIEW_GUEST_AGENT_INPUT_CHANNEL, (_event, input: unknown) => {
  if (input && typeof input === "object" && (input as { action?: unknown }).action === "revoke") {
    suppressor.revoke(input);
  } else {
    suppressor.allow(input);
  }
});

for (const eventType of ["keydown", "pointerdown", "touchstart", "wheel"] as const) {
  window.addEventListener(
    eventType,
    (event) => {
      const message = toPreviewGuestHumanInputMessage(event.type, event.isTrusted);
      if (message && !suppressor.consume(message.kind)) {
        if (message.kind === "pointer") {
          ipcRenderer.send(PREVIEW_GUEST_CLIPBOARD_TRUST_CHANNEL);
        }
        ipcRenderer.sendToHost(PREVIEW_GUEST_HUMAN_INPUT_CHANNEL, message);
      }
    },
    { capture: true, passive: true },
  );
}
