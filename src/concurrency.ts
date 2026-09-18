/**
 * Doing a bounded number of independent things at once.
 *
 * Two places need this and both need it for the same reason: they are lists of work whose
 * items do not touch each other, run inside a background function with a hard wall-clock
 * limit, and spend nearly all of their time waiting — on a database round trip in
 * `promote.ts`, on a model in `requirements/identify.ts`. Serial execution there is not
 * simplicity, it is the whole budget spent on latency.
 *
 * The bound is not optional. An unbounded `Promise.all` over a statement's worth of work
 * would open hundreds of database connections or fire hundreds of model calls at once, and
 * the first would exhaust the pool while the second would be rate limited. Callers pick
 * their own limit because what makes a good one differs: connections for one, a provider's
 * patience for the other.
 *
 * Nothing here makes concurrent work safe. That is the caller's argument to make, and both
 * callers make it explicitly where they choose their limit.
 */

/**
 * Run `work` over `items`, at most `limit` at a time, preserving input order in the results.
 *
 * A worker pool rather than fixed chunks: a chunked version waits for the slowest member of
 * each batch before starting the next, which on uneven work spends most of its time idle.
 *
 * If any item throws, every worker still in flight is allowed to settle before the first
 * error is rethrown. Rejecting the moment one fails would leave the others running with
 * nobody waiting on them — an unhandled rejection, and worse, writes still landing after
 * the caller believes the run has stopped.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let index = next++; index < items.length; index = next++) {
      results[index] = await work(items[index]);
    }
  });

  const settled = await Promise.allSettled(workers);
  const failure = settled.find((outcome) => outcome.status === "rejected");
  if (failure) throw failure.reason;

  return results;
}
