import { swarmRunTargets, type SwarmRun, type SwarmTask, type SwarmTaskRole } from "./contracts.js";
import type { SwarmBaseline, SwarmSharedContext } from "./services.js";
import {
  type ExecutableTask,
  type OutstandingChild,
  isTerminalTask,
  parentLocalTaskId,
} from "./executor-tasks.js";
import { requiredString } from "./executor-values.js";
import { taskRoleDefinition, taskRoleLabel } from "./role-definitions.js";
import {
  definedRoleContract,
  definedRoleHeader,
  plannerDefinedRolesSection,
} from "./role-definition-prompts.js";
export function promptFor(
  ready: ExecutableTask,
  fieldGuide: SwarmSharedContext,
  run: SwarmRun,
  baseline?: SwarmBaseline,
): string {
  const task = ready.task;
  const definition = taskRoleDefinition(run, task);
  const childOutcomes = ready.childResults.map((child) => ({
    state: child.state,
    ...(child.reason === undefined ? {} : { reason: child.reason }),
    taskId: child.taskId,
    role: child.role,
    ...(child.result === undefined ? {} : { result: child.result }),
    ...(child.error === undefined ? {} : { error: child.error }),
    changeRefs: child.changeRefs ?? [],
  }));
  const fieldGuidePath = requiredString(fieldGuide.path, "Field Guide path");
  if (typeof fieldGuide.content !== "string") {
    throw new TypeError("Field Guide content must be a string.");
  }
  const nodePosition = task.parentTaskId === undefined ? "root" : "descendant";
  const turnPhase = childOutcomes.length === 0 ? "initial" : "resumed with direct child outcomes";
  const scopeTarget = swarmRunTargets(run).find((target) => target.scope === task.scope);
  const targetRef = scopeTarget?.ref ?? run.targetRef ?? "not recorded";
  const targetHead = scopeTarget?.head ?? run.targetHead ?? "not recorded";
  return [
    "# Current swarm task",
    "",
    `- Node: ${nodePosition}`,
    `- Turn: ${turnPhase}`,
    `- Role: ${definition ? definedRoleHeader(definition) : task.role}`,
    `- Repository scope: ${task.scope}`,
    `- Original target ref: ${targetRef}`,
    `- Original target head: ${targetHead}`,
    `- Latest integration baseline ref: ${baseline?.ref ?? "not resolved"}`,
    `- Latest integration baseline head: ${baseline?.head ?? "not resolved"}`,
    `- Baseline ref: ${baseline?.ref ?? "not resolved"}`,
    `- Baseline head: ${baseline?.head ?? "not resolved"}`,
    `- Scope target ref: ${targetRef}`,
    `- Scope target head: ${targetHead}`,
    "",
    ...(task.parentTaskId === undefined
      ? []
      : [
          "## Overall swarm goal (context only)",
          "",
          run.objective,
          "",
          "This supplies the original constraints and acceptance context; it does not authorize work outside this task or its repository scope.",
          "",
        ]),
    "## Objective",
    "",
    task.objective,
    "",
    "## Direct child outcomes",
    "",
    JSON.stringify(childOutcomes),
    "",
    ...siblingRosterSection(task, run),
    ...outstandingSection(ready.outstanding),
    "## Shared Field Guide",
    "",
    `- Absolute path: ${fieldGuidePath}`,
    "",
    "--- FIELD GUIDE START ---",
    fieldGuide.content,
    "--- FIELD GUIDE END ---",
    "",
    ...topicSections(fieldGuide),
    "Read the Field Guide for concise durable design decisions and surprising repository facts.",
    "Only the planner ownership rules below permit editing any Field Guide file.",
    "",
    ...(task.role === "planner" ? plannerDefinedRolesSection(run) : []),
    "## Role contract",
    "",
    ...(definition ? definedRoleContract(definition) : roleInstructions(task)),
    "",
    "## Response interface",
    "",
    "Use the TypeScript runtime capabilities swarm.nodes.list/get/launch/publishArtifact/block/fail/complete/continue/resume for all task lifecycle changes.",
    'These are broker capability names, not an ambient swarm object or separate native tools. Invoke them through runtimeInvoke({capability: "swarm.nodes.<operation>", input: {...}}). For runtimeExecuteTypeScript, use: export default async (input, context) => context.runtime.invoke("swarm.nodes.<operation>", input); Pass the capability arguments as the tool input. The second function argument is a context containing runtime; invoke takes the capability name and input as two positional arguments and returns the capability output directly.',
    'For discovery, use runtimeSearch({name: "swarm.nodes.<operation>"}) with the exact capability name. A failure in unrelated catalog search does not imply this capability is unavailable; direct invocation remains the supported path for known capabilities.',
    `Your durable identity is runId=${run.runId}, taskId=${task.taskId}.`,
    "Launch input: {runId,parentTaskId,taskId,role,objective,scope,dependencyTaskIds?,idempotencyKey}. taskId is parent-local. Only planners may launch children; child scope must be a declared repository." +
      (run.roles?.length && task.role === "planner" ? " role may also be a run-defined role name." : ""),
    "Before completing, publish an artifact reference through swarm.nodes.publishArtifact with {runId,taskId,artifact:{uri,kind,summary}}. Required artifact kinds: planner uses plan, decision, or report; reviewer uses review; reconciler uses reconciliation. Write a readable decision/action/rationale summary to that file; never publish hidden chain-of-thought. An inline artifact passed to swarm.nodes.complete does not publish a reference.",
    `Complete explicitly with ${definition ? "the input your Result section names" : "{runId,taskId,commits?:string[]}; code output is a simple commits list"}. If the task needs another conversation turn, request it before ending the current turn with swarm.nodes.continue {runId,taskId,reason}; this may be repeated without a fixed turn limit. Block or fail with {runId,taskId,reason}. Blocked work resumes only after explicit resume with a resolution reason.`,
    "Do not call swarm.nodes.continue to wait for children: the runtime automatically wakes this node when a direct child completes, fails, or blocks. continue is only for requesting another turn of your own work now, never for polling or waiting on outstanding children.",
    "Your final conversational response does not launch children or complete this task. Pending children start once dependencies complete. Inspect sibling ownership and publish shared decisions before dependent work.",
  ].join("\n");
}
export function siblingRosterSection(task: SwarmTask, run: SwarmRun): string[] {
  const parentTaskId = task.parentTaskId;
  if (parentTaskId === undefined) return [];
  const siblings = run.tasks.filter(
    (entry) =>
      entry.parentTaskId === parentTaskId && entry.taskId !== task.taskId && !isTerminalTask(entry),
  );
  if (siblings.length === 0) return [];
  const roster = siblings.map((sibling) => ({
    taskId: parentLocalTaskId(parentTaskId, sibling.taskId),
    role: taskRoleLabel(sibling),
    scope: sibling.scope,
    state: sibling.state,
    ...(sibling.reason === undefined ? {} : { reason: sibling.reason }),
  }));
  return [
    "## Sibling ownership",
    "",
    "These tasks share your parent. Do not decide or redefine a shared " +
      "interface or exported symbol another sibling owns; defer any shared " +
      "contract to your nearest common planner. Each entry is compact " +
      "(taskId, role, scope, state); fetch a sibling's full objective via " +
      "swarm.nodes.get({runId,taskId}) if you need it.",
    JSON.stringify(roster),
    "",
  ];
}
export function outstandingSection(outstanding: readonly OutstandingChild[]): string[] {
  if (outstanding.length === 0) return [];
  return [
    "## Outstanding children",
    "",
    "These direct children are still live. You may react to the outcomes above " +
      "and delegate more work, but you may not complete while any child remains " +
      "outstanding. Blocked children need your decision or resolution; inspect their reason and use swarm.nodes.resume only once it is resolved. " +
      "Each entry is compact (taskId, role, scope, state, reason); fetch a " +
      "child's full objective via swarm.nodes.get({runId,taskId}) if you need it.",
    JSON.stringify(outstanding),
    "",
  ];
}
export function topicSections(fieldGuide: SwarmSharedContext): string[] {
  const topics = fieldGuide.topics ?? [];
  return topics.flatMap((topic) => {
    const path = requiredString(topic.path, "Field Guide topic path");
    if (typeof topic.content !== "string") {
      throw new TypeError("Field Guide topic content must be a string.");
    }
    return [
      `--- FIELD GUIDE TOPIC: ${path} ---`,
      topic.content,
      "--- FIELD GUIDE TOPIC END ---",
      "",
    ];
  });
}
export const ROLE_INSTRUCTIONS: Readonly<Record<SwarmTaskRole, readonly string[]>> = {
  planner: [
    "Own material architecture and shared-contract decisions before delegating implementation; then delegate coherent outcomes without editing implementation files yourself.",
    "If substantial design remains unresolved, delegate it to a planner child that resolves the design and delegates its implementation; routine implementation choices remain with workers.",
    "An architectural designer is a planner: it must resolve architecture and delegate implementation, and may not terminate as a leaf.",
    "Choose boundaries by coherent outcomes and independent decision lanes, not by file count or a one-worker-per-file rule.",
    "Good delegation identifies independent outcomes promptly and may use parallel lanes; use the run-specific permitted scope names shown in the response interface rather than copying a scope literal from an example.",
    "For example, a planner may resolve the shared storage contract first, then delegate one worker to implement the cohesive library and extension against it.",
    "Normally assign each coherent implementation outcome to one worker, even when it spans related files, helpers, exports, and tests; do not split merely to create smaller leaves.",
    "When sibling subtrees genuinely share a TypeScript interface or exported symbol, decide that contract here at the nearest common planner, record it in your owned topic file, and assign one owner to land it before dependent work. A separate boundary-only worker is optional, not mandatory; a coherent implementation worker may own the boundary when that is the useful outcome. Never implement it yourself and never let two subtrees decide or redefine the same exported contract.",
    "Use planner children only when a material design or architecture decision remains unresolved or implementation lanes are genuinely independent.",
    "Do not perform exhaustive repository or node_modules inventories. Inspect only enough to define owned outcomes and concrete boundaries.",
    "Give children disjoint decision ownership, include every relevant Field Guide decision, user constraint, acceptance condition, repository identity/ref, and relative implementation paths in their objectives. Children edit only their assigned checkout; name external source paths as read-only references and keep each child within one repository scope. All delegated work, including repairs, uses swarm.nodes.launch with the appropriate planner, worker, reviewer, or reconciler role; native task, fleet, agent, or CLI spawning tools are not alternate Swarm delegation.",
    "For example, if an executable repair is needed, launch a worker child for that repair with its relative paths and acceptance conditions; the executor creates and tracks it.",
    "For executable outcomes, assign the original required end-to-end check to a coherent worker outcome and claim completion only when its acceptance is achieved; report any remaining limitation when blocked.",
    "A planner checkout may remain at an older revision than the latest integration baseline. Missing files there do not prove missing integration: inspect the supplied latest baseline ref/head and child-ref ancestry or containment before requesting reconciliation, reuse actual child verification for the same integrated ref, and repeat it only for relevant changes or missing coverage.",
    "Never merge sibling work. Use a neutral reconciler only when sibling refs genuinely need integration, a real conflict or missing integration must be resolved, or neutral resolution is otherwise needed; do not create one solely to re-cherry-pick a single usable patch.",
    "Request decorrelated read-only review lenses for an integrated subtree once its change ref has advanced, using judgment and risk rather than a mandatory cadence or fixed set of lenses.",
    "Triage review findings once; delegate only actionable repairs. Fold repairs into the next review of an advanced change ref rather than creating an automatic review or reconcile cycle for each repair.",
    "Report capacity, session, worktree, or tooling failures upward; do not answer them with replacement child fan-out.",
    "When a focused intentional core break is worthwhile, return the rationale for durable curation and delegate downstream repair leaves rather than preserving ossified behavior.",
  ],
  worker: [
    "Implement the coherent owned outcome, including its related files, helpers, exports, and tests; do not merge sibling work.",
    "Perform repository edits and Git operations in your assigned working directory/worktree. Translate original or canonical repository paths to equivalent paths there; explicit external source references may be read, but do not write to another checkout.",
    "For an executable outcome, run the smallest actual user-requested end-to-end check in the real host and report the command and result plainly; syntax checks or guessed/static outputs are not substitutes. Own ordinary failures within your scope by fixing and rerunning the same check; report only concrete blockers outside your ability or authority, and do not claim completion until the objective acceptance is achieved.",
    "When your objective names a shared interface or exported symbol owned by another task, import that named symbol; never redefine or re-export it. If it has not landed yet, return a plain blocker instead of inventing your own.",
    "When your objective is a boundary task, land exactly the exported TypeScript interface or symbol named in the objective so siblings can import it; do not implement unrelated behavior in the same task.",
    "A research objective returns ranked options, evidence, and a recommendation; it may also write a concise durable report artifact outside the Field Guide and return its short path or link. It must not introduce any new exported symbol or edit implementation files.",
    'Research is a worker role: use role "worker" with a research objective; do not invent a separate leaf role.',
    "Never edit the Field Guide. If a genuinely bloated or high-contention megafile blocks safe work, return its path and reason without adding more code to it.",
    "A focused intentional core break is allowed when the objective requires it. Return the rationale to the parent planner.",
    "Implement the owned outcome or report the concrete blocker that prevents it. The runtime carries your ordinary change reference separately.",
  ],
  reconciler: [
    "Act as a neutral integrator; do not favor any sibling implementation.",
    "Perform repository edits and Git operations in your assigned working directory/worktree. Translate original or canonical repository paths to equivalent paths there; explicit external source references may be read, but do not write to another checkout.",
    "Apply the sibling change refs named in the objective in this fresh worktree, resolve conflicts impartially, and commit one integrated result.",
    "When assigned as the root reconciler, apply only named implementation refs not already contained in the latest integration baseline shown above. If all named refs are contained and correct, return that existing ref without creating a new commit; otherwise commit the real integration.",
    "Never edit the Field Guide. Return any contradictory durable decisions to the parent planner.",
    "Return the integrated outcome or a plain blocker. The runtime carries your integrated change reference separately.",
  ],
  reviewer: [
    "Review only; do not edit the repository or Field Guide, merge, or repair.",
    'Inspect the integrated result through the distinct lens named in the objective and return {"reviewed":true,"findings":[...]} with concrete, actionable findings for the parent planner.',
    "Check the current Field Guide and original objective where relevant. Do not invent a score, quorum, approval record, or review ledger.",
  ],
};
export function roleInstructions(task: SwarmTask): readonly string[] {
  if (task.role !== "planner") return ROLE_INSTRUCTIONS[task.role];
  const guideOwnership =
    task.parentTaskId === undefined
      ? [
          "You are the only owner of field-guide/index.md. Keep it small: curate only durable global decisions, surprising facts, and links to explicitly assigned topic files.",
          "Own assembly of the whole product: arrange any needed neutral integration and read-only review of the assembled product when it is ready. This obligation does not impose a fixed topology, stage sequence, fan-out, or depth.",
        ]
      : [
          "Never edit field-guide/index.md. You may edit only one explicit topic file when its exact path and single-writer ownership are assigned in this objective; otherwise do not edit the Field Guide.",
        ];
  return [...guideOwnership, ...ROLE_INSTRUCTIONS.planner];
}
