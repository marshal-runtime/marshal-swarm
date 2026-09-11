import { useState } from "react";

import type { SwarmRun, SwarmTask } from "../contracts.js";
import type { SwarmRunOutcomeSummary } from "../outcome-summary.js";
import { summarizeUsage, type UsageMeasurement, type UsageSummary } from "./usage-summary.js";
import { taskPurpose, taskSession, taskStatus, taskTree } from "./task-tree.js";

export const SWARM_RUN_VIEW_TEST_ID = "swarm-run-view";
export interface SwarmRunViewProps {
  readonly run: SwarmRun;
  readonly compact: boolean;
  readonly onPause: (runId: string) => void;
  readonly onResume: (runId: string) => void;
  readonly onOpenFile?: (taskId: string, uri: string) => void;
  readonly onOpenSession?: (sessionId: string) => void;
}

export function SwarmRunView({ run, compact, onPause, onResume, onOpenFile, onOpenSession }: SwarmRunViewProps) {
  const [selectedId, setSelectedId] = useState<string>();
  const selected = run.tasks.find((task) => task.taskId === selectedId);
  return (
    <div className="swarm-tree-view grid gap-3" style={{ minWidth: 0 }} data-testid={SWARM_RUN_VIEW_TEST_ID} data-compact={String(compact)}>
      <style>{`
        .swarm-tree-view .swarm-node { width:100%; min-width:0; border:1px solid var(--border, #68778055); border-radius:9px; padding:10px 12px; text-align:left; background:transparent; color:inherit; cursor:pointer; }
        .swarm-tree-view .swarm-node:hover { background:#71877a12; }
        .swarm-tree-view button:focus-visible,.swarm-tree-view summary:focus-visible { outline:2px solid #73ac89; outline-offset:3px; }
        .swarm-tree-view .swarm-line { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .swarm-tree-view .swarm-dot { width:8px; height:8px; border-radius:50%; display:inline-block; flex:none; background:#92999e; }
        .swarm-tree-view .swarm-dot[data-state=running] { background:#96cbaa; animation:swarm-breathe 1.8s ease-in-out infinite; }
        .swarm-tree-view .swarm-dot[data-state=completed] { background:#287745; }
        .swarm-tree-view .swarm-dot[data-state=failed] { background:#d65d60; }
        .swarm-tree-view .swarm-dot[data-state=paused],.swarm-tree-view .swarm-dot[data-state=blocked] { background:#d4ad47; }
        .swarm-tree-view .swarm-branch { position:relative; padding-left:14px; padding-bottom:9px; border-left:1px solid var(--border, #68778066); }
        .swarm-tree-view .swarm-branch:before { position:absolute; content:""; width:14px; height:1px; background:var(--border, #68778066); top:24px; left:0; }
        .swarm-tree-view .swarm-artifact { display:inline-flex; flex-direction:column; justify-content:center; gap:3px; width:72px; height:60px; padding:6px; border-radius:7px; border:1px solid #8097b266; background:#8097b214; color:inherit; overflow:hidden; font-size:10px; text-align:left; }
        .swarm-tree-view .swarm-artifact:disabled { opacity:.6; }
        @keyframes swarm-breathe { 50% { opacity:.5; box-shadow:0 0 0 3px #96cbaa22; } }
        @media (prefers-reduced-motion:reduce) { .swarm-tree-view .swarm-dot[data-state=running] { animation:none; } }
      `}</style>
      <div className="rounded-md border border-border p-3" style={{ minWidth: 0 }}>
        <div className="flex items-center gap-2 text-xs"><Status state={run.state} /><strong>Swarm</strong><span className="text-muted-foreground">{run.tasks.length} agents</span></div>
        <h2 className="swarm-line mt-1 text-sm font-medium">{taskPurpose(run.objective)}</h2>
        <OutcomeSummary run={run} />
      </div>
      {run.legacyReadOnly && <p className="text-xs">Legacy run · Read-only history</p>}
      {!run.legacyReadOnly && (run.state === "running" || run.state === "paused") && (
        <button type="button" className="text-left text-xs" onClick={() => run.state === "running" ? onPause(run.runId) : onResume(run.runId)}>
          {run.state === "running" ? "Pause swarm" : "Resume swarm"}
        </button>
      )}
      <nav aria-label="Agent ownership tree" style={{ minWidth: 0 }}>
        <ol style={{ listStyle: "none", margin: 0, padding: "0 0 0 8px" }}>
          {taskTree(run.tasks).map(({ task, depth, detached }) => {
            const session = taskSession(task);
            const purpose = taskPurpose(task.objective);
            const state = taskStatus(task, run.state);
            return (
              <li key={task.taskId} className="swarm-branch" style={{ marginLeft: Math.min(depth, 4) * 12 }}>
                <button type="button" className="swarm-node" aria-current={selected?.taskId === task.taskId ? "true" : undefined}
                  aria-label={`${task.role}: ${purpose}. ${state}. ${session && onOpenSession ? "Open agent chat" : "Show agent details"}`}
                  onClick={() => { setSelectedId(task.taskId); if (session) onOpenSession?.(session); }}>
                  <span className="flex items-center gap-2 text-xs"><strong style={{ textTransform: "capitalize" }}>{task.role}</strong><Status state={state} /></span>
                  <span className="swarm-line mt-1 text-xs">{purpose}</span>
                  {(detached || depth > 4) && <span className="swarm-line mt-1 text-xs text-muted-foreground">{detached ? "Parent unavailable" : `Parent: ${taskPurpose(task.parentTaskId ?? "")}`}</span>}
                </button>
                {(task.artifactRefs ?? []).length > 0 && <div className="flex flex-wrap gap-2 pt-2" aria-label={`${task.role} output documents`}>
                  {task.artifactRefs.map((artifact) => <button key={artifact.uri} type="button" className="swarm-artifact" disabled={!onOpenFile}
                    aria-label={`Open ${artifact.kind}: ${taskPurpose(artifact.summary || artifact.uri)}`}
                    onClick={() => onOpenFile?.(task.taskId, artifact.uri)}>
                    <span aria-hidden="true" style={{ fontSize: 16 }}>▤</span><span className="swarm-line">{artifact.kind}</span>
                    <span className="swarm-line">{taskPurpose(artifact.uri.split(/[\\/]/).pop() ?? artifact.uri)}</span>
                  </button>)}
                </div>}
              </li>
            );
          })}
        </ol>
        {run.tasks.length === 0 && <p className="text-xs text-muted-foreground">Waiting for agents…</p>}
      </nav>
      {selected && <details key={selected.taskId} className="text-xs" style={{ overflowWrap: "anywhere", minWidth: 0 }}>
        <summary className="cursor-pointer">{selected.role} details · usage, executions, outputs</summary>
        <TaskDetails task={selected} tasks={run.tasks} onSelect={setSelectedId} onOpenFile={onOpenFile} />
      </details>}
      <details className="text-xs" style={{ overflowWrap: "anywhere", minWidth: 0 }}>
        <summary className="cursor-pointer">Run details · usage and diagnostics</summary>
        <p>Run: {run.runId} · Scope: {run.scope}</p>
        {run.pauseReason && <p>Blocked: {run.pauseReason.message}</p>}
        {run.error !== undefined && <p className="text-destructive">{displayJson(run.error)}</p>}
        <UsagePanel label="Run usage" summary={summarizeUsage(run.tasks.flatMap((task) => task.executions ?? []))} />
      </details>
    </div>
  );
}

