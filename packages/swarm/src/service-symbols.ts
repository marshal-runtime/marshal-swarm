import type {
  SwarmBaselineService,
  SwarmRoleModelService,
  SwarmSharedContextService,
} from './services.js';

const sharedContext = Symbol.for('@marshal/swarm:shared-context') as symbol & { readonly __type?: (value: SwarmSharedContextService) => SwarmSharedContextService };
const roleModel = Symbol.for('@marshal/swarm:role-model') as symbol & { readonly __type?: (value: SwarmRoleModelService) => SwarmRoleModelService };
const baseline = Symbol.for('@marshal/swarm:baseline') as symbol & { readonly __type?: (value: SwarmBaselineService) => SwarmBaselineService };

export const SwarmServiceSymbols = {
  sharedContext,
  roleModel,
  baseline,
} as const;
