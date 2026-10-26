import { createHash } from "node:crypto";
import { swarmRunTargets, type SwarmPromptReceipt, type SwarmRun } from "./contracts.js";
import { childAttentionSignature, type ExecutableTask, type ChildResult } from "./executor-tasks.js";
import type { SwarmSharedContext } from "./services.js";
import { taskRoleDefinition } from "./role-definitions.js";

const RESULT_PREVIEW_LIMIT = 2_000;
const OUTCOME_SECTION_LIMIT = 12_000;
const GUIDE_INLINE_LIMIT = 8_000;

export function promptReceiptFor(
  ready: ExecutableTask,
  guide: SwarmSharedContext,
  run: SwarmRun,
): SwarmPromptReceipt {
  return {
    attention: childAttentionSignature(ready),
    context: hash([ready.task.objective, ready.task.role, ready.task.definedRole,
      run.objective, run.roles, swarmRunTargets(run)]),
    guides: taskRoleDefinition(run, ready.task)?.systemPrompt !== undefined ? {} :
      Object.fromEntries([guide, ...(guide.topics ?? [])].map((entry) =>
        [entry.path, hash(entry.content)])),
    children: Object.fromEntries(ready.childResults.map((child) => [child.taskId, hash(child)])),
  };
}

export function changedChildResults(
  ready: ExecutableTask,
  receipt: SwarmPromptReceipt,
  fresh: boolean,
): readonly ChildResult[] {
  return ready.childResults.filter((child) =>
    fresh || ready.task.promptReceipt?.children[child.taskId] !== receipt.children[child.taskId]);
}

/** Results stay authoritative in nodes.get; previews never pretend to be full results. */
export function childOutcomeSection(children: readonly ChildResult[], run: SwarmRun,
  ready: ExecutableTask): string[] {
  if (children.length === 0) return [];
  const lines: string[] = [];
  let size = 0;
  for (const child of children) {
    const canonical = run.tasks.find((task) => task.parentTaskId === ready.task.taskId &&
      (task.taskId === `${ready.task.taskId}/${encodeURIComponent(child.taskId)}` ||
        task.taskId === child.taskId));
    const identity = { taskId: canonical?.taskId ?? `${ready.task.taskId}/${encodeURIComponent(child.taskId)}`,
      role: child.role, state: child.state, resumeCount: child.resumeCount };
    const payload = JSON.stringify({ reason: child.reason, result: child.result, error: child.error,
      changeRefs: child.changeRefs ?? [], artifacts: canonical?.artifactRefs ?? [] });
    const preview = payload.length <= RESULT_PREVIEW_LIMIT
      ? { ...identity, ...JSON.parse(payload) }
      : { ...identity, preview: payload.slice(0, RESULT_PREVIEW_LIMIT), truncated: true };
    const line = JSON.stringify(preview);
    if (size + line.length > OUTCOME_SECTION_LIMIT) break;
    lines.push(line);
    size += line.length + 1;
  }
  return ["## New or changed direct child outcomes", "",
    'Bounded previews. Before accepting, integrating, reviewing, or repairing a child, fetch its full result and artifact references through swarm.nodes.get({runId,taskId,view:"result"}) using the canonical taskId below. Older outcomes remain in the conversation and node store.',
    ...lines,
    ...(lines.length === children.length ? [] : [
      `${children.length - lines.length} additional changed outcomes omitted by the message budget; inspect direct children through swarm.nodes.list({runId,parentTaskId:"${ready.task.taskId}",view:"summary",offset:0,limit:50}) before deciding next actions. If a page contains 50 entries, increase offset by 50 until a shorter page is returned.`,
    ]), ""];
}

export function guideUpdateSection(guide: SwarmSharedContext, receipt: SwarmPromptReceipt,
  previous: SwarmPromptReceipt | undefined, fresh: boolean): string[] {
  const entries = [guide, ...(guide.topics ?? [])];
  let inlineRemaining = GUIDE_INLINE_LIMIT;
  const lines = entries.flatMap((entry) => {
    if (!fresh && previous?.guides[entry.path] === receipt.guides[entry.path]) return [];
    const inline = entry.content.length <= inlineRemaining;
    if (inline) inlineRemaining -= entry.content.length;
    return [`- Path: ${entry.path} (revision ${receipt.guides[entry.path]})`,
      ...(inline ? ["--- FIELD GUIDE START ---", entry.content, "--- FIELD GUIDE END ---"] : [
        "Read this file in full before acting; its contents exceed the inline budget. It contains the current binding decisions.",
      ]), ""];
  });
  const removed = Object.keys(previous?.guides ?? {}).filter((path) => !(path in receipt.guides));
  if (!lines.length && !removed.length) return [];
  return ["## Shared Field Guide updates", "", ...lines,
    ...removed.map((path) => `- Removed Field Guide topic: ${path}`),
    "Only the planner ownership rules permit editing Field Guide files.", ""];
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value) ?? "null").digest("hex");
}
