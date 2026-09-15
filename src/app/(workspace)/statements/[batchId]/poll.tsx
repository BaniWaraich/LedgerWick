"use client";

/**
 * Ask the server again, while there is something to wait for.
 *
 * `architecture.md §14`: V1 polls, and the mechanism is an implementation choice. This is
 * the cheapest one that satisfies the requirement — `router.refresh()` re-renders the
 * server component, so the page still reads its state from the database and holds none of
 * its own.
 *
 * The parent renders this only while a statement is in flight, so a finished batch stops
 * polling rather than asking forever.
 */

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Slow enough to be cheap, fast enough that a short step is not missed entirely. */
const INTERVAL_MS = 3000;

export function PollWhileProcessing() {
  const router = useRouter();

  useEffect(() => {
    const timer = setInterval(() => router.refresh(), INTERVAL_MS);
    return () => clearInterval(timer);
  }, [router]);

  return null;
}
