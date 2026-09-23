import type { SwarmJsonValue, SwarmRoleModels, SwarmRunEvent } from "./contract-types.js";
import { assertSwarmRunId } from "./contracts.js";
export class SwarmValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SwarmValidationError";
  }
}
export function validateSwarmRunEvent(value: unknown, index = 0, legacy = false): SwarmRunEvent {
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
          throw new SwarmValidationError(`${location}.targets must be a non-empty array.`);
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
      if (
        value.classification !== "owner-session-busy-transport" &&
        value.classification !== "owner-session-superseded-transport"
      )
        throw new SwarmValidationError(
          "Recovery requires an explicit supported owner-session transport classification.",
        );
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
    case "task.continuationRequested":
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
      if (Object.keys(value.artifact).some((key) => !["uri", "kind", "summary"].includes(key)))
        throw new SwarmValidationError("Artifacts contain references and summaries only.");
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
      for (const key of ["delegationId", "sessionId", "transcriptRef", "model", "reasoningEffort"])
        optionalText(value.execution, key, location);
      if (value.execution.usage !== undefined) validateUsage(value.execution.usage, location);
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
      if (
        value.failureOrigin !== undefined &&
        value.failureOrigin !== "runtime" &&
        value.failureOrigin !== "agent"
      )
        throw new SwarmValidationError("Invalid failure origin.");
      if (
        value.failureCode !== undefined &&
        (value.failureCode !== "SESSION_BUSY" || value.failureOrigin !== "runtime")
      )
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
export function isOwnedTaskEvent(value: unknown): boolean {
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
export function validateUsage(value: unknown, location: string): void {
  plain(value, location);
  for (const key of ["inputTokens", "outputTokens", "cachedInputTokens"])
    if (
      value[key] !== undefined &&
      (!Number.isSafeInteger(value[key]) || (value[key] as number) < 0)
    )
      throw new SwarmValidationError("Usage must contain nonnegative integer counters.");
  if (
    value.reportedCost !== undefined &&
    (typeof value.reportedCost !== "number" ||
      !Number.isFinite(value.reportedCost) ||
      value.reportedCost < 0)
  )
    throw new SwarmValidationError("Reported cost must be finite and nonnegative.");
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
export function validateTask(value: unknown, location: string): void {
  plain(value, location);
  assertNonEmptyString(value.taskId, `${location}.taskId`);
  optionalText(value, "parentTaskId", location);
  optionalTextArray(value, "dependencyTaskIds", location);
  optionalText(value, "idempotencyKey", location);
  optionalText(value, "ownerSessionId", location);
  optionalText(value, "ownerPrincipalId", location);
  if (!["planner", "worker", "reconciler", "reviewer"].includes(String(value.role)))
    throw new SwarmValidationError(`${location}.role is invalid.`);
  assertNonEmptyString(value.objective, `${location}.objective`);
  assertNonEmptyString(value.scope, `${location}.scope`);
}
export function validatePause(value: unknown, location: string): void {
  plain(value, location);
  if (value.kind === "manual") assertNonEmptyString(value.message, `${location}.message`);
  else if (value.kind === "environmental") {
    if (value.operation !== "worktree.create" || value.attempts !== 3)
      throw new SwarmValidationError(`${location} is invalid.`);
    assertNonEmptyString(value.taskId, `${location}.taskId`);
    assertNonEmptyString(value.message, `${location}.message`);
    optionalText(value, "code", location);
    optionalText(value, "category", location);
  } else throw new SwarmValidationError(`${location}.kind is invalid.`);
}
export function optionalJson(value: Record<string, unknown>, key: string, location: string): void {
  if (key in value) json(value[key], `${location}.${key}`);
}
export function optionalText(value: Record<string, unknown>, key: string, location: string): void {
  if (key in value) assertNonEmptyString(value[key], `${location}.${key}`);
}
export function optionalTextArray(value: Record<string, unknown>, key: string, location: string): void {
  if (!(key in value)) return;
  if (!Array.isArray(value[key]))
    throw new SwarmValidationError(`${location}.${key} must be an array.`);
  value[key].forEach((item, index) => assertNonEmptyString(item, `${location}.${key}[${index}]`));
}
export function json(
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
    throw new SwarmValidationError(`${location} must contain only acyclic JSON values.`);
  seen.add(value);
  if (Array.isArray(value)) value.forEach((item, i) => json(item, `${location}[${i}]`, seen));
  else {
    plain(value, location);
    Object.entries(value).forEach(([key, item]) => json(item, `${location}.${key}`, seen));
  }
  seen.delete(value);
}
export function plain(value: unknown, location: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new SwarmValidationError(`${location} must be an object.`);
}
export function assertNonEmptyString(value: unknown, location: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new SwarmValidationError(`${location} must be a non-empty string.`);
}
export function eventError(index: number, message: string): SwarmValidationError {
  return new SwarmValidationError(`Event ${index + 1}: ${message}`);
}