/**
 * Read-time outcome readback: factual task-state counts and failed-task
 * identities from the projected run. States are execution facts — this line
 * never claims objective success; acceptance stays with the goal reviewer.
 * Older publishers may send runs without the derived block; render nothing then.
 */
function OutcomeSummary({ run }: { readonly run: SwarmRun }) {
  const outcome = (run as { readonly outcome?: SwarmRunOutcomeSummary }).outcome;
  if (!outcome) return null;
  const terminal = run.state === "completed" || run.state === "failed";
  if (!terminal && outcome.failedTasks.length === 0) return null;
  return (
    <div data-testid="swarm-outcome-summary">
      {terminal && outcome.headline && (
        <p className="swarm-line mt-1 text-xs" data-testid="swarm-outcome-headline">{outcome.headline}</p>
      )}
      {outcome.failedTasks.length > 0 && (
        <ul aria-label="Failed tasks" className="mt-1 text-xs" style={{ listStyle: "none", margin: 0, padding: 0 }} data-testid="swarm-outcome-failed">
          {outcome.failedTasks.map((failed) => (
            <li key={failed.taskId} className="swarm-line">
              Failed — {failed.role}: {failed.objective}{failed.reason ? ` (${failed.reason})` : ""}
            </li>
          ))}
          {(outcome.failedTasksOmitted ?? 0) > 0 && (
            <li className="swarm-line">…and {outcome.failedTasksOmitted} more failed task{outcome.failedTasksOmitted === 1 ? "" : "s"}.</li>
          )}
        </ul>
      )}
    </div>
  );
}

