import type { SwarmDefinedRoleBase, SwarmRoleDefinition, SwarmRun } from "./contract-types.js";
import { SWARM_RESULT_CHARACTER_LIMIT } from "./role-definitions.js";
const BASE_RULES: Readonly<Record<SwarmDefinedRoleBase, readonly string[]>> = {
  worker: [
    "Perform repository edits and Git operations only in your assigned working directory/worktree; you may read explicit external source references, but do not write to another checkout.",
    "Never edit the Field Guide. Return durable decisions and blockers to the parent planner.",
  ],
  reviewer: [
    "Stay read-only: do not commit, merge, repair, or edit the Field Guide. To inspect or run a change ref named in your objective, check it out inside your own worktree with git checkout --detach <ref>.",
    "Write output files outside the repository checkout, at the paths your instructions name, so your worktree stays clean.",
  ],
};
const SHARED_WORKSPACE_RULE =
  "You run in a shared checkout: do not edit repository files, commit, or run Git commands that change it.";
/** Role contract lines for a task launched as a run-defined role. */
export function definedRoleContract(definition: SwarmRoleDefinition): readonly string[] {
  const [workspaceRule, ...baseRules] = BASE_RULES[definition.base];
  return [
    `You are the run-defined role "${definition.name}" (base ${definition.base}). The agent that launched this swarm wrote the instructions below for this run; follow them over generic ${definition.base} guidance.`,
    definition.workspaceMode === "shared" ? SHARED_WORKSPACE_RULE : workspaceRule,
    ...baseRules,
    "",
    "### Instructions",
    "",
    definition.instructions,
    "",
    "### Result",
    "",
    ...resultContract(definition),
  ];
}
/** The launch-role label shown in a defined-role task's header. */
export function definedRoleHeader(definition: SwarmRoleDefinition): string {
  return `${definition.name} (run-defined; base ${definition.base})`;
}
/** The planner prompt section that lists the run-defined roles it may launch. */
export function plannerDefinedRolesSection(run: Pick<SwarmRun, "roles">): string[] {
  const roles = run.roles ?? [];
  if (roles.length === 0) return [];
  return [
    "## Run-defined roles",
    "",
    "The agent that launched this swarm defined these roles. Launch one with swarm.nodes.launch and its name as role. Each runs on its own model with its own instructions, and its result appears in your direct child outcomes. A reviewer-based role is read-only and produces no commits, so name the exact change ref it must inspect in its objective.",
    "",
    ...roles.flatMap((role) => [
      `### ${role.name}`,
      "",
      `- Base: ${role.base}; model: ${role.model}${role.reasoningEffort ? `; effort: ${role.reasoningEffort}` : ""}`,
      `- When to use: ${role.whenToUse}`,
      ...(role.plannerGuidance ? [`- How to use: ${role.plannerGuidance}`] : []),
      ...sessionLines(role),
      ...(role.resultSchema === undefined
        ? []
        : [`- Result schema: ${JSON.stringify(role.resultSchema)}`]),
      "",
    ]),
  ];
}
function sessionLines(role: SwarmRoleDefinition): string[] {
  const parts = [
    ...(role.systemPrompt === undefined
      ? []
      : ["its own system prompt; its task message holds only the objective, so put every input in the objective or attachments"]),
    ...(role.tools === undefined ? [] : [`tools ${role.tools.join(", ")}`]),
    ...(role.workspaceMode === undefined ? [] : [`${role.workspaceMode} workspace`]),
  ];
  return parts.length ? [`- Session: ${parts.join("; ")}`] : [];
}
function resultContract(definition: SwarmRoleDefinition): string[] {
  const commits = definition.base === "worker" && definition.workspaceMode !== "shared" ? ",commits?" : "";
  const artifact =
    definition.base === "reviewer"
      ? ["Before completing, publish your findings file with swarm.nodes.publishArtifact as kind review."]
      : [];
  if (definition.resultSchema === undefined)
    return [
      `Complete with swarm.nodes.complete {runId,taskId${commits},result?}. result is optional JSON under ${SWARM_RESULT_CHARACTER_LIMIT} characters; your parent planner reads it in its direct child outcomes.`,
      ...artifact,
    ];
  return [
    `Complete with swarm.nodes.complete {runId,taskId${commits},result}. result must match this JSON Schema and stay under ${SWARM_RESULT_CHARACTER_LIMIT} characters:`,
    JSON.stringify(definition.resultSchema),
    "The executor rejects a result that does not match and says why; fix it and call complete again. Your parent planner reads result in its direct child outcomes.",
    ...artifact,
  ];
}
