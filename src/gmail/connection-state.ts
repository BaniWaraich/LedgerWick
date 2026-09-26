/**
 * Where a Gmail Connection may go next.
 *
 * spec: docs/state-machines.md §6 · docs/workflows/connect-gmail.md §7–§10
 *
 * The transition table from the state document, as a function. Every write that moves a
 * connection asks this first, so a transition the document does not list cannot happen by
 * way of a code path that forgot to check -- it throws instead.
 */

import type { gmailConnectionStateEnum } from "../db/schema";

export type ConnectionState = (typeof gmailConnectionStateEnum.enumValues)[number];

/**
 * What can happen to a connection.
 *
 * - `GRANTED`: the user completed Google's consent for this account. The first connect,
 *   a reconnect, and connecting again after a disconnect are all this one event, because
 *   all three land on the same record (§6: "a grant always lands on the existing record").
 * - `GRANT_INVALID`: Google said the grant is no longer valid (`invalid_grant`). Never
 *   sent for a transient failure.
 * - `DISCONNECTED`: the user removed the connection.
 */
export type ConnectionEvent = "GRANTED" | "GRANT_INVALID" | "DISCONNECTED";

/** Thrown for a transition `docs/state-machines.md §6` does not list. */
export class InvalidConnectionTransitionError extends Error {
  constructor(from: ConnectionState | null, event: ConnectionEvent) {
    super(`A Gmail Connection in ${from ?? "no state"} cannot take ${event}`);
    this.name = "InvalidConnectionTransitionError";
  }
}

/**
 * The state after `event`, from `current` -- `null` meaning no record exists yet.
 *
 * Exhaustive over both arguments, so a state added to the enum fails to compile here
 * rather than falling through to a default nobody chose.
 */
export function nextConnectionState(
  current: ConnectionState | null,
  event: ConnectionEvent,
): ConnectionState {
  switch (event) {
    case "GRANTED":
      // From anywhere, including no record at all. Reconnecting restores.
      return "CONNECTED";

    case "GRANT_INVALID":
      if (current === "CONNECTED") return "NEEDS_REAUTH";
      // NEEDS_REAUTH is already there, and marking it twice would hide a caller that
      // keeps trying an account it was told not to. DISCONNECTED holds no grant to be
      // invalid. No record, no grant.
      throw new InvalidConnectionTransitionError(current, event);

    case "DISCONNECTED":
      if (current === "CONNECTED" || current === "NEEDS_REAUTH") return "DISCONNECTED";
      throw new InvalidConnectionTransitionError(current, event);
  }
}
