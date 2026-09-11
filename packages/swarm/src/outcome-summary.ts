import type { SwarmRun, SwarmTask, SwarmTaskRole, SwarmTaskState } from "./contracts.js";

/**
 * Derived, read-time projection of what the run's task states actually say.
 * Computed from existing state on every read — never stored, never blocking:
 * "completed" keeps meaning "execution settled", this only stops it from
 * READING as "everything succeeded" when the task list says otherwise. It
 * makes no claim about objective success; goal-level acceptance stays with
 * the transition reviewer.
 */
export interface SwarmFailedTaskIdentity {
  readonly taskId: string;
  readonly role: SwarmTaskRole;
  readonly objective: string;
  readonly reason?: string;
}

export interface SwarmRunOutcomeSummary {
  readonly taskCounts: Readonly<Partial<Record<SwarmTaskState, number>>>;
  readonly totalTasks: number;
  readonly failedTasks: readonly SwarmFailedTaskIdentity[];
  /** Count of failed tasks beyond the bounded identity list; total failed = failedTasks.length + this. */
  readonly failedTasksOmitted?: number;
  /** Present only for terminal run states; factual state readback, no success claim. */
  readonly headline?: string;
}

const OBJECTIVE_LIMIT = 160;
const REASON_LIMIT = 256;
/** The listed identities stay bounded; the true count lives in taskCounts.failed. */
const FAILED_TASK_LIST_LIMIT = 20;

export function summarizeRunOutcome(run: SwarmRun): SwarmRunOutcomeSummary {
  const taskCounts: Partial<Record<SwarmTaskState, number>> = {};
  const failedTasks: SwarmFailedTaskIdentity[] = [];
  let failedTotal = 0;
  // run.tasks is event-ordered, so the projection is deterministic for a given run state.
  for (const task of run.tasks) {
    taskCounts[task.state] = (taskCounts[task.state] ?? 0) + 1;
    if (task.state !== "failed") continue;
    failedTotal += 1;
    if (failedTasks.length >= FAILED_TASK_LIST_LIMIT) continue;
    failedTasks.push({
      taskId: task.taskId,
      role: task.role,
      objective: firstLine(task.objective, OBJECTIVE_LIMIT),
      ...(failureReason(task) ? { reason: failureReason(task) } : {}),
    });
  }
  const headline = terminalHeadline(run.state, run.tasks.length, taskCounts.completed ?? 0, failedTotal);
  return {
    taskCounts,
    totalTasks: run.tasks.length,
    failedTasks,
    ...(failedTotal > failedTasks.length ? { failedTasksOmitted: failedTotal - failedTasks.length } : {}),
    ...(headline ? { headline } : {}),
  };
}

function terminalHeadline(
  state: SwarmRun["state"],
  total: number,
  completed: number,
  failed: number,
): string | undefined {
  if (state === "completed") {
    return failed > 0
      ? `Execution completed with ${failed} failed task${failed === 1 ? "" : "s"} (${completed} of ${total} completed).`
      : `Execution completed; all ${total} task${total === 1 ? "" : "s"} reached completed.`;
  }
  if (state === "failed") {
    return `Execution failed (${completed} of ${total} tasks completed, ${failed} failed).`;
  }
  return undefined;
}

function failureReason(task: SwarmTask): string | undefined {
  if (typeof task.reason === "string" && task.reason.trim()) return bounded(task.reason, REASON_LIMIT);
  if (typeof task.error === "string" && task.error.trim()) return bounded(task.error, REASON_LIMIT);
  if (task.error !== undefined && task.error !== null) {
    const message = (task.error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return bounded(message, REASON_LIMIT);
  }
  return undefined;
}

function firstLine(text: string, limit: number): string {
  const line = text.slice(0, 512).trim().split(/[\r\n]/, 1)[0] ?? "";
  return bounded(line.replace(/\s+/g, " ").trim(), limit);
}

function bounded(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}
