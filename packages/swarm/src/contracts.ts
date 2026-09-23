export * from "./contract-types.js";
export {
  SwarmValidationError,
  validateSwarmRunEvent,
  validateSwarmRoleModels,
} from "./event-validation.js";
import {
  type SwarmJsonValue,
  type SwarmRunState,
  SWARM_OWNER_SESSION_SUPERSEDED_ERROR,
  SWARM_OWNER_SESSION_BUSY_ERROR,
  type SwarmPauseReason,
  type SwarmRunTarget,
  type SwarmTask,
  type SwarmRunEvent,
  type SwarmRun,
} from "./contract-types.js";
import {
  SwarmValidationError,
  validateSwarmRunEvent,
  isOwnedTaskEvent,
  assertNonEmptyString,
  eventError,
} from "./event-validation.js";
export function assertSwarmRunId(value: unknown): asserts value is string {
  assertNonEmptyString(value, "runId");
}
export function swarmIntegrationRef(runId: string, scope: string): string {
  assertSwarmRunId(runId);
  assertNonEmptyString(scope, "scope");
  return `refs/swarm/${slug(runId)}/integration/${slug(scope)}`;
}
export function swarmRunTargets(run: SwarmRun): readonly SwarmRunTarget[] {
  return (
    run.targets ??
    (run.targetRef && run.targetHead
      ? Object.freeze([{ scope: run.scope, ref: run.targetRef, head: run.targetHead }])
      : Object.freeze([]))
  );
}
export function replaySwarmRun(events: readonly unknown[]): SwarmRun {
  if (!Array.isArray(events) || events.length === 0)
    throw new SwarmValidationError("A swarm run must contain a run.created event.");
  const first = validateSwarmRunEvent(events[0], 0);
  if (first.type !== "run.created") throw eventError(0, "The first event must be run.created.");
  const legacy =
    first.protocolVersion === undefined && !events.some((event) => isOwnedTaskEvent(event));
  const tasks = new Map<string, SwarmTask>();
  let state: SwarmRunState = "running";
  let pauseReason: SwarmPauseReason | undefined;
  let result: SwarmJsonValue | undefined;
  let error: SwarmJsonValue | undefined;
  let roleModels = first.roleModels;
  for (const [offset, raw] of events.slice(1).entries()) {
    const event = validateSwarmRunEvent(raw, offset + 1, legacy);
    if (event.type === "run.created")
      throw eventError(offset + 1, "run.created may appear only once.");
    switch (event.type) {
      case "run.roleModelsUpdated": {
        assertNotTerminal(state, offset + 1, event.type);
        const root = [...tasks.values()].find((task) => task.parentTaskId === undefined);
        if (
          legacy ||
          !root ||
          root.ownerSessionId !== event.ownerSessionId ||
          root.ownerPrincipalId !== event.ownerPrincipalId
        )
          throw eventError(offset + 1, "Only the original root owner may update role models.");
        roleModels = { ...roleModels, ...event.roleModels };
        break;
      }
      case "run.paused":
        assertNotTerminal(state, offset + 1, event.type);
        state = "paused";
        pauseReason = event.reason;
        break;
      case "run.resumed":
        // Failed/cancelled runs re-enter only via run.systemFailureRecovered (-> paused).
        if (state === "completed" || (!legacy && state === "failed"))
          throw eventError(offset + 1, "run.resumed may not follow a terminal run state.");
        state = "running";
        pauseReason = undefined;
        result = undefined;
        error = undefined;
        for (const [id, task] of tasks)
          if (task.state === "running")
            tasks.set(id, {
              ...task,
              resumeReason: "Run resumed after pause.",
              resumeCount: (task.resumeCount ?? 0) + 1,
              idleReminders: 0,
            });
        break;
      case "run.systemFailureRecovered": {
        const root = requireTask(tasks, event.taskId, offset + 1);
        const expectedError =
          event.classification === "owner-session-superseded-transport"
            ? SWARM_OWNER_SESSION_SUPERSEDED_ERROR
            : SWARM_OWNER_SESSION_BUSY_ERROR;
        const taskFailure = events[event.expectedTaskFailureIndex - 1] as SwarmRunEvent | undefined;
        const runFailure = events[event.expectedRunFailureIndex - 1] as SwarmRunEvent | undefined;
        if (
          legacy ||
          state !== "failed" ||
          root.parentTaskId !== undefined ||
          root.state !== "failed" ||
          event.expectedRunFailureIndex !== event.expectedTaskFailureIndex + 1 ||
          event.expectedRunFailureIndex > offset + 1 ||
          !events
            .slice(event.expectedRunFailureIndex, offset + 1)
            .every((value) =>
              ["task.execution", "task.continued"].includes((value as SwarmRunEvent).type),
            ) ||
          taskFailure?.type !== "task.failed" ||
          taskFailure.taskId !== root.taskId ||
          taskFailure.error !== expectedError ||
          taskFailure.failureOrigin === "agent" ||
          (event.classification === "owner-session-busy-transport" &&
            taskFailure.failureOrigin === "runtime" &&
            taskFailure.failureCode !== "SESSION_BUSY") ||
          runFailure?.type !== "run.failed" ||
          runFailure.error !== expectedError ||
          root.ownerSessionId !== event.ownerSessionId ||
          root.ownerPrincipalId !== event.ownerPrincipalId ||
          !root.executions.some((execution) => execution.sessionId === event.ownerSessionId)
        ) {
          throw eventError(
            offset + 1,
            "Recovery requires the exact failed owner-session transport tail and root identity.",
          );
        }
        state = "paused";
        pauseReason = {
          kind: "manual",
          message: `System failure recovered: ${event.reason}. Explicit resume required.`,
        };
        error = undefined;
        result = undefined;
        tasks.set(root.taskId, {
          ...root,
          state: "running",
          error: undefined,
          reason: undefined,
          resumeReason: event.reason,
          resumeCount: (root.resumeCount ?? 0) + 1,
          idleReminders: 0,
        });
        break;
      }
      case "run.completed":
        assertNotTerminal(state, offset + 1, event.type);
        state = "completed";
        pauseReason = undefined;
        result = event.result;
        error = undefined;
        break;
      case "run.failed":
        assertNotTerminal(state, offset + 1, event.type);
        state = "failed";
        pauseReason = undefined;
        result = undefined;
        error = event.error;
        break;
      case "run.cancelled":
        assertNotTerminal(state, offset + 1, event.type);
        state = "failed";
        pauseReason = undefined;
        result = undefined;
        error = event.error;
        break;
      case "task.added":
        if (
          event.task.idempotencyKey &&
          [...tasks.values()].some(
            (t) =>
              t.parentTaskId === event.task.parentTaskId &&
              t.idempotencyKey === event.task.idempotencyKey,
          )
        )
          throw eventError(offset + 1, "Duplicate launch idempotency key.");
        if (tasks.has(event.task.taskId))
          throw eventError(offset + 1, `Task "${event.task.taskId}" already exists.`);
        if (event.task.parentTaskId) {
          const parent = requireTask(tasks, event.task.parentTaskId, offset + 1);
          if (!legacy && parent.state !== "running")
            throw eventError(offset + 1, "Parent must be running.");
          tasks.set(parent.taskId, {
            ...parent,
            childTaskIds: [...parent.childTaskIds, event.task.taskId],
          });
        } else if (tasks.size) throw eventError(offset + 1, "Only one root is permitted.");
        for (const id of event.task.dependencyTaskIds ?? []) requireTask(tasks, id, offset + 1);
        tasks.set(event.task.taskId, {
          ...event.task,
          dependencyTaskIds: event.task.dependencyTaskIds ?? [],
          childTaskIds: [],
          artifactRefs: [],
          executions: [],
          state: "pending",
        });
        break;
      case "task.started": {
        const task = requireTask(tasks, event.taskId, offset + 1);
        if (!legacy && task.state !== "pending")
          throw eventError(offset + 1, "Only pending tasks can start.");
        if ((task.dependencyTaskIds ?? []).some((id) => tasks.get(id)?.state !== "completed"))
          throw eventError(offset + 1, "Dependencies must be completed.");
        if (!legacy && !hasLiveParent(tasks, task))
          throw eventError(offset + 1, "Parent task is no longer live.");
        tasks.set(event.taskId, {
          ...task,
          state: "running",
          delegationId: event.delegationId,
          result: undefined,
          error: undefined,
          changeRefs: undefined,
        });
        break;
      }
      case "task.completed": {
        const task = requireTask(tasks, event.taskId, offset + 1);
        if (!legacy && task.state !== "running")
          throw eventError(offset + 1, "Only running tasks can complete.");
        if (
          !legacy &&
          [...tasks.values()].some(
            (child) =>
              child.taskId.startsWith(`${task.taskId}/`) &&
              child.state !== "completed" &&
              child.state !== "failed",
          )
        )
          throw eventError(offset + 1, "Children must be terminal.");
        const completionArtifactKinds =
          task.role === "reviewer"
            ? ["review"]
            : task.role === "reconciler"
              ? ["reconciliation"]
              : ["plan", "decision", "report"];
        if (
          !legacy &&
          task.role !== "worker" &&
          !task.artifactRefs.some((artifact) => completionArtifactKinds.includes(artifact.kind))
        )
          throw eventError(
            offset + 1,
            `Task "${task.taskId}": ${task.role} requires an artifact of kind ${completionArtifactKinds.map((kind) => `"${kind}"`).join(" or ")}; recorded kinds: ${[...new Set(task.artifactRefs.map((artifact) => artifact.kind))].join(", ") || "none"}. ` +
              "Use swarm.nodes.publishArtifact to publish the required kind (the same URI can be republished with corrected metadata), then retry swarm.nodes.complete. An inline artifact in complete does not publish it.",
          );
        tasks.set(event.taskId, {
          ...task,
          state: "completed",
          result: event.result,
          error: undefined,
          changeRefs: event.changeRefs,
        });
        break;
      }
      case "task.failed":
      case "task.cancelled": {
        const task = requireTask(tasks, event.taskId, offset + 1);
        if (!legacy && (task.state === "completed" || task.state === "failed"))
          throw eventError(offset + 1, "Terminal tasks cannot change.");
        tasks.set(event.taskId, {
          ...task,
          state: "failed",
          reason:
            typeof event.error === "string"
              ? event.error
              : (JSON.stringify(event.error) ?? "Task cancelled."),
          result: undefined,
          error: event.error,
          changeRefs: event.changeRefs,
        });
        break;
      }
      case "task.blocked":
      case "task.resumed": {
        const task = requireTask(tasks, event.taskId, offset + 1);
        if (event.type === "task.blocked" ? task.state !== "running" : task.state !== "blocked")
          throw eventError(offset + 1, "Invalid block/resume transition.");
        tasks.set(task.taskId, {
          ...task,
          state: event.type === "task.blocked" ? "blocked" : "running",
          reason: event.type === "task.blocked" ? event.reason : undefined,
          delegationId: task.delegationId,
          ...(event.type === "task.resumed"
            ? {
                resumeReason: event.reason,
                resumeCount: (task.resumeCount ?? 0) + 1,
                idleReminders: 0,
              }
            : {}),
        });
        break;
      }
      case "task.continuationRequested": {
        const task = requireTask(tasks, event.taskId, offset + 1);
        if (task.state !== "running")
          throw eventError(offset + 1, "Only running tasks may request continuation.");
        tasks.set(task.taskId, {
          ...task,
          resumeReason: event.reason,
          resumeCount: (task.resumeCount ?? 0) + 1,
          idleReminders: 0,
        });
        break;
      }
      case "task.artifact": {
        const task = requireTask(tasks, event.taskId, offset + 1);
        if (task.state !== "running")
          throw eventError(offset + 1, "Only running tasks publish artifacts.");
        tasks.set(task.taskId, {
          ...task,
          artifactRefs: [
            ...task.artifactRefs.filter((a) => a.uri !== event.artifact.uri),
            event.artifact,
          ],
        });
        break;
      }
      case "task.dispatched": {
        const task = requireTask(tasks, event.taskId, offset + 1);
        if (
          task.state !== "pending" ||
          (task.dependencyTaskIds ?? []).some((id) => tasks.get(id)?.state !== "completed")
        )
          throw eventError(offset + 1, "Task is not ready for dispatch.");
        if (!legacy && !hasLiveParent(tasks, task))
          throw eventError(offset + 1, "Parent task is no longer live.");
        tasks.set(task.taskId, {
          ...task,
          state: "running",
          delegationId: event.execution.delegationId,
          executions: [...task.executions, event.execution],
        });
        break;
      }
      case "task.execution": {
        const task = requireTask(tasks, event.taskId, offset + 1);
        tasks.set(task.taskId, {
          ...task,
          executions: [
            ...task.executions.filter((e) => e.executionId !== event.execution.executionId),
            event.execution,
          ],
        });
        break;
      }
      case "task.childrenNotified": {
        const task = requireTask(tasks, event.taskId, offset + 1);
        tasks.set(task.taskId, { ...task, childAttentionSignature: event.signature });
        break;
      }
      case "task.continued": {
        const task = requireTask(tasks, event.taskId, offset + 1);
        tasks.set(task.taskId, { ...task, resumeReason: undefined });
        break;
      }
      case "task.reminded": {
        const task = requireTask(tasks, event.taskId, offset + 1);
        if (task.state !== "running")
          throw eventError(offset + 1, "Only running tasks may be reminded.");
        tasks.set(task.taskId, {
          ...task,
          idleReminders: (task.idleReminders ?? 0) + 1,
        });
        break;
      }
    }
  }
  if (legacy && state !== "completed" && state !== "failed") {
    state = "paused";
    pauseReason = {
      kind: "manual",
      message: "Legacy run is read-only. Start a new explicit-protocol run to continue this work.",
    };
  }
  return deepFreeze({
    ...(legacy ? { legacyReadOnly: true } : { protocolVersion: 2 as const }),
    runId: first.runId,
    objective: first.objective,
    scope: first.scope,
    ...(first.targetRef === undefined ? {} : { targetRef: first.targetRef }),
    ...(first.targetHead === undefined ? {} : { targetHead: first.targetHead }),
    ...(first.targets === undefined
      ? {}
      : { targets: first.targets.map((target) => ({ ...target })) }),
    ...(first.workerModel === undefined ? {} : { workerModel: first.workerModel }),
    ...(first.workerReasoningEffort === undefined
      ? {}
      : { workerReasoningEffort: first.workerReasoningEffort }),
    ...(roleModels === undefined ? {} : { roleModels }),
    state,
    ...(state === "paused" && pauseReason ? { pauseReason } : {}),
    tasks: [...tasks.values()],
    ...(result === undefined ? {} : { result }),
    ...(error === undefined ? {} : { error }),
  });
}
function requireTask(tasks: Map<string, SwarmTask>, id: string, index: number): SwarmTask {
  const task = tasks.get(id);
  if (!task) throw eventError(index, `Unknown task "${id}".`);
  return task;
}
function hasLiveParent(tasks: ReadonlyMap<string, SwarmTask>, task: SwarmTask): boolean {
  if (task.parentTaskId === undefined) return true;
  const parent = tasks.get(task.parentTaskId);
  return parent !== undefined && parent.state !== "completed" && parent.state !== "failed";
}
function assertNotTerminal(state: SwarmRunState, index: number, type: string): void {
  if (state === "completed" || state === "failed")
    throw eventError(index, `${type} may not follow a terminal run state.`);
}
function slug(value: string): string {
  return (
    value
      .replace(/[^A-Za-z0-9._-]/g, "-")
      .replace(/\.{2,}/g, "-")
      .replace(/^\./, "-")
      .replace(/\.$/, "-")
      .replace(/\.lock$/i, "-lock") || "-"
  );
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value as object).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}
