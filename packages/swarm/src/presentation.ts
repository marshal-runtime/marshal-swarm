import type { UiApplicationManifest } from '@marshal/runtime/ui';
import type { DeclarativeUiDocument, UiActionBinding, UiNode } from '@marshal/runtime/ui/declarative';
import type { SwarmJsonValue, SwarmRun, SwarmTask } from './contracts.js';

export const SWARM_RUN_VIEW_EXTENSION_ID = 'marshal.swarm';
export const SWARM_RUN_VIEW_RENDER_ID = 'swarm.run.view';
export const SWARM_RUN_VIEW_RESOURCE_URI = 'ui://marshal/swarm/run';

const MAX_TEXT = 240;
const MAX_FILES = 10;
const MAX_NODES = 500;
const MAX_ACTIONS = 100;
const MAX_DEPTH = 20;
const MAX_ID = 48;
const MAX_DOCUMENT_BYTES = 260_000;
const TRUNCATION_NOTICE = 'Some presentation details were truncated to fit the viewer limits.';

export interface SwarmRunPresentationTaskContext {
  readonly taskId: string;
  readonly agentSessionId?: string;
  readonly agentModel?: string;
  readonly agentReasoningEffort?: string;
  readonly changedFiles?: readonly string[];
}

export interface SwarmRunPresentationContext {
  readonly taskContexts?: readonly SwarmRunPresentationTaskContext[];
}

export interface SwarmRunPresentation {
  readonly extensionId: typeof SWARM_RUN_VIEW_EXTENSION_ID;
  readonly renderId: typeof SWARM_RUN_VIEW_RENDER_ID;
  readonly resourceUri: typeof SWARM_RUN_VIEW_RESOURCE_URI;
  readonly application: UiApplicationManifest;
  readonly compact: DeclarativeUiDocument;
  readonly detail: DeclarativeUiDocument;
}

const application: UiApplicationManifest = {
  version: '1.0.0',
  presentationModes: ['inline', 'pip'],
  authoritativeState: { capability: 'swarm.runs.get', resourceId: SWARM_RUN_VIEW_RESOURCE_URI, version: '1.0.0' },
  tools: [],
  actions: [
    action('swarm-runs-pause', 'swarm.runs.pause', 'Pause run', 'write', ['runId', 'reason']),
    action('swarm-runs-resume', 'swarm.runs.resume', 'Resume run', 'write'),
    action('marshal-swarm-open-session', 'marshal.swarm.open-session', 'Open agent session', 'external-effect'),
  ],
};

function action(
  id: string,
  capability: string,
  title: string,
  risk: 'write' | 'external-effect',
  required?: readonly string[],
) {
  return {
    id,
    version: '1.0.0',
    title,
    target: { kind: 'capability' as const, capability },
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string', minLength: 1 },
        reason: { type: 'string', minLength: 1 },
        taskId: { type: 'string' },
        agentSessionId: { type: 'string' },
      },
      additionalProperties: false,
      ...(required ? { required } : {}),
    },
    outputSchema: { type: 'object', additionalProperties: true },
    allowedScopes: ['session', 'project', 'workspace'] as const,
    requiredPermissions: [],
    risk,
    idempotency: risk === 'write' ? 'supported' as const : 'none' as const,
  };
}

export function projectSwarmRunPresentation(
  run: SwarmRun,
  context: SwarmRunPresentationContext = {},
): SwarmRunPresentation {
  const taskContexts = new Map((context.taskContexts ?? []).map((item) => [item.taskId, item]));
  return {
    extensionId: SWARM_RUN_VIEW_EXTENSION_ID,
    renderId: SWARM_RUN_VIEW_RENDER_ID,
    resourceUri: SWARM_RUN_VIEW_RESOURCE_URI,
    application,
    compact: compactDocument(run),
    detail: detailDocument(run, taskContexts),
  };
}

function compactDocument(run: SwarmRun): DeclarativeUiDocument {
  const ids = new IdAllocator();
  const actions: UiActionBinding[] = [];
  const children: UiNode[] = [
    node('heading', ids.id('title'), bounded(run.objective), { level: 2 }),
    node('badge', ids.id('state'), bounded(run.state), { tone: stateTone(run.state) }),
    node('text', ids.id('scope'), `Scope: ${bounded(run.scope)}`, { tone: 'muted' }),
  ];
  if (run.workerModel || run.workerReasoningEffort) {
    children.push(node('text', ids.id('worker-config'),
      `Worker: ${bounded(run.workerModel ?? 'unspecified')} / ${bounded(run.workerReasoningEffort ?? 'unspecified')}`, { tone: 'muted' }));
  }
  addRunValues(children, run, ids);
  addRunControl(children, actions, ids, run);
  return fitDocument(document(`Swarm run ${bounded(run.runId)}`, { type: 'card', id: ids.id('compact'), title: 'Swarm run', children }, actions), ids);
}

