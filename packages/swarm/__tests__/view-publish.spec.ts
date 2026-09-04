import { describe, expect, it } from 'vitest';
import type { InvocationContext, RuntimeExecResponse } from '@marshal/runtime';
import type { SwarmRun } from '../src/contracts.js';
import {
  publishSwarmRunView,
  UI_APPLICATION_LIST,
  UI_APPLICATION_OPEN,
  UI_SURFACE_INLINE_CARD,
  UI_SURFACE_PANEL,
} from '../src/view-publish.js';
import {
  SWARM_EXTENSION_IDENTITY,
  SWARM_RUN_APPLICATION_ID,
} from '../src/presentation.js';

const RUN_ID = 'owner.session.abc';
const SESSION_ID = 'session-1';
const WORKSPACE_NAME = 'zyg';
const RUN: SwarmRun = {
  runId: RUN_ID,
  objective: 'Ship the view',
  scope: WORKSPACE_NAME,
  state: 'running',
  tasks: [
    {
      taskId: 'root',
      role: 'planner',
      objective: 'Ship the view',
      scope: WORKSPACE_NAME,
      state: 'running',
    },
  ],
};

describe('publishSwarmRunView', () => {
  describe('Sanity', () => {
    it('opens a panel and a chat card for a scoped create', async () => {
      const calls: { readonly target: string; readonly input: Record<string, unknown> }[] = [];
      await publishSwarmRunView(RUN, scopedInvocation(), async (request) => {
        calls.push({
          target: request.target,
          input: request.input as Record<string, unknown>,
        });
        return success({ instances: [] });
      });
      const opens = calls.filter((call) => call.target === UI_APPLICATION_OPEN);
      expect(opens.map((call) => call.input.surface)).toEqual([
        UI_SURFACE_PANEL,
        UI_SURFACE_INLINE_CARD,
      ]);
      expect(opens[0]?.input).toMatchObject({
        extensionId: SWARM_EXTENSION_IDENTITY,
        applicationId: SWARM_RUN_APPLICATION_ID,
        state: { run: RUN },
      });
    });

    it('updates an existing surface instead of opening another', async () => {
      const calls: { readonly target: string; readonly input: Record<string, unknown> }[] = [];
      await publishSwarmRunView(RUN, scopedInvocation(), async (request) => {
        calls.push({
          target: request.target,
          input: request.input as Record<string, unknown>,
        });
        if (request.target === UI_APPLICATION_LIST) {
          return success({
            instances: [{
              instanceId: 'panel-1',
              surface: UI_SURFACE_PANEL,
              revision: 4,
            }],
          });
        }
        return success({});
      });
      expect(calls.some((call) =>
        call.target === UI_APPLICATION_OPEN && call.input.surface === UI_SURFACE_PANEL,
      )).toBe(false);
      expect(calls.some((call) =>
        call.target === 'ui.application.update' && call.input.instanceId === 'panel-1',
      )).toBe(true);
    });
  });

  describe('Error Handling', () => {
    it('propagates a Runtime UI execute failure', async () => {
      await expect(publishSwarmRunView(RUN, scopedInvocation(), async () => {
        throw new Error('ui denied');
      })).rejects.toThrow('ui denied');
    });
  });

  describe('Edge Cases', () => {
    it('skips injection when the invocation has no session', async () => {
      const calls: string[] = [];
      await publishSwarmRunView(RUN, { principal: { id: 'test' } } as InvocationContext, async (request) => {
        calls.push(request.target);
        return success({});
      });
      expect(calls).toEqual([]);
    });
  });
});

function scopedInvocation(): InvocationContext {
  return {
    principal: { id: 'test' },
    scope: { sessionId: SESSION_ID },
    metadata: { marshalWorkspaceName: WORKSPACE_NAME },
  } as InvocationContext;
}

function success(value: unknown): RuntimeExecResponse {
  return {
    status: 'success',
    result: { output: { ok: true, value } },
  } as RuntimeExecResponse;
}
