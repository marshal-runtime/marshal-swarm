export type SwarmJsonPrimitive = null | boolean | number | string;
export type SwarmJsonValue = SwarmJsonPrimitive | readonly SwarmJsonValue[] | { readonly [key: string]: SwarmJsonValue };
export type SwarmTaskState = 'pending' | 'running' | 'done' | 'failed';
export type SwarmRunState = Exclude<SwarmTaskState, 'pending'> | 'paused';
export type SwarmTaskRole = 'planner' | 'worker' | 'reconciler' | 'reviewer';
export type SwarmPauseReason =
  | { readonly kind: 'manual'; readonly message: string }
  | { readonly kind: 'environmental'; readonly operation: 'worktree.create'; readonly taskId: string; readonly attempts: 3; readonly message: string; readonly code?: string; readonly category?: string };

export interface SwarmTaskDefinition { readonly taskId: string; readonly parentTaskId?: string; readonly role: SwarmTaskRole; readonly objective: string; readonly scope: string; }
export interface SwarmRunTarget { readonly scope: string; readonly ref: string; readonly head: string; }
export interface SwarmRunCreateConfiguration { readonly workerModel?: string; readonly workerReasoningEffort?: string; }
export interface SwarmTask extends SwarmTaskDefinition { readonly state: SwarmTaskState; readonly delegationId?: string; readonly result?: SwarmJsonValue; readonly error?: SwarmJsonValue; readonly changeRefs?: readonly string[]; }
export type SwarmRunEvent =
  | { readonly type: 'run.created'; readonly runId: string; readonly objective: string; readonly scope: string; readonly targetRef?: string; readonly targetHead?: string; readonly targets?: readonly SwarmRunTarget[]; readonly workerModel?: string; readonly workerReasoningEffort?: string }
  | { readonly type: 'run.paused'; readonly reason: SwarmPauseReason } | { readonly type: 'run.resumed' }
  | { readonly type: 'run.completed'; readonly result?: SwarmJsonValue } | { readonly type: 'run.failed'; readonly error: SwarmJsonValue }
  | { readonly type: 'run.cancelled'; readonly error?: SwarmJsonValue } | { readonly type: 'task.added'; readonly task: SwarmTaskDefinition }
  | { readonly type: 'task.started'; readonly taskId: string; readonly delegationId?: string }
  | { readonly type: 'task.completed'; readonly taskId: string; readonly result?: SwarmJsonValue; readonly changeRefs?: readonly string[] }
  | { readonly type: 'task.failed'; readonly taskId: string; readonly error: SwarmJsonValue; readonly changeRefs?: readonly string[] }
  | { readonly type: 'task.cancelled'; readonly taskId: string; readonly error?: SwarmJsonValue; readonly changeRefs?: readonly string[] };
export type SwarmRunUpdateEvent = Exclude<SwarmRunEvent, { readonly type: 'run.created' }>;
export interface SwarmRun { readonly runId: string; readonly objective: string; readonly scope: string; readonly targetRef?: string; readonly targetHead?: string; readonly targets?: readonly SwarmRunTarget[]; readonly workerModel?: string; readonly workerReasoningEffort?: string; readonly state: SwarmRunState; readonly pauseReason?: SwarmPauseReason; readonly tasks: readonly SwarmTask[]; readonly result?: SwarmJsonValue; readonly error?: SwarmJsonValue; }