function detailDocument(run: SwarmRun, contexts: ReadonlyMap<string, SwarmRunPresentationTaskContext>): DeclarativeUiDocument {
  const ids = new IdAllocator();
  const budget = new Budget();
  const actions: UiActionBinding[] = [];
  const children: UiNode[] = [
    node('heading', ids.id('title'), bounded(run.objective), { level: 1 }),
    node('badge', ids.id('state'), bounded(run.state), { tone: stateTone(run.state) }),
    node('text', ids.id('run-id'), `Run: ${bounded(run.runId)}`, { tone: 'muted' }),
    node('text', ids.id('scope'), `Scope: ${bounded(run.scope)}`, { tone: 'muted' }),
  ];
  if (run.workerModel || run.workerReasoningEffort) {
    children.push(node('text', ids.id('worker-config'),
      `Worker model: ${bounded(run.workerModel ?? 'unspecified')}; effort: ${bounded(run.workerReasoningEffort ?? 'unspecified')}`, { tone: 'muted' }));
  }
  addRunValues(children, run, ids);
  // Keep controls in the detail document as well as the compact card.
  addRunControl(children, actions, ids, run);
  const tree = taskTree(run.tasks, contexts, ids, actions, budget);
  children.push(tree);
  if (run.tasks.length === 0) {
    children.push(node('text', ids.id('empty-tasks'), 'No tasks recorded for this run.', { tone: 'muted' }));
  }
  if (budget.malformed) {
    children.push(node('text', ids.id('invalid-task-links'),
      'Some task parent links were invalid; affected tasks are shown at the run root.', { tone: 'warning' }));
  }
  if (budget.unvisited.length > 0) {
    const malformedChildren = budget.unvisited.map((task) =>
      node('text', ids.id(`unlinked-${task.taskId}`),
        `Unlinked task ${displayShort(task.taskId, 'Unnamed task')}: ${displayShort(task.objective, 'No displayable text')}`,
        { tone: 'warning' }));
    children.push(node('stack', ids.id('unlinked-tasks'), '', {
      gap: 'small',
      title: 'Malformed or unlinked tasks',
      children: malformedChildren,
    }));
  }
  if (budget.truncated) {
    children.push(node('text', ids.id('tasks-truncated'),
      TRUNCATION_NOTICE, { tone: 'warning' }));
  }
  return fitDocument(document(`Swarm run ${bounded(run.runId)}`, { type: 'stack', id: ids.id('detail'), children },
    actions, 'Authoritative Swarm run state'), ids);
}

function addRunValues(children: UiNode[], run: SwarmRun, ids: IdAllocator): void {
  if (run.pauseReason) children.push(node('text', ids.id('pause-reason'), `Paused: ${bounded(run.pauseReason.message)}`, { tone: 'warning' }));
  if (run.error !== undefined) children.push(node('text', ids.id('error'), `Error: ${json(run.error)}`, { tone: 'danger' }));
  if (run.result !== undefined) children.push(node('text', ids.id('result'), `Result: ${json(run.result)}`, { tone: 'success' }));
}

function addRunControl(children: UiNode[], actions: UiActionBinding[], ids: IdAllocator, run: SwarmRun): void {
  if (run.state !== 'running' && run.state !== 'paused') return;
  const pause = run.state === 'running';
  const id = ids.id(pause ? 'pause' : 'resume');
  const operation = pause ? 'swarm.runs.pause' : 'swarm.runs.resume';
  actions.push({ id, operation, input: { runId: run.runId } });
  children.push(node('button', id, pause ? 'Pause' : 'Resume', {
    label: pause ? 'Pause' : 'Resume', actionId: id, variant: pause ? 'danger' : 'primary',
  }));
}

