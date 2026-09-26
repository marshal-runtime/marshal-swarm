import {
  SWARM_TASK_ROLES,
  type SwarmJsonValue,
  type SwarmRoleDefinition,
  type SwarmRun,
  type SwarmTaskDefinition,
  type SwarmTaskRole,
} from "./contract-types.js";
import { resultValueProblems } from "./result-schema.js";
export const SWARM_RESULT_CHARACTER_LIMIT = 16_384;
type RoleCarrier = Pick<SwarmTaskDefinition, "role" | "definedRole">;
/** The role name agents and people see: the run-defined name when present. */
export function taskRoleLabel(task: RoleCarrier): string {
  return task.definedRole ?? task.role;
}
/** The run-defined role a task was launched as, when it has one. */
export function taskRoleDefinition(
  run: Pick<SwarmRun, "roles">,
  task: RoleCarrier,
): SwarmRoleDefinition | undefined {
  return task.definedRole === undefined
    ? undefined
    : run.roles?.find((definition) => definition.name === task.definedRole);
}
/** Maps a launch role name to its built-in base role and optional run-defined name. */
export function resolveLaunchRole(run: Pick<SwarmRun, "roles">, value: unknown): RoleCarrier {
  const name = typeof value === "string" ? value.trim() : "";
  if ((SWARM_TASK_ROLES as readonly string[]).includes(name))
    return { role: name as SwarmTaskRole };
  const definition = run.roles?.find((entry) => entry.name === name);
  if (definition) return { role: definition.base, definedRole: definition.name };
  const defined = (run.roles ?? []).map((entry) => entry.name);
  throw new TypeError(
    `role must be ${SWARM_TASK_ROLES.join(", ")}` +
      (defined.length ? `, or a run-defined role (${defined.join(", ")}).` : "."),
  );
}
/** Names of existing roles whose base an update would change. */
export function roleBaseChanges(
  current: readonly SwarmRoleDefinition[] | undefined,
  updates: readonly SwarmRoleDefinition[],
): string[] {
  return updates
    .filter((update) => {
      const existing = current?.find((definition) => definition.name === update.name);
      return existing !== undefined && existing.base !== update.base;
    })
    .map((update) => update.name);
}
/** Replaces same-name definitions and appends new ones; existing names are never removed. */
export function mergeRoleDefinitions(
  current: readonly SwarmRoleDefinition[] | undefined,
  updates: readonly SwarmRoleDefinition[],
): readonly SwarmRoleDefinition[] {
  const replaced = (current ?? []).map(
    (definition) => updates.find((update) => update.name === definition.name) ?? definition,
  );
  return [
    ...replaced,
    ...updates.filter((update) => !replaced.some((definition) => definition.name === update.name)),
  ];
}
/** Lists why a completion's result or commits do not fit the task's role. */
export function completionProblems(
  definition: SwarmRoleDefinition | undefined,
  result: unknown,
  commits: readonly string[],
): string[] {
  if (!definition)
    return result === undefined ? [] : ["Only a run-defined role may complete with a result."];
  const problems =
    definition.base === "reviewer" && commits.length
      ? [`Role "${definition.name}" is read-only (base reviewer) and cannot complete with commits.`]
      : definition.workspaceMode === "shared" && commits.length
        ? [`Role "${definition.name}" runs in a shared checkout and cannot complete with commits.`]
        : [];
  if (result === undefined)
    return definition.resultSchema === undefined
      ? problems
      : [...problems, `Role "${definition.name}" must complete with a result that matches its resultSchema.`];
  const size = JSON.stringify(result)?.length ?? 0;
  if (size > SWARM_RESULT_CHARACTER_LIMIT)
    problems.push(
      `result has ${size} characters; the limit is ${SWARM_RESULT_CHARACTER_LIMIT}. Put long findings in your published artifact file.`,
    );
  return definition.resultSchema === undefined
    ? problems
    : [...problems, ...resultValueProblems(result, definition.resultSchema)];
}
/** Delegation launch fields a task adds: its role's workspace, prompt override and tools, and its attachments. */
export function taskLaunchProfile(
  definition: SwarmRoleDefinition | undefined,
  task: Pick<SwarmTaskDefinition, "role" | "attachments">,
): Readonly<Record<string, SwarmJsonValue>> {
  return {
    workspaceMode: definition?.workspaceMode ?? (task.role === "planner" ? "shared" : "isolated"),
    ...(definition?.systemPrompt === undefined ? {} : { systemPrompt: definition.systemPrompt }),
    ...(definition?.tools === undefined ? {} : { tools: [...definition.tools] }),
    ...(task.attachments === undefined ? {} : { attachments: [...task.attachments] }),
  };
}
/** Adds a host integration warning to a completion result without discarding either. */
export function withIntegrationWarning(
  result: SwarmJsonValue | undefined,
  integrationWarning: string | undefined,
): SwarmJsonValue | undefined {
  if (integrationWarning === undefined) return result;
  if (result === undefined) return { integrationWarning };
  return result !== null && typeof result === "object" && !Array.isArray(result)
    ? { ...result, integrationWarning }
    : { result, integrationWarning };
}
