import {
  SWARM_OWNER_SESSION_BUSY_ERROR,
  SWARM_OWNER_SESSION_SUPERSEDED_ERROR,
  type SwarmRun,
  type SwarmRunEvent,
  type SwarmRunUpdateEvent,
  type SwarmTask,
} from "./contracts.js";

const LIVE_STATES = new Set(["pending", "running", "blocked"]);

/** A pending task may only start while its parent can still consume its result. */
export function parentIsLive(run: SwarmRun, task: SwarmTask): boolean {
  if (task.parentTaskId === undefined) return true;
  const parent = run.tasks.find((candidate) => candidate.taskId === task.parentTaskId);
  return parent !== undefined && LIVE_STATES.has(parent.state);
}

/** The exact root failure `recoverSystemFailure` can undo: its live children are
 *  kept so the recovered root resumes with its native child lineage intact. */
function isRecoverableRootFailure(run: SwarmRun, event: SwarmRunEvent): boolean {
  if (event.type !== "task.failed" || event.failureOrigin === "agent") return false;
  const task = run.tasks.find((candidate) => candidate.taskId === event.taskId);
  return (
    task?.parentTaskId === undefined &&
    (event.error === SWARM_OWNER_SESSION_BUSY_ERROR ||
      event.error === SWARM_OWNER_SESSION_SUPERSEDED_ERROR)
  );
}

/**
 * Events `finishRun` appends before `run.failed` for a failed root. Recovery
 * needs `run.failed` to directly follow the root's recoverable failure, so
 * live children are kept only while that failure is still the journal tail;
 * otherwise the run can never be recovered and its live tasks are cancelled.
 */
export function rootFailureCancellations(
  run: SwarmRun,
  tail: SwarmRunEvent | undefined,
  reason: SwarmTask["error"],
): CascadedEvents {
  const root = run.tasks.find((task) => task.parentTaskId === undefined);
  if (
    tail?.type === "task.failed" &&
    tail.taskId === root?.taskId &&
    isRecoverableRootFailure(run, tail)
  )
    return { events: [], cancelledDelegationIds: [] };
  const live = run.tasks.filter((task) => LIVE_STATES.has(task.state));
  return {
    events: live.map((task) => ({
      type: "task.cancelled" as const,
      taskId: task.taskId,
      error: reason ?? "Root task failed.",
    })),
    cancelledDelegationIds: live.flatMap((task) =>
      task.state === "running" && task.delegationId !== undefined ? [task.delegationId] : [],
    ),
  };
}

export interface CascadedEvents {
  readonly events: readonly SwarmRunUpdateEvent[];
  /** Delegations of running tasks the cascade cancelled. */
  readonly cancelledDelegationIds: readonly string[];
}

/**
 * Expands a batch so no failed task leaves live work beneath it: every
 * `task.failed`/`task.cancelled` is followed by `task.cancelled` for each live
 * descendant (ids are `${parentId}/...`). A failure for a task that is already
 * terminal (a stale outcome raced a cascade or cancel) is dropped instead of
 * letting the reducer reject the whole append.
 */
export function withFailureCascade(
  run: SwarmRun,
  events: readonly SwarmRunUpdateEvent[],
): CascadedEvents {
  const terminal = new Set(
    run.tasks.filter((task) => !LIVE_STATES.has(task.state)).map((task) => task.taskId),
  );
  // A task the batch terminates itself (e.g. cancel's per-node reason) keeps its own event.
  const explicit = new Set(
    events.flatMap((event) =>
      event.type === "task.failed" || event.type === "task.cancelled" ? [event.taskId] : [],
    ),
  );
  const out: SwarmRunUpdateEvent[] = [];
  const cancelledDelegationIds: string[] = [];
  for (const event of events) {
    if (event.type !== "task.failed" && event.type !== "task.cancelled") {
      out.push(event);
      continue;
    }
    if (terminal.has(event.taskId)) continue;
    out.push(event);
    terminal.add(event.taskId);
    if (isRecoverableRootFailure(run, event)) continue;
    for (const task of run.tasks) {
      if (
        !task.taskId.startsWith(`${event.taskId}/`) ||
        terminal.has(task.taskId) ||
        explicit.has(task.taskId)
      )
        continue;
      terminal.add(task.taskId);
      out.push({
        type: "task.cancelled",
        taskId: task.taskId,
        error: `Ancestor task "${event.taskId}" failed.`,
      });
      if (task.state === "running" && task.delegationId !== undefined)
        cancelledDelegationIds.push(task.delegationId);
    }
  }
  return { events: out, cancelledDelegationIds };
}