function taskTree(
  tasks: readonly SwarmTask[],
  contexts: ReadonlyMap<string, SwarmRunPresentationTaskContext>,
  ids: IdAllocator,
  actions: UiActionBinding[],
  budget: Budget,
): UiNode {
  const byParent = new Map<string | undefined, SwarmTask[]>();
  const taskIds = new Set(tasks.map((task) => task.taskId));
  for (const task of tasks) {
    if (task.parentTaskId !== undefined &&
      (task.parentTaskId === task.taskId || !taskIds.has(task.parentTaskId))) {
      budget.malformed = true;
    }
    const parent = task.parentTaskId && task.parentTaskId !== task.taskId && taskIds.has(task.parentTaskId)
      ? task.parentTaskId : undefined;
    const list = byParent.get(parent) ?? [];
    list.push(task);
    byParent.set(parent, list);
  }
  budget.nodes += 1;
  const root = node('stack', ids.id('tasks-root'), '', { gap: 'small', children: [] }) as UiNode & { children: UiNode[] };
  const visited = new Set<string>();
  const walk = (parent: string | undefined, target: UiNode & { children: UiNode[] }, depth: number, ancestry: Set<string>): void => {
    for (const task of byParent.get(parent) ?? []) {
      if (budget.nodes >= MAX_NODES - 20) { budget.truncated = true; break; }
      if (ancestry.has(task.taskId) || depth + 2 >= MAX_DEPTH) {
        budget.truncated = true;
        continue;
      }
      budget.seenTasks++;
      visited.add(task.taskId);
      const card = taskNode(task, contexts.get(task.taskId), ids, actions, budget);
      target.children.push(card);
      const nested = card as UiNode & { children?: UiNode[] };
      if (nested.children) {
        const childStack = nested.children.find((item) => item.type === 'stack') as (UiNode & { children: UiNode[] }) | undefined;
        if (childStack) walk(task.taskId, childStack, depth + 1, new Set(ancestry).add(task.taskId));
      }
    }
  };
  walk(undefined, root, 1, new Set());
  budget.unvisited = tasks.filter((task) => !visited.has(task.taskId));
  return root;
}

function taskNode(
  task: SwarmTask,
  context: SwarmRunPresentationTaskContext | undefined,
  ids: IdAllocator,
  actions: UiActionBinding[],
  budget: Budget,
): UiNode {
  const children: UiNode[] = [
    node('badge', ids.id(`task-${task.taskId}-state`), `${display(task.role, 'Unnamed task')}: ${display(task.state, 'Unknown state')}`, { tone: stateTone(task.state) }),
    node('text', ids.id(`task-${task.taskId}-objective`), display(task.objective, 'No displayable text')),
    node('text', ids.id(`task-${task.taskId}-scope`), `Scope: ${display(task.scope, 'Unspecified')}`, { tone: 'muted' }),
  ];
  if (context?.agentModel || context?.agentReasoningEffort) {
    children.push(node('text', ids.id(`task-${task.taskId}-agent`),
      `Agent: ${display(context.agentModel ?? 'unspecified', 'unspecified')} / ${display(context.agentReasoningEffort ?? 'unspecified', 'unspecified')}`, { tone: 'muted' }));
  }
  if (context?.agentSessionId && actions.length < MAX_ACTIONS) {
    const id = ids.id(`task-${task.taskId}-open-session`);
    actions.push({ id, operation: 'marshal.swarm.open-session', input: {
      taskId: task.taskId, agentSessionId: context.agentSessionId,
    } });
    children.push(node('button', id, 'Open session', { label: 'Open session', actionId: id, variant: 'secondary' }));
  } else if (context?.agentSessionId) budget.truncated = true;
  if (context?.changedFiles?.length) {
    const files = context.changedFiles.slice(0, MAX_FILES).map((file) => bounded(file));
    const suffix = context.changedFiles.length > MAX_FILES ? ' (more files truncated)' : '';
    children.push(node('text', ids.id(`task-${task.taskId}-files`), `Changed files: ${files.join(', ')}${suffix}`, { tone: 'muted' }));
  }
  if (task.result !== undefined) children.push(node('text', ids.id(`task-${task.taskId}-result`), `Result: ${json(task.result)}`, { tone: 'success' }));
  if (task.error !== undefined) children.push(node('text', ids.id(`task-${task.taskId}-error`), `Error: ${json(task.error)}`, { tone: 'danger' }));
  if (task.changeRefs?.length) children.push(node('text', ids.id(`task-${task.taskId}-refs`),
    bounded(`Change refs: ${task.changeRefs.map((ref) => bounded(ref)).join(', ')}`), { tone: 'muted' }));
  children.push(node('stack', ids.id(`task-${task.taskId}-children`), '', { gap: 'small', children: [] }));
  const card = node('card', ids.id(`task-${task.taskId}`), '', { title: bounded(task.taskId), children });
  budget.nodes += 1 + children.length;
  return card;
}