function Status({ state }: { state: string }) {
  return <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><span className="swarm-dot" data-state={state} aria-hidden="true" />{state}</span>;
}
function TaskDetails({
  task,
  tasks,
  onSelect,
  onOpenFile,
}: {
  task: SwarmTask;
  tasks: readonly SwarmTask[];
  onSelect: (id: string) => void;
  onOpenFile?: (taskId: string, uri: string) => void;
}) {
  const children = tasks
    .filter((candidate) => candidate.parentTaskId === task.taskId)
    .map((child) => child.taskId);
  const relationships = (label: string, ids: readonly string[]) => (
    <div className="text-xs">
      <span>{label}: </span>
      {ids.length
        ? ids.map((id) => (
            <button
              key={id}
              type="button"
              className="mr-2 underline"
              onClick={() => onSelect(id)}
              disabled={!tasks.some((candidate) => candidate.taskId === id)}
            >
              {id}
            </button>
          ))
        : "None"}
    </div>
  );
  return (
    <section
      aria-label={`Task ${task.taskId}`}
      className="grid gap-3 rounded-md border border-border p-3"
    >
      <h3 className="text-sm font-medium">
        {task.role}: {taskPurpose(task.objective)}
      </h3>
      <p className="text-xs">
        {task.taskId} · {task.state} · Scope: {task.scope}
      </p>
      {task.reason && <p className="text-sm">Reason: {task.reason}</p>}
      {task.error !== undefined && (
        <p className="text-sm text-destructive">{displayJson(task.error)}</p>
      )}
      {relationships("Parent", task.parentTaskId ? [task.parentTaskId] : [])}
      {relationships("Children", children)}
      {relationships("Dependencies", task.dependencyTaskIds ?? [])}
      <h4 className="text-xs font-medium">Output documents</h4>
      {(task.artifactRefs ?? []).length ? (
        task.artifactRefs.map((artifact) => (
          <div key={artifact.uri} className="text-xs">
            <button
              type="button"
              className="underline"
              disabled={!onOpenFile}
              onClick={() => onOpenFile?.(task.taskId, artifact.uri)}
            >
              {artifact.kind}: {artifact.uri}
            </button>
            <p>{artifact.summary}</p>
          </div>
        ))
      ) : (
        <p className="text-xs text-muted-foreground">No output documents yet.</p>
      )}
      <UsagePanel label="Node usage" summary={summarizeUsage(task.executions ?? [])} />
      <h4 className="text-xs font-medium">Executions</h4>
      {(task.executions ?? []).length ? (
        task.executions.map((execution) => (
          <div key={execution.executionId} className="grid gap-1 text-xs">
            <p>
              Model: {execution.model ?? "Not recorded"} · Reasoning:{" "}
              {execution.reasoningEffort ?? "Not recorded"}
            </p>
            <p>
              Input tokens: {execution.usage?.inputTokens ?? "Not recorded"} · Output tokens:{" "}
              {execution.usage?.outputTokens ?? "Not recorded"} · Cache tokens (subset of input):{" "}
              {execution.usage?.cachedInputTokens ?? "Not recorded"}
            </p>
            {execution.transcriptRef ? (
              <button
                type="button"
                className="text-left underline"
                disabled={!onOpenFile}
                onClick={() => onOpenFile?.(task.taskId, execution.transcriptRef!)}
              >
                Open transcript file: {execution.transcriptRef}
              </button>
            ) : (
              <p>Transcript file not recorded.</p>
            )}
          </div>
        ))
      ) : (
        <p className="text-xs text-muted-foreground">No executions recorded.</p>
      )}
      <h4 className="text-xs font-medium">Commits</h4>
      {(task.changeRefs ?? []).length ? (
        <ul className="text-xs">
          {task.changeRefs!.map((ref) => (
            <li key={ref}>{ref}</li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">No commits recorded.</p>
      )}
    </section>
  );
}
function displayJson(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function UsagePanel({ label, summary }: { label: string; summary: UsageSummary }) {
  if (summary.executions === 0) return null;
  return (
    <section aria-label={label} className="grid gap-1 text-xs">
      <h4 className="font-medium">
        {label} · {summary.executions} execution{summary.executions === 1 ? "" : "s"}
      </h4>
      <p>
        Input: {displayMeasurement(summary.inputTokens)} · Output:{" "}
        {displayMeasurement(summary.outputTokens)} · Cached input (subset of input):{" "}
        {displayMeasurement(summary.cachedInputTokens)}
      </p>
      <p>Reported cost (USD): {displayMeasurement(summary.reportedCost, true)}</p>
      {summary.byModel.map((row) => (
        <div key={row.model} className="text-muted-foreground">
          {row.model}: input {displayMeasurement(row.inputTokens)}, output{" "}
          {displayMeasurement(row.outputTokens)}, cached input{" "}
          {displayMeasurement(row.cachedInputTokens)}, reported USD{" "}
          {displayMeasurement(row.reportedCost, true)}
        </div>
      ))}
    </section>
  );
}
function displayMeasurement(value: UsageMeasurement, money = false): string {
  const recorded = money ? value.recorded.toFixed(4) : String(value.recorded);
  return value.complete ? recorded : `Unknown (${recorded} recorded)`;
}
