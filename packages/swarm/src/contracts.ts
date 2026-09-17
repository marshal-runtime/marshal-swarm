export type SwarmJsonPrimitive = null | boolean | number | string;
export type SwarmJsonValue =
  | SwarmJsonPrimitive
  | readonly SwarmJsonValue[]
  | {
      readonly [key: string]: SwarmJsonValue;
    };
export type SwarmTaskState =
  "pending" | "running" | "blocked" | "completed" | "failed";
export type SwarmRunState = Exclude<SwarmTaskState, "pending"> | "paused";
export type SwarmTaskRole = "planner" | "worker" | "reconciler" | "reviewer";
export type SwarmRoleModels = Readonly<Partial<Record<SwarmTaskRole, {
  readonly model: string;
  readonly reasoningEffort?: string;
}>>>;
export const SWARM_OWNER_SESSION_SUPERSEDED_ERROR = "Session send was superseded before it started";
export const SWARM_OWNER_SESSION_BUSY_ERROR = "Another message or turn is already active for this session";
export type SwarmPauseReason =
  | {
      readonly kind: "manual";
      readonly message: string;
    }
  | {
      readonly kind: "environmental";
      readonly operation: "worktree.create";
      readonly taskId: string;
      readonly attempts: 3;
      readonly message: string;
      readonly code?: string;
      readonly category?: string;
    };
