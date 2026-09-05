import type { SwarmRun, SwarmTask } from '../contracts.js';

export const SWARM_RUN_VIEW_TEST_ID = 'swarm-run-view';

export interface SwarmRunViewProps {
  readonly run: SwarmRun;
  readonly compact: boolean;
  readonly onPause: (runId: string) => void;
  readonly onResume: (runId: string) => void;
}

/** Renders a swarm run card or the agent tree panel. */
export function SwarmRunView({
  run,
  compact,
  onPause,
  onResume,
}: SwarmRunViewProps) {
  const roots = run.tasks.filter((task) => task.parentTaskId === undefined);
  return (
    <div className="grid gap-3" data-testid={SWARM_RUN_VIEW_TEST_ID} data-compact={compact ? 'true' : 'false'}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-medium">{run.objective}</h2>
        <span className="text-xs text-muted-foreground">{run.state}</span>
      </div>
      <p className="text-xs text-muted-foreground">Scope: {run.scope}</p>
      {run.pauseReason ? (
        <p className="text-sm text-muted-foreground">Paused: {run.pauseReason.message}</p>
      ) : null}
      {run.error !== undefined ? (
        <p className="text-sm text-destructive">{displayJson(run.error)}</p>
      ) : null}
      {run.state === 'running' || run.state === 'paused' ? (
        <button
          type="button"
          className="justify-start text-sm"
          onClick={() => (run.state === 'running' ? onPause(run.runId) : onResume(run.runId))}
        >
          {run.state === 'running' ? 'Pause' : 'Resume'}
        </button>
      ) : null}
      {compact ? null : (
        <div className="grid gap-2">
          {roots.length === 0 ? (
            <p className="text-xs text-muted-foreground">No tasks recorded for this run.</p>
          ) : (
            roots.map((task) => (
              <TaskNode key={task.taskId} task={task} tasks={run.tasks} />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function TaskNode({
  task,
  tasks,
}: {
  readonly task: SwarmTask;
  readonly tasks: readonly SwarmTask[];
}) {
  const children = tasks.filter((candidate) => candidate.parentTaskId === task.taskId);
  return (
    <div className="grid gap-2 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">{task.role}</span>
        <span className="text-xs">{task.state}</span>
      </div>
      <p className="text-sm">{task.objective}</p>
      <p className="text-xs text-muted-foreground">Scope: {task.scope}</p>
      {children.map((child) => (
        <TaskNode key={child.taskId} task={child} tasks={tasks} />
      ))}
    </div>
  );
}

function displayJson(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}