export class SwarmValidationError extends Error { constructor(message: string) { super(message); this.name = 'SwarmValidationError'; } }
export function assertSwarmRunId(value: unknown): asserts value is string { assertNonEmptyString(value, 'runId'); }
export function swarmIntegrationRef(runId: string, scope: string): string { assertSwarmRunId(runId); assertNonEmptyString(scope, 'scope'); return `refs/swarm/${slug(runId)}/integration/${slug(scope)}`; }
export function swarmRunTargets(run: SwarmRun): readonly SwarmRunTarget[] {
  return run.targets ?? (run.targetRef && run.targetHead ? Object.freeze([{ scope: run.scope, ref: run.targetRef, head: run.targetHead }]) : Object.freeze([]));
}
export function replaySwarmRun(events: readonly unknown[]): SwarmRun {
  if (!Array.isArray(events) || events.length === 0) throw new SwarmValidationError('A swarm run must contain a run.created event.');
  const first = validateSwarmRunEvent(events[0], 0); if (first.type !== 'run.created') throw eventError(0, 'The first event must be run.created.');
  const tasks = new Map<string, SwarmTask>(); let state: SwarmRunState = 'running'; let pauseReason: SwarmPauseReason | undefined; let result: SwarmJsonValue | undefined; let error: SwarmJsonValue | undefined;
  for (const [offset, raw] of events.slice(1).entries()) {
    const event = validateSwarmRunEvent(raw, offset + 1); if (event.type === 'run.created') throw eventError(offset + 1, 'run.created may appear only once.');
    switch (event.type) {
      case 'run.paused': assertNotTerminal(state, offset + 1, event.type); state = 'paused'; pauseReason = event.reason; break;
      case 'run.resumed': if (state === 'done') throw eventError(offset + 1, 'run.resumed may not follow a terminal run state.'); state = 'running'; pauseReason = undefined; result = undefined; error = undefined; break;
      case 'run.completed': assertNotTerminal(state, offset + 1, event.type); state = 'done'; pauseReason = undefined; result = event.result; error = undefined; break;
      case 'run.failed': assertNotTerminal(state, offset + 1, event.type); state = 'failed'; pauseReason = undefined; result = undefined; error = event.error; break;
      case 'run.cancelled': assertNotTerminal(state, offset + 1, event.type); state = 'failed'; pauseReason = undefined; result = undefined; error = event.error; break;
      case 'task.added': if (tasks.has(event.task.taskId)) throw eventError(offset + 1, `Task "${event.task.taskId}" already exists.`); tasks.set(event.task.taskId, { ...event.task, state: 'pending' }); break;
      case 'task.started': { const task = requireTask(tasks, event.taskId, offset + 1); tasks.set(event.taskId, { ...task, state: 'running', delegationId: event.delegationId, result: undefined, error: undefined, changeRefs: undefined }); break; }
      case 'task.completed': { const task = requireTask(tasks, event.taskId, offset + 1); tasks.set(event.taskId, { ...task, state: 'done', result: event.result, error: undefined, changeRefs: event.changeRefs }); break; }
      case 'task.failed': case 'task.cancelled': { const task = requireTask(tasks, event.taskId, offset + 1); tasks.set(event.taskId, { ...task, state: 'failed', result: undefined, error: event.error, changeRefs: event.changeRefs }); break; }
    }
  }
  return deepFreeze({ runId: first.runId, objective: first.objective, scope: first.scope, ...(first.targetRef === undefined ? {} : { targetRef: first.targetRef }), ...(first.targetHead === undefined ? {} : { targetHead: first.targetHead }), ...(first.targets === undefined ? {} : { targets: first.targets.map((target) => ({ ...target })) }), ...(first.workerModel === undefined ? {} : { workerModel: first.workerModel }), ...(first.workerReasoningEffort === undefined ? {} : { workerReasoningEffort: first.workerReasoningEffort }), state, ...(state === 'paused' && pauseReason ? { pauseReason } : {}), tasks: [...tasks.values()], ...(result === undefined ? {} : { result }), ...(error === undefined ? {} : { error }) });
}
export function validateSwarmRunEvent(value: unknown, index = 0): SwarmRunEvent {
  const location = `Event ${index + 1}`; plain(value, location);
  switch (value.type) {
    case 'run.created': assertSwarmRunId(value.runId); assertNonEmptyString(value.objective, `${location}.objective`); assertNonEmptyString(value.scope, `${location}.scope`); optionalText(value, 'targetRef', location); optionalText(value, 'targetHead', location); optionalText(value, 'workerModel', location); optionalText(value, 'workerReasoningEffort', location); if (value.targets !== undefined) { if (!Array.isArray(value.targets) || value.targets.length === 0) throw new SwarmValidationError(`${location}.targets must be a non-empty array.`); value.targets.forEach((target, i) => { plain(target, `${location}.targets[${i}]`); assertNonEmptyString(target.scope, `${location}.targets[${i}].scope`); assertNonEmptyString(target.ref, `${location}.targets[${i}].ref`); assertNonEmptyString(target.head, `${location}.targets[${i}].head`); }); } break;
    case 'run.paused': validatePause(value.reason, location); break; case 'run.resumed': break; case 'run.completed': optionalJson(value, 'result', location); break; case 'run.failed': json(value.error, `${location}.error`); break; case 'run.cancelled': optionalJson(value, 'error', location); break;
    case 'task.added': validateTask(value.task, `${location}.task`); break; case 'task.started': assertNonEmptyString(value.taskId, `${location}.taskId`); optionalText(value, 'delegationId', location); break; case 'task.completed': assertNonEmptyString(value.taskId, `${location}.taskId`); optionalJson(value, 'result', location); optionalTextArray(value, 'changeRefs', location); break; case 'task.failed': assertNonEmptyString(value.taskId, `${location}.taskId`); json(value.error, `${location}.error`); optionalTextArray(value, 'changeRefs', location); break; case 'task.cancelled': assertNonEmptyString(value.taskId, `${location}.taskId`); optionalJson(value, 'error', location); optionalTextArray(value, 'changeRefs', location); break; default: throw eventError(index, `Unknown event type "${String(value.type)}".`);
  }
  return JSON.parse(JSON.stringify(value)) as SwarmRunEvent;
}
function requireTask(tasks: Map<string, SwarmTask>, id: string, index: number): SwarmTask { const task = tasks.get(id); if (!task) throw eventError(index, `Unknown task "${id}".`); return task; }
function assertNotTerminal(state: SwarmRunState, index: number, type: string): void { if (state === 'done' || state === 'failed') throw eventError(index, `${type} may not follow a terminal run state.`); }
function validateTask(value: unknown, location: string): void { plain(value, location); assertNonEmptyString(value.taskId, `${location}.taskId`); optionalText(value, 'parentTaskId', location); if (!['planner', 'worker', 'reconciler', 'reviewer'].includes(String(value.role))) throw new SwarmValidationError(`${location}.role is invalid.`); assertNonEmptyString(value.objective, `${location}.objective`); assertNonEmptyString(value.scope, `${location}.scope`); }
function validatePause(value: unknown, location: string): void { plain(value, location); if (value.kind === 'manual') assertNonEmptyString(value.message, `${location}.message`); else if (value.kind === 'environmental') { if (value.operation !== 'worktree.create' || value.attempts !== 3) throw new SwarmValidationError(`${location} is invalid.`); assertNonEmptyString(value.taskId, `${location}.taskId`); assertNonEmptyString(value.message, `${location}.message`); optionalText(value, 'code', location); optionalText(value, 'category', location); } else throw new SwarmValidationError(`${location}.kind is invalid.`); }
function optionalJson(value: Record<string, unknown>, key: string, location: string): void { if (key in value) json(value[key], `${location}.${key}`); }
function optionalText(value: Record<string, unknown>, key: string, location: string): void { if (key in value) assertNonEmptyString(value[key], `${location}.${key}`); }
function optionalTextArray(value: Record<string, unknown>, key: string, location: string): void { if (!(key in value)) return; if (!Array.isArray(value[key])) throw new SwarmValidationError(`${location}.${key} must be an array.`); value[key].forEach((item, index) => assertNonEmptyString(item, `${location}.${key}[${index}]`)); }
function json(value: unknown, location: string, seen = new WeakSet<object>()): asserts value is SwarmJsonValue { if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return; if (typeof value !== 'object' || seen.has(value)) throw new SwarmValidationError(`${location} must contain only acyclic JSON values.`); seen.add(value); if (Array.isArray(value)) value.forEach((item, i) => json(item, `${location}[${i}]`, seen)); else { plain(value, location); Object.entries(value).forEach(([key, item]) => json(item, `${location}.${key}`, seen)); } seen.delete(value); }
function plain(value: unknown, location: string): asserts value is Record<string, any> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SwarmValidationError(`${location} must be an object.`); }
function assertNonEmptyString(value: unknown, location: string): asserts value is string { if (typeof value !== 'string' || value.trim().length === 0) throw new SwarmValidationError(`${location} must be a non-empty string.`); }
function eventError(index: number, message: string): SwarmValidationError { return new SwarmValidationError(`Event ${index + 1}: ${message}`); }
function slug(value: string): string { return value.replace(/[^A-Za-z0-9._-]/g, '-').replace(/\.{2,}/g, '-').replace(/^\./, '-').replace(/\.$/, '-').replace(/\.lock$/i, '-lock') || '-'; }
function deepFreeze<T>(value: T): T { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value as object).forEach(deepFreeze); Object.freeze(value); } return value; }