function node(type: string, id: string, text: string, extra: Record<string, unknown> = {}): UiNode {
  const visibleText = display(text, 'No displayable text');
  const textBearing = type === 'heading' || type === 'text' || type === 'badge';
  return { type, id, ...(textBearing ? { text: visibleText } : {}), ...extra } as UiNode;
}

function document(title: string, root: UiNode, actions: UiActionBinding[], description?: string): DeclarativeUiDocument {
  return { protocolVersion: '1.0.0', title: display(title, 'Swarm run'), ...(description ? { description } : {}), root, actions: actions.slice(0, MAX_ACTIONS) };
}

class IdAllocator {
  private readonly used = new Set<string>();
  id(raw: string): string {
    const base = (raw.replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'node').slice(0, MAX_ID);
    let candidate = base;
    let suffix = 2;
    while (this.used.has(candidate)) {
      const tail = `-${suffix++}`;
      candidate = `${base.slice(0, MAX_ID - tail.length)}${tail}`;
    }
    this.used.add(candidate);
    return candidate;
  }
}

class Budget {
  nodes = 0;
  seenTasks = 0;
  truncated = false;
  malformed = false;
  unvisited: SwarmTask[] = [];
}

function bounded(value: string): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, ' ');
  return normalized.length <= MAX_TEXT ? normalized : `${normalized.slice(0, MAX_TEXT - 14)}... [truncated]`;
}

function display(value: string, fallback: string): string {
  const result = bounded(value).trim();
  return result || fallback;
}

function displayShort(value: string, fallback: string): string {
  const result = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return result ? (result.length <= 96 ? result : `${result.slice(0, 82)}... [truncated]`) : fallback;
}

function fitDocument(doc: DeclarativeUiDocument, ids: IdAllocator): DeclarativeUiDocument {
  if (utf8Bytes(doc) <= MAX_DOCUMENT_BYTES) return doc;
  const root = cloneNode(doc.root);
  const actions = [...(doc.actions ?? [])];
  const warning = node('text', ids.id('document-truncated'), TRUNCATION_NOTICE, { tone: 'warning' });
  const rootContainer = root as UiNode & { children?: UiNode[] };
  if (rootContainer.children) rootContainer.children.push(warning);
  while (utf8Bytes({ ...doc, root, actions }) > MAX_DOCUMENT_BYTES && actions.length > 0) {
    const removed = actions.pop();
    if (removed) removeActionNodes(root, removed.id);
  }
  while (utf8Bytes({ ...doc, root, actions }) > MAX_DOCUMENT_BYTES && removeLastBranch(root)) {
  }
  while (utf8Bytes({ ...doc, root, actions }) > MAX_DOCUMENT_BYTES) {
    const container = root as UiNode & { children?: UiNode[] };
    if (!container.children?.length || !removeLastBranch(root)) break;
  }
  return { ...doc, root, actions: actions.slice(0, MAX_ACTIONS) };
}

function cloneNode(value: UiNode): UiNode {
  return JSON.parse(JSON.stringify(value)) as UiNode;
}

function removeLastBranch(value: UiNode): boolean {
  const container = value as UiNode & { children?: UiNode[] };
  if (!container.children?.length) return false;
  for (let index = container.children.length - 1; index >= 0; index--) {
    const child = container.children[index];
    const childId = (child as UiNode & { id?: string }).id;
    if (childId === 'unlinked-tasks' || childId === 'document-truncated') continue;
    if (removeLastBranch(child)) return true;
    container.children.splice(index, 1);
    return true;
  }
  return false;
}

function removeActionNodes(value: UiNode, actionId: string): void {
  const container = value as UiNode & { children?: UiNode[] };
  if (!container.children) return;
  container.children = container.children.filter((child) => {
    const candidate = child as UiNode & { actionId?: string };
    return candidate.actionId !== actionId;
  });
  for (const child of container.children) removeActionNodes(child, actionId);
}

function utf8Bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function json(value: SwarmJsonValue): string {
  return bounded(typeof value === 'string' ? value : JSON.stringify(value));
}

function stateTone(state: string): 'default' | 'muted' | 'success' | 'warning' | 'danger' | 'info' {
  if (state === 'done') return 'success';
  if (state === 'failed') return 'danger';
  if (state === 'paused') return 'warning';
  if (state === 'pending') return 'muted';
  return 'info';
}
