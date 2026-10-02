/** Default interval between stall probes of a pending agent wait. */
export const DEFAULT_STALL_PROBE_MS = 10 * 60_000;

/** Reminders a stalled task gets before it blocks. */
export const STALL_REMINDER_LIMIT = 2;

/** The continuation an idle agent gets while the engine still waits for its turn to end. */
export const STALLED_TURN_PROMPT =
  "Your previous turn ended without a reply, for example because the host restarted. The owned Swarm task " +
  "remains running. Continue the work, or use swarm.nodes.complete after acceptance; block/fail only when the " +
  "task cannot proceed. Conversational final text does not complete the task.";

/** The block reason of a task whose agent stays idle after its reminders. */
export const STALLED_BLOCK_REASON =
  "Agent stayed idle without a reply or an explicit outcome after two reminders; explicit resolution is required.";

/** How a stall probe ends a wait: the attempt is stale, or its agent cannot continue. */
export type StallProbeStop =
  | { readonly stop: "stale" }
  | { readonly stop: "failed"; readonly error: string };

/** Waits for an agent and runs the probe at each interval until the wait settles or the probe stops it. */
export async function waitWithStallProbe<T>(
  wait: Promise<T>,
  intervalMs: number,
  probe: () => Promise<StallProbeStop | undefined>,
): Promise<{ readonly value: T } | StallProbeStop> {
  const settled = wait.then((value) => ({ value }));
  void settled.catch(() => undefined);
  while (true) {
    let release = (): void => undefined;
    const tick = new Promise<undefined>((resolve) => {
      const handle = setTimeout(resolve, intervalMs);
      release = () => clearTimeout(handle);
    });
    const first = await Promise.race([settled, tick]);
    release();
    if (first) return first;
    const stopped = await probe();
    if (stopped) return stopped;
  }
}
