import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PrSplitButton } from "./PrSplitButton";

const noop = () => {};

describe("PrSplitButton", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── No PR ──────────────────────────────────────────────────────────────────

  it("renders Create PR enabled when pr is null and hasCommitsAhead is true", () => {
    render(<PrSplitButton pr={null} hasCommitsAhead={true} onCreatePr={noop} onOpenPr={noop} />);
    expect(screen.getByRole("button", { name: /create pr/i })).not.toBeDisabled();
  });

  it("renders Create PR disabled when pr is null and hasCommitsAhead is false", () => {
    render(<PrSplitButton pr={null} hasCommitsAhead={false} onCreatePr={noop} onOpenPr={noop} />);
    expect(screen.getByRole("button", { name: /create pr/i })).toBeDisabled();
  });

  it("renders Create PR disabled when pr is null and hasCommitsAhead is null (loading)", () => {
    render(<PrSplitButton pr={null} hasCommitsAhead={null} onCreatePr={noop} onOpenPr={noop} />);
    expect(screen.getByRole("button", { name: /create pr/i })).toBeDisabled();
  });

  it("calls onCreatePr when Create PR is clicked", () => {
    const onCreatePr = vi.fn();
    render(<PrSplitButton pr={null} hasCommitsAhead={true} onCreatePr={onCreatePr} onOpenPr={noop} />);
    fireEvent.click(screen.getByRole("button", { name: /create pr/i }));
    expect(onCreatePr).toHaveBeenCalledTimes(1);
  });

  // ── PR open ────────────────────────────────────────────────────────────────

  const openPr = { number: 42, url: "https://github.com/o/r/pull/42", state: "OPEN" };

  it("renders View PR #42 when pr state is OPEN (uppercase — normalised)", () => {
    render(<PrSplitButton pr={openPr} hasCommitsAhead={true} onCreatePr={noop} onOpenPr={noop} />);
    expect(screen.getByText(/view pr #42/i)).toBeInTheDocument();
  });

  it("applies green colour class when pr state is open", () => {
    render(<PrSplitButton pr={openPr} hasCommitsAhead={true} onCreatePr={noop} onOpenPr={noop} />);
    const btn = screen.getByText(/view pr #42/i).closest("button");
    expect(btn?.className).toContain("text-[#3fb950]");
  });

  it("does not render chevron button when pr state is open", () => {
    render(<PrSplitButton pr={openPr} hasCommitsAhead={true} onCreatePr={noop} onOpenPr={noop} />);
    expect(screen.queryByRole("button", { name: /open pr menu/i })).not.toBeInTheDocument();
  });

  it("calls onOpenPr with the url when View PR is clicked", () => {
    const onOpenPr = vi.fn();
    render(<PrSplitButton pr={openPr} hasCommitsAhead={true} onCreatePr={noop} onOpenPr={onOpenPr} />);
    fireEvent.click(screen.getByText(/view pr #42/i));
    expect(onOpenPr).toHaveBeenCalledWith("https://github.com/o/r/pull/42");
  });

  // ── PR merged ──────────────────────────────────────────────────────────────

  const mergedPr = { number: 42, url: "https://github.com/o/r/pull/42", state: "MERGED" };

  it("renders PR #42 merged when pr state is MERGED", () => {
    render(<PrSplitButton pr={mergedPr} hasCommitsAhead={true} onCreatePr={noop} onOpenPr={noop} />);
    expect(screen.getByText(/pr #42 merged/i)).toBeInTheDocument();
  });

  it("applies purple colour class when pr state is merged", () => {
    render(<PrSplitButton pr={mergedPr} hasCommitsAhead={true} onCreatePr={noop} onOpenPr={noop} />);
    const btn = screen.getByText(/pr #42 merged/i).closest("button");
    expect(btn?.className).toContain("text-[#a371f7]");
  });

  it("renders chevron button when pr state is merged", () => {
    render(<PrSplitButton pr={mergedPr} hasCommitsAhead={true} onCreatePr={noop} onOpenPr={noop} />);
    expect(screen.getByRole("button", { name: /open pr menu/i })).toBeInTheDocument();
  });

  it("opens dropdown when chevron is clicked on merged PR", () => {
    render(<PrSplitButton pr={mergedPr} hasCommitsAhead={true} onCreatePr={noop} onOpenPr={noop} />);
    fireEvent.click(screen.getByRole("button", { name: /open pr menu/i }));
    expect(screen.getByText(/view on github/i)).toBeInTheDocument();
    expect(screen.getByText(/create new pr/i)).toBeInTheDocument();
  });

  it("calls onCreatePr and closes dropdown when Create new PR is clicked", () => {
    const onCreatePr = vi.fn();
    render(<PrSplitButton pr={mergedPr} hasCommitsAhead={true} onCreatePr={onCreatePr} onOpenPr={noop} />);
    fireEvent.click(screen.getByRole("button", { name: /open pr menu/i }));
    fireEvent.click(screen.getByText(/create new pr/i));
    expect(onCreatePr).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/view on github/i)).not.toBeInTheDocument();
  });

  // ── PR closed ──────────────────────────────────────────────────────────────

  const closedPr = { number: 42, url: "https://github.com/o/r/pull/42", state: "CLOSED" };

  it("renders PR #42 closed and applies red colour class when pr state is CLOSED", () => {
    render(<PrSplitButton pr={closedPr} hasCommitsAhead={true} onCreatePr={noop} onOpenPr={noop} />);
    expect(screen.getByText(/pr #42 closed/i)).toBeInTheDocument();
    const btn = screen.getByText(/pr #42 closed/i).closest("button");
    expect(btn?.className).toContain("text-[#f85149]");
  });

  it("renders chevron and dropdown for closed PR", () => {
    render(<PrSplitButton pr={closedPr} hasCommitsAhead={true} onCreatePr={noop} onOpenPr={noop} />);
    fireEvent.click(screen.getByRole("button", { name: /open pr menu/i }));
    expect(screen.getByText(/view on github/i)).toBeInTheDocument();
    expect(screen.getByText(/create new pr/i)).toBeInTheDocument();
  });

  it("closes dropdown when clicking outside", () => {
    render(
      <div>
        <PrSplitButton pr={mergedPr} hasCommitsAhead={true} onCreatePr={noop} onOpenPr={noop} />
        <div data-testid="outside">outside</div>
      </div>
    );
    fireEvent.click(screen.getByRole("button", { name: /open pr menu/i }));
    expect(screen.getByText(/view on github/i)).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByTestId("outside"));
    expect(screen.queryByText(/view on github/i)).not.toBeInTheDocument();
  });
});
