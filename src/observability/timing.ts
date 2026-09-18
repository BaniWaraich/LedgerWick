/**
 * How long a stage took, recorded where a killed process still leaves it behind.
 *
 * Parsing runs inside one Inngest step, and that step runs inside one Vercel function
 * capped at 300 seconds on this plan. When the cap is hit the invocation is terminated
 * outright: nothing returns, no error is raised in our code, and the run simply retries.
 * There is therefore no in-process place to record where the time went — the recording has
 * to already have happened.
 *
 * So each stage logs *after* it completes. The stages that finished are the lines you see;
 * the stage that was in flight when the function died is the first one missing. That
 * absence is the measurement.
 *
 * `console.log` rather than a logging library because Vercel's runtime logs are the
 * destination either way, and a dependency would buy nothing here. The prefix is fixed so
 * the lines can be filtered out of everything else the platform emits:
 *
 *     vercel logs <deployment-url> | grep '\[timing\]'
 */

/** What a stage is measured against, so one line is readable without the others. */
type Context = Record<string, string | number | boolean | null | undefined>;

/**
 * Run `work`, then record what it cost.
 *
 * The failure path logs too, and rethrows untouched. A stage that threw is a different
 * fact from a stage that vanished — the first says our code decided something, the second
 * says the platform stopped us — and telling them apart is most of the point of this
 * module.
 */
export async function timed<T>(
  stage: string,
  context: Context,
  work: () => Promise<T>,
): Promise<T> {
  const started = Date.now();

  try {
    const result = await work();
    record(stage, Date.now() - started, { ...context, outcome: "ok" });
    return result;
  } catch (error) {
    record(stage, Date.now() - started, {
      ...context,
      outcome: "threw",
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function record(stage: string, ms: number, context: Context): void {
  const fields = Object.entries(context)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");

  console.log(`[timing] stage=${stage} ms=${ms} ${fields}`);
}
