import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { getDefaultSettings } from "@mcode/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "@/stores/settingsStore";
import { ThreadsSection } from "../ThreadsSection";

const { countBlockedThreadCleanupCandidates } = vi.hoisted(() => ({
  countBlockedThreadCleanupCandidates: vi.fn().mockResolvedValue({ count: 0 }),
}));

vi.mock("@/transport", () => ({
  getTransport: () => ({ countBlockedThreadCleanupCandidates }),
}));

describe("ThreadsSection", () => {
  const update = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    countBlockedThreadCleanupCandidates.mockResolvedValue({ count: 0 });
    useSettingsStore.setState({
      settings: getDefaultSettings(),
      loaded: true,
      update,
    });
  });

  it("shows the default and saves a whole-day retention value", () => {
    render(<ThreadsSection />);
    const input = screen.getByRole("spinbutton", {
      name: "Completed thread retention days",
    });

    expect(input).toHaveValue(3);
    fireEvent.change(input, { target: { value: "30" } });
    fireEvent.blur(input);

    expect(update).toHaveBeenCalledWith({
      thread: { completion: { retentionDays: 30 } },
    });
  });

  it.each(["0", "-1", "1.5", "366"])("rejects invalid draft %s", (draft) => {
    render(<ThreadsSection />);
    const input = screen.getByRole("spinbutton", {
      name: "Completed thread retention days",
    });

    fireEvent.change(input, { target: { value: draft } });
    fireEvent.blur(input);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Enter a whole number from 1 to 365.",
    );
    expect(update).not.toHaveBeenCalled();
  });

  it("selects Never", () => {
    render(<ThreadsSection />);

    fireEvent.click(
      screen.getByRole("switch", {
        name: "Never delete completed threads automatically",
      }),
    );

    expect(update).toHaveBeenCalledWith({
      thread: { completion: { retentionDays: null } },
    });
  });

  it("shows persisted Never state", () => {
    const settings = getDefaultSettings();
    useSettingsStore.setState({
      settings: {
        ...settings,
        thread: {
          completion: { retentionDays: null, unsafeWorktreePolicy: "block" },
        },
      },
    });

    render(<ThreadsSection />);

    expect(
      screen.getByRole("switch", {
        name: "Never delete completed threads automatically",
      }),
    ).toBeChecked();
    expect(
      screen.getByRole("spinbutton", { name: "Completed thread retention days" }),
    ).toBeDisabled();
  });

  it("saves a direct block policy change", () => {
    const settings = getDefaultSettings();
    useSettingsStore.setState({
      settings: {
        ...settings,
        thread: {
          completion: { ...settings.thread.completion, unsafeWorktreePolicy: "delete" },
        },
      },
    });

    render(<ThreadsSection />);
    fireEvent.click(screen.getByRole("radio", { name: "Block" }));

    expect(update).toHaveBeenCalledWith({
      thread: { completion: { unsafeWorktreePolicy: "block" } },
    });
  });

  it("saves block-to-delete without a dialog when no candidate is blocked", async () => {
    render(<ThreadsSection />);
    fireEvent.click(screen.getByRole("radio", { name: "Delete" }));

    await waitFor(() => {
      expect(update).toHaveBeenCalledWith({
        thread: { completion: { unsafeWorktreePolicy: "delete" } },
      });
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("confirms the exact blocked count before saving delete", async () => {
    countBlockedThreadCleanupCandidates.mockResolvedValue({ count: 4 });
    render(<ThreadsSection />);
    fireEvent.click(screen.getByRole("radio", { name: "Delete" }));

    expect(await screen.findByRole("dialog")).toHaveTextContent(
      "There are 4 blocked completed threads",
    );
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "Delete can discard uncommitted files and unique branchless commits",
    );
    expect(update).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(update).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("radio", { name: "Delete" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Allow deletion" }));

    await waitFor(() => {
      expect(update).toHaveBeenCalledWith({
        thread: { completion: { unsafeWorktreePolicy: "delete" } },
      });
    });
  });

  it("reports a direct policy save failure without an unhandled rejection", async () => {
    update.mockRejectedValueOnce(new Error("settings unavailable"));
    render(<ThreadsSection />);
    fireEvent.click(screen.getByRole("radio", { name: "Delete" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not save unsafe cleanup policy: Error: settings unavailable",
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps the delete confirmation open when the confirmed save fails", async () => {
    countBlockedThreadCleanupCandidates.mockResolvedValue({ count: 2 });
    update.mockRejectedValueOnce(new Error("settings unavailable"));
    render(<ThreadsSection />);
    fireEvent.click(screen.getByRole("radio", { name: "Delete" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Allow deletion" }));

    await waitFor(() => expect(update).toHaveBeenCalled());

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not save unsafe cleanup policy: Error: settings unavailable",
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