export interface SwarmTaskDefinition {
  readonly taskId: string;
  readonly parentTaskId?: string;
  readonly role: SwarmTaskRole;
  readonly objective: string;
  readonly scope: string;
  readonly dependencyTaskIds?: readonly string[];
  readonly idempotencyKey?: string;
  readonly ownerSessionId?: string;
  readonly ownerPrincipalId?: string;
  readonly createdAt?: string;
}
export interface SwarmRunTarget {
  readonly scope: string;
  readonly ref: string;
  readonly head: string;
}
export interface SwarmRunCreateConfiguration {
  readonly workerModel?: string;
  readonly workerReasoningEffort?: string;
  readonly roleModels?: SwarmRoleModels;
}
export interface SwarmArtifactReference {
  readonly uri: string;
  readonly summary: string;
  readonly kind: "plan" | "decision" | "review" | "reconciliation" | "report";
}
export interface SwarmExecutionRecord {
  readonly executionId: string;
  readonly kind?: "dispatch" | "turn";
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly launchInput?: Readonly<Record<string, SwarmJsonValue>>;
  readonly dispatchState?: "registered" | "dispatched";
  readonly delegationId?: string;
  readonly sessionId?: string;
  readonly transcriptRef?: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly usageByModel?: readonly {
    readonly model?: string;
    readonly usage: {
      readonly inputTokens?: number;
      readonly outputTokens?: number;
      readonly cachedInputTokens?: number;
      readonly reportedCost?: number;
    };
  }[];
  readonly usage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly cachedInputTokens?: number;
    readonly reportedCost?: number;
  };
}
export interface SwarmNodeAck {
  readonly taskId: string;
  readonly state: SwarmTaskState;
  readonly resumeCount: number;
}
export interface SwarmTask extends SwarmTaskDefinition {
  readonly state: SwarmTaskState;
  readonly childTaskIds: readonly string[];
  readonly artifactRefs: readonly SwarmArtifactReference[];
  readonly executions: readonly SwarmExecutionRecord[];
  readonly reason?: string;
  readonly idleReminders?: number;
  readonly resumeReason?: string;
  readonly resumeCount?: number;
  readonly childAttentionSignature?: string;
  readonly delegationId?: string;
  readonly result?: SwarmJsonValue;
  readonly error?: SwarmJsonValue;
  readonly changeRefs?: readonly string[];
}
export type SwarmRunEvent =
  | {
      readonly type: "run.created";
      readonly protocolVersion?: 2;
      readonly runId: string;
      readonly objective: string;
      readonly scope: string;
      readonly targetRef?: string;
      readonly targetHead?: string;
      readonly targets?: readonly SwarmRunTarget[];
      readonly workerModel?: string;
      readonly workerReasoningEffort?: string;
      readonly roleModels?: SwarmRoleModels;
    }
  | {
      readonly type: "run.roleModelsUpdated";
      readonly roleModels: SwarmRoleModels;
      readonly reason: string;
      readonly ownerSessionId: string;
      readonly ownerPrincipalId: string;
    }
  | {
      readonly type: "run.paused";
      readonly reason: SwarmPauseReason;
    }
  | {
      readonly type: "run.resumed";
    }
  | {
      readonly type: "run.systemFailureRecovered";
      readonly taskId: string;
      readonly reason: string;
      readonly classification: "owner-session-busy-transport" | "owner-session-superseded-transport";
      readonly expectedTaskFailureIndex: number;
      readonly expectedRunFailureIndex: number;
      readonly ownerSessionId: string;
      readonly ownerPrincipalId: string;
    }
  | {
      readonly type: "run.completed";
      readonly result?: SwarmJsonValue;
    }
  | {
      readonly type: "run.failed";
      readonly error: SwarmJsonValue;
    }
  | {
      readonly type: "run.cancelled";
      readonly error?: SwarmJsonValue;
    }
  | {
      readonly type: "task.added";
      readonly task: SwarmTaskDefinition;
    }
  | {
      readonly type: "task.blocked" | "task.resumed";
      readonly taskId: string;
      readonly reason: string;
    }
  | {
      readonly type: "task.artifact";
      readonly taskId: string;
      readonly artifact: SwarmArtifactReference;
    }
  | {
      readonly type: "task.execution" | "task.dispatched";
      readonly taskId: string;
      readonly execution: SwarmExecutionRecord;
    }
  | {
      readonly type: "task.reminded" | "task.continued";
      readonly taskId: string;
    }
  | {
      readonly type: "task.childrenNotified";
      readonly taskId: string;
      readonly signature: string;
    }
  | {
      readonly type: "task.started";
      readonly taskId: string;
      readonly delegationId?: string;
    }
  | {
      readonly type: "task.completed";
      readonly taskId: string;
      readonly result?: SwarmJsonValue;
      readonly changeRefs?: readonly string[];
    }
  | {
      readonly type: "task.failed";
      readonly taskId: string;
      readonly error: SwarmJsonValue;
      readonly changeRefs?: readonly string[];
      readonly failureOrigin?: "runtime" | "agent";
      readonly failureCode?: "SESSION_BUSY";
    }
  | {
      readonly type: "task.cancelled";
      readonly taskId: string;
      readonly error?: SwarmJsonValue;
      readonly changeRefs?: readonly string[];
    };
export type SwarmRunUpdateEvent = Exclude<
  SwarmRunEvent,
  {
    readonly type: "run.created";
  }
