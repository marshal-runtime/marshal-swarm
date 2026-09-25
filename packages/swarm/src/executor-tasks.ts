import { createHash } from "node:crypto";
import type { InvocationContext } from "@marshal/runtime";
import {
  swarmRunTargets,
  type SwarmJsonValue,
  type SwarmPauseReason,
  type SwarmRun,
  type SwarmRunTarget,
  type SwarmRunUpdateEvent,
  type SwarmTask,
  type SwarmTaskDefinition,
} from "./contracts.js";
import { parentIsLive } from "./failure-cascade.js";
import { taskRoleLabel } from "./role-definitions.js";
import { recordOf, requiredString, stringValue, errorText } from "./executor-values.js";
export const TERMINAL_RUN_STATES = new Set(["completed", "failed"]);
export interface ExecutableTask {
  readonly task: SwarmTask;
  readonly childResults: readonly ChildResult[];
  readonly outstanding: readonly OutstandingChild[];
}
export interface ChildResult {
  readonly state: SwarmTask["state"];
  readonly reason?: string;
  readonly resumeCount: number;
  readonly taskId: string;
  readonly role: string;
  readonly result?: SwarmJsonValue;
  readonly error?: SwarmJsonValue;
  readonly changeRefs?: readonly string[];
}
export interface OutstandingChild {
  readonly state: SwarmTask["state"];
  readonly reason?: string;
  readonly taskId: string;
  readonly role: string;
  readonly scope: string;
}
export interface ChildDelegation {
  readonly definition: SwarmTaskDefinition;
  readonly refusal?: string;
}
export interface AgentLaunch {
  readonly continuationHeld?: boolean;
  readonly ready: ExecutableTask;
  readonly delegationId?: string;
  readonly error?: string;
  readonly pauseReason?: SwarmPauseReason;
}
export interface ReservedTaskDispatch {
  readonly runId: string;
  readonly ready: ExecutableTask;
  readonly task: SwarmTask;
  readonly invocation: InvocationContext;
  readonly executionId: string;
  readonly launchInput: Readonly<Record<string, SwarmJsonValue>>;
  readonly startedAt: string;
  readonly roleModel?: {
    readonly model?: string;
    readonly reasoningEffort?: string;
  };
}
export interface AgentOutcome {
  readonly continuationHeld?: boolean;
  readonly ready: ExecutableTask;
  readonly result?: unknown;
  readonly changeRefs?: readonly string[];
  readonly error?: string;
}
export interface SettledTask {
  readonly taskId: string;
  readonly outcome: AgentOutcome;
}
export function launchFailure(
  ready: ExecutableTask,
  delegation: Readonly<Record<string, unknown>> | undefined,
  operationError: unknown,
  action: "start" | "continue",
): AgentLaunch {
  return {
    ready,
    error: errorText(
      delegation?.error ?? operationError,
      `Delegation did not ${action} task "${ready.task.taskId}".`,
    ),
  };
}
export function executableSwarmTasks(run: SwarmRun): readonly ExecutableTask[] {
  if (run.state !== "running") return [];
  const childrenByParent = new Map<string, SwarmTask[]>();
  for (const task of run.tasks) {
    if (task.parentTaskId === undefined) continue;
    const children = childrenByParent.get(task.parentTaskId) ?? [];
    children.push(task);
    childrenByParent.set(task.parentTaskId, children);
  }
  return run.tasks.flatMap((task): ExecutableTask[] => {
    const children = childrenByParent.get(task.taskId) ?? [];
    if (task.state === "pending") {
      if (!parentIsLive(run, task)) return [];
      return (task.dependencyTaskIds ?? []).every(
        (id) => run.tasks.find((t) => t.taskId === id)?.state === "completed",
      )
        ? [{ task, childResults: [], outstanding: [] }]
        : [];
    }
    if (task.state !== "running" || task.delegationId === undefined) return [];
    if (children.length === 0) {
      return [{ task, childResults: [], outstanding: [] }];
    }
    // A blocker requires parent attention but remains live for completion and dependencies.
    const outcomes = children.filter((child) => isTerminalTask(child) || child.state === "blocked");
    if (outcomes.length === 0 && !task.resumeReason) return [];
    return [
      {
        task,
        childResults: outcomes.map((child) => ({
          state: child.state,
          reason: child.reason,
          // The same reason after a resume is a new notification.
          resumeCount: child.resumeCount ?? 0,
          taskId: parentLocalTaskId(task.taskId, child.taskId),
          role: taskRoleLabel(child),
          ...(child.result === undefined ? {} : { result: child.result }),
          ...(child.error === undefined ? {} : { error: child.error }),
          ...(child.changeRefs === undefined ? {} : { changeRefs: child.changeRefs }),
        })),
        outstanding: children
          .filter((child) => !isTerminalTask(child))
          .map((child) => ({
            state: child.state,
            reason: child.reason,
            taskId: parentLocalTaskId(task.taskId, child.taskId),
            role: taskRoleLabel(child),
            scope: child.scope,
          })),
      },
    ];
  });
}
export function childAttentionSignature(ready: ExecutableTask): string {
  return createHash("sha256").update(JSON.stringify(ready.childResults)).digest("hex");
}
export function isTerminalTask(task: SwarmTask): boolean {
  return task.state === "completed" || task.state === "failed";
}
export function permittedScopeNames(run: SwarmRun, task: SwarmTask): readonly string[] {
  const targets = declaredTargetScopes(run);
  return [...(targets ?? new Set([task.scope]))];
}
export function declaredTargetScopes(run: SwarmRun): Set<string> | undefined {
  const targets = swarmRunTargets(run);
  if (targets.length === 0) return undefined;
  return new Set(targets.map((target) => target.scope));
}
export function normalizeTargets(value: unknown): readonly SwarmRunTarget[] {
  if (!Array.isArray(value)) {
    throw new TypeError("targets must be an array.");
  }
  return value.map(
    (entry, index): SwarmRunTarget => ({
      scope: requiredString(recordOf(entry)?.scope, `targets[${index}].scope`),
      ref: requiredString(recordOf(entry)?.ref, `targets[${index}].ref`),
      head: requiredString(recordOf(entry)?.head, `targets[${index}].head`),
    }),
  );
}
export function assertResumableScopes(run: SwarmRun): void {
  const scopes = declaredTargetScopes(run);
  if (scopes === undefined) return;
  for (const task of run.tasks) {
    if (!scopes.has(task.scope)) {
      throw new TypeError(
        `Run "${run.runId}" cannot resume: task "${task.taskId}" scope ` +
          `"${task.scope}" is not one of the declared repository targets.`,
      );
    }
  }
}
export function parentLocalTaskId(parentTaskId: string, taskId: string): string {
  const prefix = `${parentTaskId}/`;
  if (!taskId.startsWith(prefix)) return taskId;
  return decodeURIComponent(taskId.slice(prefix.length));
}
export function executionReceipt(
  task: SwarmTask,
  value: Readonly<Record<string, unknown>>,
): SwarmRunUpdateEvent | undefined {
  const receiptId = stringValue(value.executionId);
  const matched = receiptId ? task.executions.find((e) => e.executionId === receiptId) : undefined;
  if (task.state === "completed" && receiptId && !matched) return undefined;
  const previous =
    matched ?? task.executions.filter((e) => e.delegationId === task.delegationId).at(-1);
  if (!previous) return undefined;
  const usage = recordOf(value.usage);
  return {
    type: "task.execution",
    taskId: task.taskId,
    execution: {
      ...previous,
      executionId: receiptId ?? previous.executionId,
      kind: "turn",
      ...(receiptId && receiptId !== previous.executionId
        ? {
            usage: undefined,
            usageByModel: undefined,
            startedAt: new Date().toISOString(),
          }
        : {}),
      completedAt: new Date().toISOString(),
      ...(stringValue(value.transcriptRef)
        ? { transcriptRef: stringValue(value.transcriptRef) }
        : {}),
      ...(stringValue(value.model) ? { model: stringValue(value.model) } : {}),
      ...(stringValue(value.reasoningEffort)
        ? { reasoningEffort: stringValue(value.reasoningEffort) }
        : {}),
      ...(Array.isArray(value.usageByModel)
        ? {
            usageByModel: value.usageByModel.map((raw) => {
              const entry = recordOf(raw);
              const measured = recordOf(entry?.usage);
              if (!measured) throw new Error("Invalid model usage receipt.");
              return {
                ...(stringValue(entry?.model) ? { model: stringValue(entry?.model) } : {}),
                usage: {
                  ...(typeof measured.inputTokens === "number"
                    ? { inputTokens: measured.inputTokens }
                    : {}),
                  ...(typeof measured.outputTokens === "number"
                    ? { outputTokens: measured.outputTokens }
                    : {}),
                  ...(typeof measured.cachedInputTokens === "number"
                    ? { cachedInputTokens: measured.cachedInputTokens }
                    : {}),
                  ...(typeof measured.costUsd === "number"
                    ? { reportedCost: measured.costUsd }
                    : {}),
                },
              };
            }),
          }
        : {}),
      ...(usage
        ? {
            usage: {
              ...(typeof usage.inputTokens === "number" ? { inputTokens: usage.inputTokens } : {}),
              ...(typeof usage.outputTokens === "number"
                ? { outputTokens: usage.outputTokens }
                : {}),
              ...(typeof usage.cachedInputTokens === "number"
                ? { cachedInputTokens: usage.cachedInputTokens }
                : {}),
              ...(typeof usage.costUsd === "number" ? { reportedCost: usage.costUsd } : {}),
            },
          }
        : {}),
    },
  };
}
