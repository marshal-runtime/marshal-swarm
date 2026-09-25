import type { InvocationContext, RuntimeExecResponse } from '@marshal/runtime';
import type { RuntimeOperationExecuteRequest } from '@marshal/runtime/core';
import type { SwarmRunTarget, SwarmRoleDefinition, SwarmRoleModels } from './contracts.js';
import type { SwarmRunEventStore } from './store.js';
import type { SwarmServiceContainer } from './service-container.js';

export interface SwarmRunCreateInput {
  readonly runId?: string;
  readonly objective: string;
  readonly scope?: string;
  readonly fresh?: boolean;
  readonly targetRef?: string;
  readonly targetHead?: string;
  readonly targets?: readonly SwarmRunTarget[];
  readonly workerModel?: string;
  readonly workerReasoningEffort?: string;
  readonly roleModels?: SwarmRoleModels;
  readonly roles?: readonly SwarmRoleDefinition[];
}

export interface SwarmRunInput {
  readonly runId: string;
}

export interface SwarmRunPauseInput {
  readonly runId: string;
  readonly reason: string;
}
export interface SwarmRunSetRoleModelsInput extends SwarmRunInput {
  readonly roleModels: SwarmRoleModels;
  readonly reason: string;
}
export interface SwarmRunSetRolesInput extends SwarmRunInput {
  readonly roles: readonly SwarmRoleDefinition[];
  readonly reason: string;
}

export interface SwarmRunRecoverSystemFailureInput extends SwarmRunInput {
  readonly reason: string;
  readonly classification: "owner-session-busy-transport" | "owner-session-superseded-transport";
  /** One-based positions of the exact adjacent failure events at the journal tail. */
  readonly expectedTaskFailureIndex: number;
  readonly expectedRunFailureIndex: number;
}

export interface SwarmRunCancelInput {
  readonly runId: string;
  readonly reason: string;
}

export interface SwarmSourceOptions {
  readonly eventStore: SwarmRunEventStore;
  readonly providerId?: string;
  readonly serviceContainer?: SwarmServiceContainer;
}

export interface SwarmExecutionContext {
  execute(
    request: RuntimeOperationExecuteRequest,
    context: InvocationContext,
  ): Promise<RuntimeExecResponse>;
}
