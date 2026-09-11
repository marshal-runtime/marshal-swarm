import type { InvocationContext } from '@marshal/runtime';
import type { SwarmRun, SwarmTaskRole } from './contracts.js';
import {
  getSwarmServiceContainer,
  type SwarmServiceContainer,
} from './service-container.js';
import { SwarmServiceSymbols } from './service-symbols.js';

export interface SwarmSharedTopic {
  readonly path: string;
  readonly content: string;
}

export interface SwarmSharedContext {
  readonly path: string;
  readonly content: string;
  readonly topics?: readonly SwarmSharedTopic[];
}

export interface SwarmSharedContextService {
  read(runId: string): Promise<SwarmSharedContext>;
}

export interface SwarmBaseline {
  readonly ref: string;
  readonly head: string;
}

/**
 * Resolves the current run- and repository-scoped integration baseline. The
 * executor places the resolved head in `DelegationLaunchRequest.baseRef` and
 * prints the per-scope baseline in the task prompt. The bound host reads the
 * same authoritative integration ref the delegation adapter forks from; the
 * package performs no git and imports no host module.
 */
export interface SwarmBaselineService {
  resolve(runId: string, scope: string): Promise<SwarmBaseline>;
}

export interface SwarmRoleModel {
  readonly model?: string;
  readonly reasoningEffort?: string;
}

export interface SwarmRoleModelService {
  resolve(role: SwarmTaskRole, run?: SwarmRun): SwarmRoleModel;
}

export function getSwarmSharedContextService(
  container: SwarmServiceContainer = getSwarmServiceContainer(),
): SwarmSharedContextService {
  return container.get<SwarmSharedContextService>(
    SwarmServiceSymbols.sharedContext,
  );
}

export function tryGetSwarmSharedContextService(
  container: SwarmServiceContainer = getSwarmServiceContainer(),
): SwarmSharedContextService | undefined {
  return container.tryGet<SwarmSharedContextService>(
    SwarmServiceSymbols.sharedContext,
  );
}

export function getSwarmRoleModelService(
  container: SwarmServiceContainer = getSwarmServiceContainer(),
): SwarmRoleModelService {
  return container.get<SwarmRoleModelService>(SwarmServiceSymbols.roleModel);
}

export function tryGetSwarmRoleModelService(
  container: SwarmServiceContainer = getSwarmServiceContainer(),
): SwarmRoleModelService | undefined {
  return container.tryGet<SwarmRoleModelService>(
    SwarmServiceSymbols.roleModel,
  );
}

export function getSwarmBaselineService(
  container: SwarmServiceContainer = getSwarmServiceContainer(),
): SwarmBaselineService {
  return container.get<SwarmBaselineService>(SwarmServiceSymbols.baseline);
}

export function tryGetSwarmBaselineService(
  container: SwarmServiceContainer = getSwarmServiceContainer(),
): SwarmBaselineService | undefined {
  return container.tryGet<SwarmBaselineService>(
    SwarmServiceSymbols.baseline,
  );
}

export interface SwarmEvidenceReadResult {
  readonly uri: string;
  readonly text: string;
  readonly truncated: boolean;
  readonly nextOffset?: number;
}

export interface SwarmTranscriptReadInput {
  readonly sessionId: string;
  readonly uri: string;
  readonly offset?: number;
}

export interface SwarmTranscriptReaderService {
  read(input: SwarmTranscriptReadInput, invocation: InvocationContext): Promise<SwarmEvidenceReadResult>;
}

export function tryGetSwarmTranscriptReaderService(
  container: SwarmServiceContainer = getSwarmServiceContainer(),
): SwarmTranscriptReaderService | undefined {
  return container.tryGet<SwarmTranscriptReaderService>(SwarmServiceSymbols.transcriptReader);
}
