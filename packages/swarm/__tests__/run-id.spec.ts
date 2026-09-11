import { describe, expect, it } from 'vitest';
import { createSwarmRunId, parseSwarmRunOwnerSessionId } from '../src/run-id.js';

describe('createSwarmRunId', () => {
  describe('Sanity Tests', () => {
    it('round-trips the owner session id', () => {
      const runId = createSwarmRunId('session-1', 'suffix');
      expect(parseSwarmRunOwnerSessionId(runId)).toBe('session-1');
    });
  });

  describe('Error Handling', () => {
    it('rejects an empty session id', () => {
      expect(() => createSwarmRunId('  ')).toThrow('Swarm owner session is required.');
    });

    it('rejects a run id without an owner prefix', () => {
      expect(() => parseSwarmRunOwnerSessionId('not-owned')).toThrow(
        'does not contain an owner session prefix',
      );
    });
  });

  describe('Edge Cases', () => {
    it('encodes session ids that contain dots', () => {
      const runId = createSwarmRunId('owner.session.1', 'x');
      expect(parseSwarmRunOwnerSessionId(runId)).toBe('owner.session.1');
    });
  });
});
