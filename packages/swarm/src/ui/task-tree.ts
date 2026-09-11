import type { SwarmRunState, SwarmTask } from "../contracts.js";

/** Bound text before normalization: objectives may contain entire dispatch prompts. */
export function taskPurpose(objective: string): string {
  const firstLine = objective.slice(0, 512).trim().split(/[\r\n]/, 1)[0] ?? "";
  const plain = firstLine.replace(/^\s*[#>*\-]+\s*/, "").replace(/\s+/g, " ").trim();
  if (!plain) return "Purpose not recorded";
  return plain.length > 96 ? `${plain.slice(0, 93).trimEnd()}…` : plain;
}

export function taskSession(task: SwarmTask): string | undefined {
  for (let index = (task.executions?.length ?? 0) - 1; index >= 0; index--) {
    const session = task.executions[index]?.sessionId;
    if (session) return session;
  }
  return undefined;
}

export function taskStatus(task: SwarmTask, runState: SwarmRunState): string {
  return task.state === "running" && runState === "paused" ? "paused" : task.state;
}

export interface TaskTreeRow {
  readonly task: SwarmTask;
  readonly depth: number;
  readonly detached: boolean;
}

/** Stable preorder, without recursion; missing parents and cycles remain inspectable. */
export function taskTree(tasks: readonly SwarmTask[]): TaskTreeRow[] {
  const byId = new Map(tasks.map((task) => [task.taskId, task]));
  const children = new Map<string, SwarmTask[]>();
  const roots: SwarmTask[] = [];
  for (const task of byId.values()) {
    if (!task.parentTaskId || !byId.has(task.parentTaskId)) roots.push(task);
    else {
      const siblings = children.get(task.parentTaskId) ?? [];
      siblings.push(task);
      children.set(task.parentTaskId, siblings);
    }
  }
  const rows: TaskTreeRow[] = [];
  const seen = new Set<string>();
  const visit = (root: SwarmTask, detached: boolean) => {
    const stack: TaskTreeRow[] = [{ task: root, depth: 0, detached }];
    while (stack.length) {
      const row = stack.pop()!;
      if (seen.has(row.task.taskId)) continue;
      seen.add(row.task.taskId);
      rows.push(row);
      const next = children.get(row.task.taskId) ?? [];
      for (let i = next.length - 1; i >= 0; i--) {
        stack.push({ task: next[i]!, depth: row.depth + 1, detached: false });
      }
    }
  };
  roots.forEach((root) => visit(root, Boolean(root.parentTaskId)));
  for (const task of byId.values()) if (!seen.has(task.taskId)) visit(task, true);
  return rows;
}
