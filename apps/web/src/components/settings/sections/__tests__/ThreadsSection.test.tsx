import { fireEvent, render, screen } from "@testing-library/react";
import { getDefaultSettings } from "@mcode/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "@/stores/settingsStore";
import { ThreadsSection } from "../ThreadsSection";

describe("ThreadsSection", () => {
  const update = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();
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

  it("shows persisted Never state without an unsafe-worktree control", () => {
    const settings = getDefaultSettings();
    useSettingsStore.setState({
      settings: {
        ...settings,
        thread: {
          completion: { retentionDays: null },
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
    expect(screen.queryByText("Unsafe worktree cleanup")).not.toBeInTheDocument();
  });
});
