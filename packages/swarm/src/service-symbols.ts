import type { SwarmRunEventStore } from './store.js';
import type {
  SwarmBaselineService,
  SwarmTranscriptReaderService,
  SwarmRoleModelService,
  SwarmSharedContextService,
} from './services.js';

const transcriptReader = Symbol.for('@marshal/swarm:transcript-reader') as symbol & { readonly __type?: (value: SwarmTranscriptReaderService) => SwarmTranscriptReaderService };

export const SWARM_EVENT_STORE_SERVICE_KEY = '@marshal/swarm:event-store';

const sharedContext = Symbol.for('@marshal/swarm:shared-context') as symbol & { readonly __type?: (value: SwarmSharedContextService) => SwarmSharedContextService };
const roleModel = Symbol.for('@marshal/swarm:role-model') as symbol & { readonly __type?: (value: SwarmRoleModelService) => SwarmRoleModelService };
const baseline = Symbol.for('@marshal/swarm:baseline') as symbol & { readonly __type?: (value: SwarmBaselineService) => SwarmBaselineService };
const eventStore = Symbol.for(SWARM_EVENT_STORE_SERVICE_KEY) as symbol & {
  readonly __type?: (value: SwarmRunEventStore) => SwarmRunEventStore;
};

export const SwarmServiceSymbols = {
  sharedContext,
  transcriptReader,
  roleModel,
  baseline,
  eventStore,
} as const;