>;
export interface SwarmRun {
  readonly protocolVersion?: 2;
  readonly legacyReadOnly?: boolean;
  readonly runId: string;
  readonly objective: string;
  readonly scope: string;
  readonly targetRef?: string;
  readonly targetHead?: string;
  readonly targets?: readonly SwarmRunTarget[];
  readonly workerModel?: string;
  readonly workerReasoningEffort?: string;
  readonly roleModels?: SwarmRoleModels;
  readonly state: SwarmRunState;
  readonly pauseReason?: SwarmPauseReason;
  readonly tasks: readonly SwarmTask[];
  readonly result?: SwarmJsonValue;
  readonly error?: SwarmJsonValue;
}
export class SwarmValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SwarmValidationError";
  }
}
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
      ? Object.freeze([
          { scope: run.scope, ref: run.targetRef, head: run.targetHead },
        ])
      : Object.freeze([]))
  );
}
export function replaySwarmRun(events: readonly unknown[]): SwarmRun {
  if (!Array.isArray(events) || events.length === 0)
    throw new SwarmValidationError(
      "A swarm run must contain a run.created event.",
    );
  const first = validateSwarmRunEvent(events[0], 0);
  if (first.type !== "run.created")
    throw eventError(0, "The first event must be run.created.");
  const legacy =
    first.protocolVersion === undefined &&
    !events.some((event) => isOwnedTaskEvent(event));
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
        if (legacy || !root || root.ownerSessionId !== event.ownerSessionId || root.ownerPrincipalId !== event.ownerPrincipalId)
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
        if (state === "completed")
          throw eventError(
            offset + 1,
            "run.resumed may not follow a terminal run state.",
          );
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
        const expectedError = event.classification === "owner-session-superseded-transport" ? SWARM_OWNER_SESSION_SUPERSEDED_ERROR : SWARM_OWNER_SESSION_BUSY_ERROR;
        const taskFailure = events[event.expectedTaskFailureIndex - 1] as SwarmRunEvent | undefined;
        const runFailure = events[event.expectedRunFailureIndex - 1] as SwarmRunEvent | undefined;
        if (legacy || state !== "failed" || root.parentTaskId !== undefined || root.state !== "failed" ||
            event.expectedRunFailureIndex !== event.expectedTaskFailureIndex + 1 || event.expectedRunFailureIndex > offset + 1 ||
            !events.slice(event.expectedRunFailureIndex, offset + 1).every((value) =>
              ["task.execution", "task.continued"].includes((value as SwarmRunEvent).type)) ||
            taskFailure?.type !== "task.failed" || taskFailure.taskId !== root.taskId ||
            taskFailure.error !== expectedError || taskFailure.failureOrigin === "agent" ||
            (event.classification === "owner-session-busy-transport" && taskFailure.failureOrigin === "runtime" && taskFailure.failureCode !== "SESSION_BUSY") ||
            runFailure?.type !== "run.failed" || runFailure.error !== expectedError ||
            root.ownerSessionId !== event.ownerSessionId || root.ownerPrincipalId !== event.ownerPrincipalId ||
            !root.executions.some((execution) => execution.sessionId === event.ownerSessionId)) {
          throw eventError(offset + 1, "Recovery requires the exact failed owner-session transport tail and root identity.");
        }
        state = "paused";
        pauseReason = { kind: "manual", message: `System failure recovered: ${event.reason}. Explicit resume required.` };
        error = undefined;
        result = undefined;
        tasks.set(root.taskId, { ...root, state: "running", error: undefined, reason: undefined,
          resumeReason: event.reason, resumeCount: (root.resumeCount ?? 0) + 1, idleReminders: 0 });
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
          throw eventError(
            offset + 1,
            `Task "${event.task.taskId}" already exists.`,
          );
        if (event.task.parentTaskId) {
          const parent = requireTask(
            tasks,
            event.task.parentTaskId,
            offset + 1,
          );
          if (!legacy && parent.state !== "running")
            throw eventError(offset + 1, "Parent must be running.");
          tasks.set(parent.taskId, {
            ...parent,
            childTaskIds: [...parent.childTaskIds, event.task.taskId],
          });
        } else if (tasks.size)
          throw eventError(offset + 1, "Only one root is permitted.");
        for (const id of event.task.dependencyTaskIds ?? [])
          requireTask(tasks, id, offset + 1);
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
        if (
          (task.dependencyTaskIds ?? []).some(
            (id) => tasks.get(id)?.state !== "completed",
          )
        )
          throw eventError(offset + 1, "Dependencies must be completed.");
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
        const completionArtifactKinds = task.role === "reviewer"
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
        if (
          event.type === "task.blocked"
            ? task.state !== "running"
            : task.state !== "blocked"
        )
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
          (task.dependencyTaskIds ?? []).some(
            (id) => tasks.get(id)?.state !== "completed",
          )
        )
          throw eventError(offset + 1, "Task is not ready for dispatch.");
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
            ...task.executions.filter(
              (e) => e.executionId !== event.execution.executionId,
            ),
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
      message:
        "Legacy run is read-only. Start a new explicit-protocol run to continue this work.",
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
    ...(first.workerModel === undefined
      ? {}
      : { workerModel: first.workerModel }),
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
export function validateSwarmRunEvent(
  value: unknown,
  index = 0,
  legacy = false,
): SwarmRunEvent {
  const location = `Event ${index + 1}`;
  plain(value, location);
  switch (value.type) {
    case "run.created":
      if (value.protocolVersion !== undefined && value.protocolVersion !== 2)
        throw new SwarmValidationError("Unsupported Swarm protocol version.");
      assertSwarmRunId(value.runId);
      assertNonEmptyString(value.objective, `${location}.objective`);
      assertNonEmptyString(value.scope, `${location}.scope`);
      optionalText(value, "targetRef", location);
      optionalText(value, "targetHead", location);
      optionalText(value, "workerModel", location);
      optionalText(value, "workerReasoningEffort", location);
      if (value.roleModels !== undefined) validateSwarmRoleModels(value.roleModels);
      if (value.targets !== undefined) {
        if (!Array.isArray(value.targets) || value.targets.length === 0)
          throw new SwarmValidationError(
            `${location}.targets must be a non-empty array.`,
          );
        value.targets.forEach((target, i) => {
          plain(target, `${location}.targets[${i}]`);
          assertNonEmptyString(target.scope, `${location}.targets[${i}].scope`);
          assertNonEmptyString(target.ref, `${location}.targets[${i}].ref`);
          assertNonEmptyString(target.head, `${location}.targets[${i}].head`);
        });
      }
      break;
    case "run.paused":
      validatePause(value.reason, location);
      break;
    case "run.roleModelsUpdated":
      validateSwarmRoleModels(value.roleModels);
      for (const key of ["reason", "ownerSessionId", "ownerPrincipalId"])
        assertNonEmptyString(value[key], `${location}.${key}`);
      break;
    case "run.resumed":
      break;
    case "run.systemFailureRecovered":
      for (const key of ["taskId", "reason", "ownerSessionId", "ownerPrincipalId"])
        assertNonEmptyString(value[key], `${location}.${key}`);
      if (value.classification !== "owner-session-busy-transport" && value.classification !== "owner-session-superseded-transport")
        throw new SwarmValidationError("Recovery requires an explicit supported owner-session transport classification.");
      for (const key of ["expectedTaskFailureIndex", "expectedRunFailureIndex"])
        if (!Number.isSafeInteger(value[key]) || Number(value[key]) < 1)
          throw new SwarmValidationError(`${location}.${key} must be a positive event index.`);
      break;
    case "run.completed":
      optionalJson(value, "result", location);
      break;
    case "run.failed":
      json(value.error, `${location}.error`);
      break;
    case "run.cancelled":
      optionalJson(value, "error", location);
      break;
    case "task.blocked":
    case "task.resumed":
      assertNonEmptyString(value.taskId, `${location}.taskId`);
      assertNonEmptyString(value.reason, `${location}.reason`);
      break;
    case "task.childrenNotified":
      assertNonEmptyString(value.taskId, `${location}.taskId`);
      assertNonEmptyString(value.signature, `${location}.signature`);
      break;
    case "task.continued":
    case "task.reminded":
      assertNonEmptyString(value.taskId, `${location}.taskId`);
      break;
    case "task.artifact":
      assertNonEmptyString(value.taskId, `${location}.taskId`);
      plain(value.artifact, location);
      if (
        Object.keys(value.artifact).some(
          (key) => !["uri", "kind", "summary"].includes(key),
        )
      )
        throw new SwarmValidationError(
          "Artifacts contain references and summaries only.",
        );
      assertNonEmptyString(value.artifact.uri, "artifact.uri");
      assertNonEmptyString(value.artifact.summary, "artifact.summary");
      if (
        !["plan", "decision", "review", "reconciliation", "report"].includes(
          String(value.artifact.kind),
        )
      )
        throw new SwarmValidationError("Invalid artifact kind.");
      break;
    case "task.dispatched":
    case "task.execution":
      assertNonEmptyString(value.taskId, `${location}.taskId`);
      plain(value.execution, location);
      assertNonEmptyString(value.execution.executionId, "executionId");
      for (const key of [
        "delegationId",
        "sessionId",
        "transcriptRef",
        "model",
        "reasoningEffort",
      ])
        optionalText(value.execution, key, location);
      if (value.execution.usage !== undefined)
        validateUsage(value.execution.usage, location);
      if (value.execution.usageByModel !== undefined) {
        if (!Array.isArray(value.execution.usageByModel))
          throw new SwarmValidationError("usageByModel must be an array.");
        for (const entry of value.execution.usageByModel) {
          plain(entry, location);
          optionalText(entry, "model", location);
          validateUsage(entry.usage, location);
        }
      }
      if (
        value.execution.kind !== undefined &&
        value.execution.kind !== "dispatch" &&
        value.execution.kind !== "turn"
      )
        throw new SwarmValidationError("Invalid execution kind.");
      break;
    case "task.added":
      validateTask(value.task, `${location}.task`);
      break;
    case "task.started":
      assertNonEmptyString(value.taskId, `${location}.taskId`);
      optionalText(value, "delegationId", location);
      break;
    case "task.completed":
      assertNonEmptyString(value.taskId, `${location}.taskId`);
      optionalJson(value, "result", location);
      optionalTextArray(value, "changeRefs", location);
      break;
    case "task.failed":
      assertNonEmptyString(value.taskId, `${location}.taskId`);
      if (legacy) json(value.error, `${location}.error`);
      else assertNonEmptyString(value.error, `${location}.error`);
      optionalTextArray(value, "changeRefs", location);
      if (value.failureOrigin !== undefined && value.failureOrigin !== "runtime" && value.failureOrigin !== "agent")
        throw new SwarmValidationError("Invalid failure origin.");
      if (value.failureCode !== undefined && (value.failureCode !== "SESSION_BUSY" || value.failureOrigin !== "runtime"))
        throw new SwarmValidationError("Invalid runtime failure code.");
      break;
    case "task.cancelled":
      assertNonEmptyString(value.taskId, `${location}.taskId`);
      optionalJson(value, "error", location);
      optionalTextArray(value, "changeRefs", location);
      break;
    default:
      throw eventError(index, `Unknown event type "${String(value.type)}".`);
  }
  return JSON.parse(JSON.stringify(value)) as SwarmRunEvent;
}
function isOwnedTaskEvent(value: unknown): boolean {
  if (
    !value ||
    typeof value !== "object" ||
    !("type" in value) ||
    value.type !== "task.added" ||
    !("task" in value)
  )
    return false;
  const task = value.task;
  return (
    !!task &&
    typeof task === "object" &&
    "ownerSessionId" in task &&
    typeof task.ownerSessionId === "string"
  );
}
function validateUsage(value: unknown, location: string): void {
  plain(value, location);
  for (const key of ["inputTokens", "outputTokens", "cachedInputTokens"])
    if (
      value[key] !== undefined &&
      (!Number.isSafeInteger(value[key]) || (value[key] as number) < 0)
    )
      throw new SwarmValidationError(
        "Usage must contain nonnegative integer counters.",
      );
  if (
    value.reportedCost !== undefined &&
    (typeof value.reportedCost !== "number" ||
      !Number.isFinite(value.reportedCost) ||
      value.reportedCost < 0)
  )
    throw new SwarmValidationError(
      "Reported cost must be finite and nonnegative.",
    );
}
function requireTask(
  tasks: Map<string, SwarmTask>,
  id: string,
  index: number,
): SwarmTask {
  const task = tasks.get(id);
  if (!task) throw eventError(index, `Unknown task "${id}".`);
  return task;
}
export function validateSwarmRoleModels(value: unknown): asserts value is SwarmRoleModels {
  plain(value, "roleModels");
  const roles = Object.keys(value);
  if (!roles.length) throw new SwarmValidationError("roleModels must specify at least one role.");
  for (const role of roles) {
    if (!["planner", "worker", "reconciler", "reviewer"].includes(role))
      throw new SwarmValidationError(`Unknown roleModels role "${role}".`);
    const selection = value[role];
    plain(selection, `roleModels.${role}`);
    if (Object.keys(selection).some((key) => key !== "model" && key !== "reasoningEffort"))
      throw new SwarmValidationError(`Unknown roleModels.${role} field.`);
    assertNonEmptyString(selection.model, `roleModels.${role}.model`);
    optionalText(selection, "reasoningEffort", `roleModels.${role}`);
  }
}
function assertNotTerminal(
  state: SwarmRunState,
  index: number,
  type: string,
): void {
  if (state === "completed" || state === "failed")
    throw eventError(index, `${type} may not follow a terminal run state.`);
}
function validateTask(value: unknown, location: string): void {
  plain(value, location);
  assertNonEmptyString(value.taskId, `${location}.taskId`);
  optionalText(value, "parentTaskId", location);
  optionalTextArray(value, "dependencyTaskIds", location);
  optionalText(value, "idempotencyKey", location);
  optionalText(value, "ownerSessionId", location);
  optionalText(value, "ownerPrincipalId", location);
  if (
    !["planner", "worker", "reconciler", "reviewer"].includes(
      String(value.role),
    )
  )
    throw new SwarmValidationError(`${location}.role is invalid.`);
  assertNonEmptyString(value.objective, `${location}.objective`);
  assertNonEmptyString(value.scope, `${location}.scope`);
}
function validatePause(value: unknown, location: string): void {
  plain(value, location);
  if (value.kind === "manual")
    assertNonEmptyString(value.message, `${location}.message`);
  else if (value.kind === "environmental") {
    if (value.operation !== "worktree.create" || value.attempts !== 3)
      throw new SwarmValidationError(`${location} is invalid.`);
    assertNonEmptyString(value.taskId, `${location}.taskId`);
    assertNonEmptyString(value.message, `${location}.message`);
    optionalText(value, "code", location);
    optionalText(value, "category", location);
  } else throw new SwarmValidationError(`${location}.kind is invalid.`);
}
function optionalJson(
  value: Record<string, unknown>,
  key: string,
  location: string,
): void {
  if (key in value) json(value[key], `${location}.${key}`);
}
function optionalText(
  value: Record<string, unknown>,
  key: string,
  location: string,
): void {
  if (key in value) assertNonEmptyString(value[key], `${location}.${key}`);
}
function optionalTextArray(
  value: Record<string, unknown>,
  key: string,
  location: string,
): void {
  if (!(key in value)) return;
  if (!Array.isArray(value[key]))
    throw new SwarmValidationError(`${location}.${key} must be an array.`);
  value[key].forEach((item, index) =>
    assertNonEmptyString(item, `${location}.${key}[${index}]`),
  );
}
function json(
  value: unknown,
  location: string,
  seen = new WeakSet<object>(),
): asserts value is SwarmJsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return;
  if (typeof value !== "object" || seen.has(value))
    throw new SwarmValidationError(
      `${location} must contain only acyclic JSON values.`,
    );
  seen.add(value);
  if (Array.isArray(value))
    value.forEach((item, i) => json(item, `${location}[${i}]`, seen));
  else {
    plain(value, location);
    Object.entries(value).forEach(([key, item]) =>
      json(item, `${location}.${key}`, seen),
    );
  }
  seen.delete(value);
}
function plain(
  value: unknown,
  location: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new SwarmValidationError(`${location} must be an object.`);
}
function assertNonEmptyString(
  value: unknown,
  location: string,
): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new SwarmValidationError(`${location} must be a non-empty string.`);
}
function eventError(index: number, message: string): SwarmValidationError {
  return new SwarmValidationError(`Event ${index + 1}: ${message}`);
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
