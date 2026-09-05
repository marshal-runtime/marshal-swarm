import { randomUUID } from 'node:crypto';

const RUN_ID_PREFIX = 'owner.';

/** Encode the caller session into a swarm run id so the host can recover the owner. */
export function createSwarmRunId(sessionId: string, suffix: string = randomUUID()): string {
  const normalized = sessionId.trim();
  if (!normalized) throw new TypeError('Swarm owner session is required.');
  return `${RUN_ID_PREFIX}${Buffer.from(normalized, 'utf8').toString('base64url')}.${suffix}`;
}

/** Read the owner session id encoded in a swarm run id. */
export function parseSwarmRunOwnerSessionId(runId: string): string {
  if (!runId.startsWith(RUN_ID_PREFIX)) {
    throw new Error(`Swarm run "${runId}" does not contain an owner session prefix.`);
  }
  const separator = runId.indexOf('.', RUN_ID_PREFIX.length);
  if (separator < 0) {
    throw new Error(`Swarm run "${runId}" does not contain an owner session prefix.`);
  }
  const encoded = runId.slice(RUN_ID_PREFIX.length, separator);
  const sessionId = Buffer.from(encoded, 'base64url').toString('utf8');
  if (!sessionId || Buffer.from(sessionId, 'utf8').toString('base64url') !== encoded) {
    throw new Error(`Swarm run "${runId}" has an invalid owner session prefix.`);
  }
  return sessionId;
}
