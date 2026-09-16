/**
 * Asking the server again while a statement is still moving.
 *
 * spec: docs/phases/phase-1.md §7C ("state survives a refresh") · docs/architecture.md §14
 *
 * What is testable here is the mechanism: that something asks, on a timer, and stops when
 * there is nothing left to wait for. That the state itself survives is a property of the
 * page reading from the database on every render, and it is checked by refreshing a real
 * batch mid-processing — a component test cannot stand in for that.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { PollWhileProcessing } from "../../src/app/(workspace)/statements/[batchId]/poll";

const refresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

afterEach(() => {
  cleanup();
  refresh.mockClear();
  vi.useRealTimers();
});

describe("a batch with something still in flight", () => {
  it("asks the server again while it waits", () => {
    vi.useFakeTimers();

    render(<PollWhileProcessing />);

    // Nothing on mount: the page it sits on was itself just rendered from the database.
    expect(refresh).not.toHaveBeenCalled();

    vi.advanceTimersByTime(3000);
    expect(refresh).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(6000);
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it("stops asking once it is taken off the page", () => {
    vi.useFakeTimers();

    const { unmount } = render(<PollWhileProcessing />);
    vi.advanceTimersByTime(3000);
    unmount();

    // The parent renders this only while a statement is in flight, so unmounting is how a
    // finished batch stops polling. A leaked interval would ask the server forever.
    vi.advanceTimersByTime(30_000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
