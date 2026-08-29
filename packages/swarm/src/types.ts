import type { InvocationContext, RuntimeExecResponse } from '@marshal/runtime';
import type { RuntimeOperationExecuteRequest } from '@marshal/runtime/core';
import type { SwarmRunTarget } from './contracts.js';
import type { SwarmRunEventStore } from './store.js';
import type { SwarmServiceContainer } from './service-container.js';

export interface SwarmRunCreateInput {
  readonly runId: string;
  readonly objective: string;
  readonly scope: string;
  readonly targetRef?: string;
  readonly targetHead?: string;
  readonly targets?: readonly SwarmRunTarget[];
  readonly workerModel?: string;
  readonly workerReasoningEffort?: string;
}

export interface SwarmRunInput {
  readonly runId: string;
}

export interface SwarmRunPauseInput {
  readonly runId: string;
  readonly reason: string;
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
