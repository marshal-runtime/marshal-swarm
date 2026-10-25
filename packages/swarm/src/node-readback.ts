import type { SwarmRun, SwarmTask } from "./contracts.js";
import { roleInstructions } from "./executor-prompts.js";
import { definedRoleContract, plannerDefinedRolesSection } from "./role-definition-prompts.js";
import { taskRoleDefinition } from "./role-definitions.js";

export function nodeResultView(task: SwarmTask, run: SwarmRun) {
  const { executions: _executions, promptReceipt: _receipt,
    childAttentionSignature: _signature, ...details } = task;
  const definition = taskRoleDefinition(run, task);
  return { ...details, roleContract: definition ? definedRoleContract(definition) : roleInstructions(task),
    ...(task.role === "planner" ? { roleLaunchGuidance: plannerDefinedRolesSection(run) } : {}) };
}

export function nodeSummaryView(task: SwarmTask) {
  return { taskId: task.taskId, parentTaskId: task.parentTaskId, role: task.role,
    definedRole: task.definedRole, scope: task.scope, state: task.state,
    objectivePreview: task.objective.slice(0, 160), reasonPreview: task.reason?.slice(0, 400),
    hasResult: task.result !== undefined, hasError: task.error !== undefined,
    artifactCount: task.artifactRefs.length, childCount: task.childTaskIds.length };
}

export function nodeReadPage(input: Readonly<Record<string, unknown>>): { offset: number; limit: number } {
  const offset = input.offset ?? 0;
  const limit = input.limit ?? 50;
  if (!Number.isSafeInteger(offset) || Number(offset) < 0 || !Number.isSafeInteger(limit) ||
    Number(limit) < 1 || Number(limit) > 100)
    throw new TypeError("Node summary pages require offset >= 0 and limit between 1 and 100.");
  return { offset: Number(offset), limit: Number(limit) };
}
