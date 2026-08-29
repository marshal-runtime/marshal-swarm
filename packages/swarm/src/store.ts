import { assertSwarmRunId, validateSwarmRunEvent, type SwarmRunCreateConfiguration, type SwarmRunEvent, type SwarmRunTarget, type SwarmRunUpdateEvent } from './contracts.js';
export interface SwarmRunEventStore { create(runId: string, objective: string, scope: string, targetRef?: string, targetHead?: string, targets?: readonly SwarmRunTarget[], configuration?: SwarmRunCreateConfiguration): Promise<void>; append(runId: string, event: SwarmRunUpdateEvent): Promise<void>; read(runId: string): Promise<readonly SwarmRunEvent[]>; list(): Promise<readonly string[]>; }
export class SwarmRunAlreadyExistsError extends Error { constructor(readonly runId: string) { super(`Swarm run "${runId}" already exists.`); } }
export class SwarmRunNotFoundError extends Error { constructor(readonly runId: string) { super(`Swarm run "${runId}" does not exist.`); } }
export class InMemorySwarmRunEventStore implements SwarmRunEventStore {
  private readonly runs = new Map<string, SwarmRunEvent[]>();
  async create(runId: string, objective: string, scope: string, targetRef?: string, targetHead?: string, targets?: readonly SwarmRunTarget[], configuration?: SwarmRunCreateConfiguration): Promise<void> { assertSwarmRunId(runId); if (this.runs.has(runId)) throw new SwarmRunAlreadyExistsError(runId); this.runs.set(runId, [validateSwarmRunEvent({ type: 'run.created', runId, objective, scope, ...(targetRef === undefined ? {} : { targetRef }), ...(targetHead === undefined ? {} : { targetHead }), ...(targets === undefined ? {} : { targets }), ...configuration })]); }
  async append(runId: string, event: SwarmRunUpdateEvent): Promise<void> { const events = this.runs.get(runId); if (!events) throw new SwarmRunNotFoundError(runId); const validated = validateSwarmRunEvent(event); if (validated.type === 'run.created') throw new TypeError('append does not accept run.created.'); events.push(validated); }
  async read(runId: string): Promise<readonly SwarmRunEvent[]> { const events = this.runs.get(runId); if (!events) throw new SwarmRunNotFoundError(runId); return events.map(cloneEvent); }
  async list(): Promise<readonly string[]> { return Object.freeze([...this.runs.keys()].sort()); }
}
export function cloneEvent<T extends SwarmRunEvent>(event: T): T { return JSON.parse(JSON.stringify(event)) as T; }
