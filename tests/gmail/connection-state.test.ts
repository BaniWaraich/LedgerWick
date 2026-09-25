/**
 * The Gmail Connection state machine.
 *
 * spec: docs/state-machines.md §6
 *
 * Small enough to test every pair: three states plus "no record", three events.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { gmailConnectionStateEnum } from "../../src/db/schema";
import {
  InvalidConnectionTransitionError,
  nextConnectionState,
  type ConnectionEvent,
  type ConnectionState,
} from "../../src/gmail/connection-state";

const allowed: [ConnectionState | null, ConnectionEvent, ConnectionState][] = [
  [null, "GRANTED", "CONNECTED"],
  ["CONNECTED", "GRANTED", "CONNECTED"],
  ["NEEDS_REAUTH", "GRANTED", "CONNECTED"],
  ["DISCONNECTED", "GRANTED", "CONNECTED"],
  ["CONNECTED", "GRANT_INVALID", "NEEDS_REAUTH"],
  ["CONNECTED", "DISCONNECTED", "DISCONNECTED"],
  ["NEEDS_REAUTH", "DISCONNECTED", "DISCONNECTED"],
];

const refused: [ConnectionState | null, ConnectionEvent][] = [
  [null, "GRANT_INVALID"],
  [null, "DISCONNECTED"],
  ["NEEDS_REAUTH", "GRANT_INVALID"],
  ["DISCONNECTED", "GRANT_INVALID"],
  ["DISCONNECTED", "DISCONNECTED"],
];

describe("a gmail connection", () => {
  it.each(allowed)("in %s, on %s, becomes %s", (from, event, to) => {
    expect(nextConnectionState(from, event)).toBe(to);
  });

  it.each(refused)("in %s, refuses %s", (from, event) => {
    expect(() => nextConnectionState(from, event)).toThrow(InvalidConnectionTransitionError);
  });

  it("has every pair of state and event accounted for", () => {
    // Guards the guard: a pair in neither list is a transition nobody decided about.
    const states = [null, ...gmailConnectionStateEnum.enumValues];
    const events: ConnectionEvent[] = ["GRANTED", "GRANT_INVALID", "DISCONNECTED"];
    const covered = new Set([...allowed, ...refused].map(([from, event]) => `${from}/${event}`));

    for (const from of states) {
      for (const event of events) expect(covered).toContain(`${from}/${event}`);
    }
  });

  it("has exactly the states the state document lists", () => {
    const doc = readFileSync(join(import.meta.dirname, "../../docs/state-machines.md"), "utf8");
    const section = doc.slice(doc.indexOf("## 6. Gmail Connection"), doc.indexOf("## 7."));
    const documented = [...section.matchAll(/^\| `([A-Z_]+)`\s+\| [A-Z]/gm)].map((m) => m[1]);

    expect(new Set(documented)).toEqual(new Set(gmailConnectionStateEnum.enumValues));
  });
});
