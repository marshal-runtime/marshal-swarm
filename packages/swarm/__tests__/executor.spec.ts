import { describe, expect, it } from 'vitest';
import type {
  InvocationContext,
  RuntimeExecResponse,
} from '@marshal/runtime';
import {
  InMemorySwarmRunEventStore,
  type SwarmRunEventStore,
  type SwarmTaskRole,
} from '../src/index.js';
import {
  createSwarmProvider,
  parseAgentResponse,
  SWARM_RUNS_CANCEL,
  SWARM_RUNS_CREATE,
  SWARM_RUNS_DRIVE,
  SWARM_RUNS_GET,
  SWARM_RUNS_LIST,
  SWARM_RUNS_PAUSE,
  SWARM_RUNS_RESUME,
  SwarmServiceContainer,
  SwarmServiceSymbols,
  SwarmExecutor,
  type SwarmBaselineService,
  type SwarmSharedContext,
  type SwarmSharedContextService,
} from '../src/index.js';

const invocation = {
  principal: { id: 'test' },
} as InvocationContext;

describe('SwarmExecutor', () => {
  it('recurses through planner nodes without fixed depth', async () => {
    const agents = new ScriptedDelegation(({ taskId, call, prompt }) => {
      expect(prompt).toContain('- Repository scope: repository');
      expect(prompt).toContain('--- FIELD GUIDE START ---');
      expect(prompt).not.toContain('Root objective and constraints:');
      if (taskId === 'root') {
        expect(prompt).toContain('Complete recursion-run');
      }
      if (call === 1 && taskId === 'root') {
        return delegate(child('level-1', 'planner'));
      }
      if (call === 1 && taskId === 'level-1') {
        return delegate(child('level-2', 'planner'));
      }
      if (call === 1 && taskId === 'level-2') return delegate(child('leaf'));
      if (taskId === 'leaf') return result('leaf complete');
      if (taskId === 'level-2') return result('level 2 complete');
      if (taskId === 'level-1') return result('level 1 complete');
      if (taskId === 'root') return result('done');
      throw new Error(`Unexpected task ${taskId} call ${call}.`);
    });

    const run = await executeRun(createExecutor(agents), 'recursion-run');

    expect(run.state).toBe('done');
    expect(run.result).toBe('done');
    expect(run.scope).toBe('repository');
    expect(run.tasks.find((task) => task.taskId === 'root')?.role)
      .toBe('planner');
    expect(run.tasks.find((task) =>
      task.taskId === 'root/level-1/level-2/leaf')?.role)
      .toBe('worker');
    expect(run.tasks.find((task) =>
      task.taskId === 'root/level-1/level-2/leaf')?.parentTaskId)
      .toBe('root/level-1/level-2');
    expect(run.tasks.every((task) =>
      task.scope === 'repository'
    )).toBe(true);
  });

  it('re-enters the planner partially as each child becomes terminal', async () => {
    const agents = new ScriptedDelegation(({ taskId, call, prompt }) => {
      if (taskId === 'root' && call === 1) {
        return delegate(
          child('worker-a'),
          child('worker-b', 'worker', 'repository-b'),
        );
      }
      if (taskId === 'worker-a') return result({ summary: 'worker-a complete' });
      if (taskId === 'worker-b') {
        expect(prompt).toContain('Repository scope: repository-b');
        return result({ summary: 'worker-b complete' });
      }
      if (taskId === 'root' && call === 2) {
        expect(prompt).toContain('worker-a complete');
        expect(prompt).not.toContain('worker-b complete');
        expect(prompt).toContain('## Outstanding children');
        return result('waiting on worker-b');
      }
      if (taskId === 'root' && call === 3) {
        expect(prompt).toContain('worker-a complete');
        expect(prompt).toContain('worker-b complete');
        return result('done');
      }
      throw new Error(`Unexpected task ${taskId} call ${call}.`);
    });
    const releaseWorkerB = agents.blockWait('worker-b');
    const executor = createExecutor(agents);

    const driven = executeRun(executor, 'continuation-run');
    await agents.whenSpawned('worker-b');
    await expect.poll(() => agents.callsFor('root')).toBe(2);
    releaseWorkerB();
    const run = await driven;

    expect(run.state).toBe('done');
    expect(run.result).toBe('done');
    expect(agents.continueInputs).toContainEqual({
      delegationId: 'root:1',
      prompt: expect.stringContaining('worker-b complete'),
    });
    expect(agents.callsFor('root')).toBe(3);
  });

  it('completes tasks from tolerant JSON-safe agent output', async () => {
    const agents = new ScriptedDelegation(({ taskId, call, prompt }) => {
      if (taskId === 'root' && call === 1) {
        return delegate(child('plain'), child('object'));
      }
      if (taskId === 'plain') return 'not json';
      if (taskId === 'object') return { summary: 'object complete' };
      if (taskId === 'root' && call === 2) return result('waiting');
      if (taskId === 'root' && call === 3) {
        expect(prompt).toContain(
          '"taskId":"plain","role":"worker","result":"not json"',
        );
        expect(prompt).toContain(
          '"taskId":"object","role":"worker","result":{"summary":"object complete"}',
        );
        return 'done without JSON';
      }
      throw new Error(`Unexpected task ${taskId} call ${call}.`);
    });
    const releaseObject = agents.blockWait('object');
    const executor = createExecutor(agents);

    const driven = executeRun(executor, 'completion-run');
    await agents.whenSpawned('object');
    await expect.poll(() => agents.callsFor('root')).toBe(2);
    releaseObject();
    const run = await driven;

    expect(run.state).toBe('done');
    expect(run.result).toBe('done without JSON');
    expect(run.tasks.find((task) => task.taskId === 'root/plain')?.result)
      .toBe('not json');
    expect(run.tasks.find((task) => task.taskId === 'root/object')?.result)
      .toEqual({ summary: 'object complete' });
  });

  it('launches newly ready descendants while unrelated siblings run', async () => {
    const agents = new ScriptedDelegation(({ taskId, call }) => {
      if (taskId === 'root' && call === 1) {
        return delegate(child('branch', 'planner'), child('slow'));
      }
      if (taskId === 'branch' && call === 1) return delegate(child('leaf'));
      if (taskId === 'leaf') return result('leaf complete');
      if (taskId === 'branch' && call === 2) return result('branch complete');
      if (taskId === 'slow') return result('slow complete');
      if (taskId === 'root' && call >= 2) return result('done');
      throw new Error(`Unexpected task ${taskId} call ${call}.`);
    });
    const releaseSlow = agents.blockWait('slow');

    const driven = executeRun(createExecutor(agents), 'streaming-run');
    await agents.whenSpawned('leaf');
    expect(agents.callsFor('slow')).toBe(1);
    expect(agents.callsFor('leaf')).toBe(1);
    releaseSlow();

    expect((await driven).state).toBe('done');
  });

  it('commits a pending spawn before a concurrent pause can proceed', async () => {
    const agents = new ScriptedDelegation(() => result('done'));
    const executor = createExecutor(agents);
    let paused: Promise<unknown> | undefined;
    agents.pauseAfterSpawn(() => {
      paused = executor.pause({ runId: 'pause-race-run', reason: 'stop' }, invocation);
    });

    const run = await executeRun(executor, 'pause-race-run');
    await paused;

    expect(run.state).toBe('paused');
    expect(run.tasks[0]).toMatchObject({
      state: 'running',
      delegationId: 'root:1',
    });
  });

  it('does not spawn a pending task twice across concurrent drives', async () => {
    const store = new InMemorySwarmRunEventStore();
    const agents = new ScriptedDelegation(({ taskId, call }) => {
      if (taskId === 'root' && call === 1) return delegate(child('child'));
      if (taskId === 'child') return result('child complete');
      if (taskId === 'root' && call === 2) return result('done');
      throw new Error(`Unexpected task ${taskId} call ${call}.`);
    });
    const releaseWait = agents.blockWait('root');
    const executor = createExecutor(agents, store);
    await executor.create({
      runId: 'drive-race-run',
      objective: 'Complete drive-race-run',
      scope: 'repository',
    }, invocation);
    const first = executor.drive({ runId: 'drive-race-run' }, invocation);
    await agents.whenSpawned('root');
    const second = executor.drive({ runId: 'drive-race-run' }, invocation);
    releaseWait();

    const [firstRun, secondRun] = await Promise.all([first, second]);
    expect(firstRun.state).toBe('done');
    expect(secondRun.state).toBe('done');
    expect(agents.callsFor('root')).toBe(2);
    expect(agents.spawnInputs).toHaveLength(2);
    expect(agents.continueInputs).toHaveLength(1);
    expect((await store.read('drive-race-run'))
      .filter((event) => event.type === 'task.completed')).toHaveLength(2);
  });

  it('records a thrown spawn failure without projecting a start', async () => {
    const store = new InMemorySwarmRunEventStore();
    const agents = new ScriptedDelegation(() => result('unused'));
    agents.failSpawn('root', new Error('spawn transport rejected'));
    const executor = createExecutor(agents, store);

    const run = await executeRun(executor, 'spawn-failure-run');

    expect(run.state).toBe('failed');
    expect(run.tasks[0]).toMatchObject({
      taskId: 'root',
      state: 'failed',
      error: 'spawn transport rejected',
    });
    expect(run.tasks[0]?.delegationId).toBeUndefined();
    expect((await store.read('spawn-failure-run')).map((event) => event.type))
      .not.toContain('task.started');
  });

  it('pauses immediately on a confirmed disk-full spawn failure', async () => {
    const agents = new ScriptedDelegation(() => result('unused'));
    agents.failSpawn('root', Object.assign(
      new Error('There is not enough space on the disk.'),
      { code: 'ENOSPC', errno: 112 },
    ));
    const executor = createExecutor(agents);

    const run = await executeRun(executor, 'disk-full-run');

    expect(run.state).toBe('paused');
    expect(run.pauseReason?.category).toBe('disk-full');
    expect(run.pauseReason?.code).toBe('ENOSPC');
    expect(agents.callsFor('root')).toBe(0);
    expect((await executor.drive({ runId: 'disk-full-run' }, invocation)).state)
      .toBe('paused');
  });

  it.each([
    ['POSIX ENOSPC', 28, undefined, true],
    ['negative POSIX ENOSPC', -28, undefined, true],
    ['Windows handle disk full', 39, undefined, true],
    ['unqualified Windows disk full', 112, undefined, false],
    ['Windows disk full', 112, 'win32', true],
  ])('classifies %s without treating 112 globally', async (
    _label,
    code,
    platform,
    diskFull,
  ) => {
    const agents = new ScriptedDelegation(() => result('unused'));
    agents.failSpawn('root', Object.assign(new Error('spawn failed'), {
      code,
      ...(platform === undefined ? {} : { platform }),
    }));
    const run = await executeRun(createExecutor(agents), `disk-code-${code}`);

    expect(run.state).toBe(diskFull ? 'paused' : 'failed');
    expect(run.pauseReason?.category).toBe(
      diskFull ? 'disk-full' : undefined,
    );
  });

  it('pauses on the canonical Windows disk-full error handle', async () => {
    const agents = new ScriptedDelegation(() => result('unused'));
    agents.failSpawn('root', new Error('ERROR_HANDLE_DISK_FULL'));

    const run = await executeRun(createExecutor(agents), 'disk-handle-run');

    expect(run.state).toBe('paused');
    expect(run.pauseReason?.category).toBe('disk-full');
  });

  it('allows independently planned children to reuse parent-local IDs', async () => {
    const agents = new ScriptedDelegation(({ taskId, call }) => {
      if (taskId === 'root' && call === 1) {
        return delegate(
          child('left-parent', 'planner'),
          child('right-parent', 'planner'),
        );
      }
      if (
        (taskId === 'left-parent' || taskId === 'right-parent')
        && call === 1
      ) {
        return delegate(child('leaf'));
      }
      if (taskId === 'leaf') return result('leaf complete');
      if (taskId === 'left-parent' || taskId === 'right-parent') {
        return result(`${taskId} complete`);
      }
      if (taskId === 'root') return result('done');
      throw new Error(`Unexpected task ${taskId} call ${call}.`);
    });

    const run = await executeRun(createExecutor(agents), 'local-ids-run');

    expect(run.state).toBe('done');
    expect(run.tasks.filter((task) =>
      task.taskId.endsWith('/leaf')).map((task) => task.taskId).sort())
      .toEqual([
        'root/left-parent/leaf',
        'root/right-parent/leaf',
      ]);
  });

  it('completes a planner that returns an empty child set', async () => {
    const run = await executeRun(
      createExecutor(new ScriptedDelegation(() => delegate())),
      'empty-plan-run',
    );

    expect(run.state).toBe('done');
    expect(run.result).toEqual({ children: [] });
  });

  it('allows review of changed child work without mandatory reconciliation', async () => {
    const agents = new ScriptedDelegation(({ taskId, call }) => {
      if (taskId === 'root' && call === 1) return delegate(child('worker'));
      if (taskId === 'worker') return result('implemented', 'change-worker');
      if (taskId === 'root' && call === 2) {
        return delegate(child('review', 'reviewer'));
      }
      if (taskId === 'review') return review();
      if (taskId === 'root' && call === 3) return result('done');
      throw new Error(`Unexpected task ${taskId} call ${call}.`);
    });

    const run = await executeRun(createExecutor(agents), 'review-order-run');

    expect(run.state).toBe('done');
    expect(run.result).toBe('done');
    expect(agents.callsFor('review')).toBe(1);
  });

  it('allows review when reconciliation is concurrent rather than causal', async () => {
    const store = new InMemorySwarmRunEventStore();
    const agents = new ScriptedDelegation(({ taskId, call }) => {
      if (taskId === 'root' && call === 1) {
        return delegate(
          child('worker'),
          child('reconcile', 'reconciler'),
        );
      }
      if (taskId === 'worker') return result('implemented', 'change-worker');
      if (taskId === 'reconcile') return result('reconciled', 'change-reconcile');
      if (taskId === 'root' && call === 2) return result('waiting on worker');
      if (taskId === 'root' && call === 3) {
        return delegate(child('review', 'reviewer'));
      }
      if (taskId === 'review') return review();
      if (taskId === 'root' && call === 4) return result('done');
      throw new Error(`Unexpected task ${taskId} call ${call}.`);
    });
    const releaseWorker = agents.blockWait('worker');
    const executor = createExecutor(agents, store);

    const driven = executeRun(executor, 'causal-review-run');
    await agents.whenSpawned('reconcile');
    await expect.poll(async () =>
      (await executor.get({ runId: 'causal-review-run' })).tasks.find(
        (task) => task.taskId === 'root/reconcile',
      )?.state).toBe('done');
    await expect.poll(() => agents.callsFor('root')).toBe(2);
    releaseWorker();
    const run = await driven;

    expect(run.state).toBe('done');
    expect(run.result).toBe('done');
    expect(agents.callsFor('review')).toBe(1);
  });

  it('reconnects an interrupted wait without spawning the task again', async () => {
    const store = new InMemorySwarmRunEventStore();
    const agents = new ScriptedDelegation(() => result('done'));
    agents.interruptNextWait();
    const firstExecutor = createExecutor(agents, store);
    await firstExecutor.create({
      runId: 'wait-run',
      objective: 'Complete wait-run',
      scope: 'repository',
    }, invocation);

    await expect(firstExecutor.drive(
      { runId: 'wait-run' },
      invocation,
    )).rejects.toThrow('simulated wait interruption');
    expect(
      (await firstExecutor.get({ runId: 'wait-run' })).tasks[0]?.delegationId,
    ).toBe('root:1');
    const run = await createExecutor(agents, store).drive(
      { runId: 'wait-run' },
      invocation,
    );

    expect(run.state).toBe('done');
    expect(run.result).toBe('done');
    expect(agents.callsFor('root')).toBe(1);
    expect(agents.spawnInputs).toHaveLength(1);
  });

  it('cancels persisted delegations after executor restart', async () => {
    const store = new InMemorySwarmRunEventStore();
    const agents = new ScriptedDelegation(() => result('done'));
    agents.interruptNextWait();
    const firstExecutor = createExecutor(agents, store);
    await firstExecutor.create({
      runId: 'cancel-run',
      objective: 'Complete cancel-run',
      scope: 'repository',
    }, invocation);
    await expect(firstExecutor.drive(
      { runId: 'cancel-run' },
      invocation,
    )).rejects.toThrow('simulated wait interruption');

    const run = await createExecutor(agents, store).cancel({
      runId: 'cancel-run',
      reason: 'stop',
    }, invocation);

    expect(run.state).toBe('failed');
    expect(agents.cancelInputs).toEqual([{
      delegationId: 'root:1',
      recursive: true,
    }]);
  });

  it('gives each parent only its immediate children change refs', async () => {
    const agents = new ScriptedDelegation(({ taskId, call, prompt }) => {
      if (taskId === 'root' && call === 1) {
        return delegate(child('parent', 'planner'));
      }
      if (taskId === 'parent' && call === 1) {
        return delegate(child('left'), child('nested', 'planner'));
      }
      if (taskId === 'left') return result('left', 'change-left');
      if (taskId === 'nested' && call === 1) return delegate(child('deep'));
      if (taskId === 'deep') return result('deep', 'change-deep');
      if (taskId === 'nested' && call === 2) {
        expect(prompt).toContain('"changeRefs":["change-deep"]');
        return result('nested', 'change-nested');
      }
      if (taskId === 'parent' && call === 2) {
        expect(prompt).toContain('"changeRefs":["change-nested"]');
        expect(prompt).not.toContain('change-deep');
        return result('holding for left');
      }
      if (taskId === 'parent' && call === 3) {
        expect(prompt).toContain('"changeRefs":["change-left"]');
        expect(prompt).toContain('"changeRefs":["change-nested"]');
        expect(prompt).not.toContain('change-deep');
        return result('parent', 'change-parent');
      }
      if (taskId === 'root' && call === 2) {
        expect(prompt).toContain('"changeRefs":["change-parent"]');
        expect(prompt).not.toContain('change-left');
        expect(prompt).not.toContain('change-deep');
        return result('done');
      }
      throw new Error(`Unexpected task ${taskId} call ${call}.`);
    });
    const releaseLeft = agents.blockWait('left');
    const executor = createExecutor(agents);

    const driven = executeRun(executor, 'changes-run');
    await agents.whenSpawned('left');
    await expect.poll(() => agents.callsFor('parent')).toBe(2);
    releaseLeft();
    const run = await driven;

    expect(run.state).toBe('done');
    expect(run.tasks.flatMap((task) =>
      task.changeRefs ?? [])).toEqual([
      'change-parent',
      'change-left',
      'change-nested',
      'change-deep',
    ]);
  });

  it('normalizes only non-object JSON-safe responses as result envelopes', () => {
    expect(parseAgentResponse({ result: 'direct' })).toEqual({
      result: 'direct',
    });
    expect(parseAgentResponse('{"children":[]}')).toEqual({ children: [] });
    expect(parseAgentResponse('plain')).toEqual({ result: 'plain' });
    expect(parseAgentResponse([1, true, null])).toEqual({
      result: [1, true, null],
    });
  });

  it('resolves a per-scope baseline and forwards baseRef to the delegation', async () => {
    const scopes: string[] = [];
    const agents = new ScriptedDelegation(({ taskId, prompt }) => {
      if (taskId === 'root') {
        expect(prompt).toContain('- Baseline ref: integration-ref');
        expect(prompt).toContain('- Baseline head: integration-head');
        return result('done');
      }
      throw new Error(`Unexpected task ${taskId}.`);
    });
    const baseline: SwarmBaselineService = {
      resolve: async (_runId, scope) => {
        scopes.push(scope);
        return { ref: 'integration-ref', head: 'integration-head' };
      },
    };

    const run = await executeRun(
      createExecutor(agents, new InMemorySwarmRunEventStore(), { baseline }),
      'baseline-run',
    );

    expect(run.state).toBe('done');
    expect(scopes).toContain('repository');
    expect(agents.spawnInputs[0]?.baseRef).toBe('integration-head');
  });

  it('carries declared run targets and refuses child scopes outside them', async () => {
    const agents = new ScriptedDelegation(({ taskId, call }) => {
      if (taskId === 'root' && call === 1) {
        return delegate(child('stray', 'worker', 'repo-b'));
      }
      throw new Error(`Unexpected task ${taskId} call ${call}.`);
    });
    const executor = createExecutor(agents);
    await executor.create({
      runId: 'scope-run',
      objective: 'Complete scope-run',
      scope: 'repo-a',
      targets: [{ scope: 'repo-a', ref: 'ref-a', head: 'head-a' }],
    }, invocation);

    const run = await executor.drive({ runId: 'scope-run' }, invocation);

    expect(run.state).toBe('failed');
    expect(run.tasks[0]).toMatchObject({ taskId: 'root', state: 'failed' });
    expect(run.tasks[0]?.error).toMatch(/declared repository targets/);
  });

  it('prints the per-scope target for a declared run target', async () => {
    const agents = new ScriptedDelegation(({ taskId, prompt }) => {
      if (taskId === 'root') {
        expect(prompt).toContain('- Scope target ref: ref-a');
        expect(prompt).toContain('- Scope target head: head-a');
        return result('done');
      }
      throw new Error(`Unexpected task ${taskId}.`);
    });
    const executor = createExecutor(agents);
    await executor.create({
      runId: 'target-run',
      objective: 'Complete target-run',
      scope: 'repo-a',
      targets: [{ scope: 'repo-a', ref: 'ref-a', head: 'head-a' }],
    }, invocation);

    const run = await executor.drive({ runId: 'target-run' }, invocation);

    expect(run.state).toBe('done');
  });

  it('refuses to resume a run whose task scope escapes the declared targets', async () => {
    const store = new InMemorySwarmRunEventStore();
    const executor = createExecutor(
      new ScriptedDelegation(() => result('done')),
      store,
    );
    await executor.create({
      runId: 'resume-guard-run',
      objective: 'Complete resume-guard-run',
      scope: 'repo-a',
      targets: [{ scope: 'repo-a', ref: 'ref-a', head: 'head-a' }],
    }, invocation);
    await store.append('resume-guard-run', {
      type: 'task.added',
      task: {
        taskId: 'root/stray',
        parentTaskId: 'root',
        role: 'worker',
        objective: 'stray',
        scope: 'repo-b',
      },
    });
    await store.append('resume-guard-run', {
      type: 'run.paused',
      reason: { kind: 'manual', message: 'stop' },
    });

    await expect(executor.resume({ runId: 'resume-guard-run' }, invocation))
      .rejects.toThrow(/declared repository targets/);
    expect((await executor.get({ runId: 'resume-guard-run' })).state)
      .toBe('paused');
  });

  it('fails a reviewer that returns narration and lets the planner react', async () => {
    const agents = new ScriptedDelegation(({ taskId, call }) => {
      if (taskId === 'root' && call === 1) return delegate(child('worker'));
      if (taskId === 'worker') return result('implemented', 'change-worker');
      if (taskId === 'root' && call === 2) {
        return delegate(child('review', 'reviewer'));
      }
      if (taskId === 'review') return result('looks good to me');
      if (taskId === 'root' && call === 3) return result('done');
      throw new Error(`Unexpected task ${taskId} call ${call}.`);
    });

    const run = await executeRun(createExecutor(agents), 'reviewer-shape-run');

    expect(run.state).toBe('done');
    const reviewTask = run.tasks.find((task) => task.taskId === 'root/review');
    expect(reviewTask?.state).toBe('failed');
    expect(reviewTask?.error).toMatch(/must be structured/);
  });

  it('accepts a structurally valid reviewer verdict', async () => {
    const agents = new ScriptedDelegation(({ taskId, call }) => {
      if (taskId === 'root' && call === 1) return delegate(child('worker'));
      if (taskId === 'worker') return result('implemented', 'change-worker');
      if (taskId === 'root' && call === 2) {
        return delegate(child('review', 'reviewer'));
      }
      if (taskId === 'review') return review(['tighten the boundary type']);
      if (taskId === 'root' && call === 3) return result('done');
      throw new Error(`Unexpected task ${taskId} call ${call}.`);
    });

    const run = await executeRun(createExecutor(agents), 'reviewer-ok-run');

    expect(run.state).toBe('done');
    const reviewTask = run.tasks.find((task) => task.taskId === 'root/review');
    expect(reviewTask?.state).toBe('done');
    expect(reviewTask?.result).toEqual({
      reviewed: true,
      findings: ['tighten the boundary type'],
    });
  });

  it('refuses a repeated review when no change ref advanced', async () => {
    const agents = new ScriptedDelegation(({ taskId, call }) => {
      if (taskId === 'root' && call === 1) return delegate(child('worker'));
      if (taskId === 'worker') return result('implemented', 'change-worker');
      if (taskId === 'root' && call === 2) {
        return delegate(child('review', 'reviewer'));
      }
      if (taskId === 'review') return review();
      if (taskId === 'root' && call === 3) {
        return delegate(child('review-again', 'reviewer'));
      }
      if (taskId === 'root' && call === 4) return result('done');
      throw new Error(`Unexpected task ${taskId} call ${call}.`);
    });

    const run = await executeRun(createExecutor(agents), 'review-recur-run');

    expect(run.state).toBe('done');
    const again = run.tasks.find((task) => task.taskId === 'root/review-again');
    expect(again?.state).toBe('failed');
    expect(again?.error).toMatch(/already reviewed/);
    expect(agents.callsFor('review-again')).toBe(0);
  });

  it('allocates deterministic suffixes when a planner reuses a child local id', async () => {
    const reused = {
      taskId: 'dup',
      role: 'worker' as const,
      objective: 'Complete dup-two',
      scope: 'repository',
    };
    const agents = new ScriptedDelegation(({ taskId, call }) => {
      if (taskId === 'root' && call === 1) return delegate(child('dup'));
      if (taskId === 'dup') return result('first dup');
      if (taskId === 'root' && call === 2) return delegate(reused);
      if (taskId === 'dup-two') return result('second dup');
      if (taskId === 'root' && call === 3) return result('done');
      throw new Error(`Unexpected task ${taskId} call ${call}.`);
    });

    const run = await executeRun(createExecutor(agents), 'dup-id-run');

    expect(run.state).toBe('done');
    const workerIds = run.tasks
      .filter((task) => task.parentTaskId === 'root' && task.role === 'worker')
      .map((task) => task.taskId)
      .sort();
    expect(workerIds).toEqual(['root/dup', 'root/dup%232']);
    expect(run.tasks.find((task) => task.taskId === 'root/dup')?.result)
      .toBe('first dup');
    expect(run.tasks.find((task) => task.taskId === 'root/dup%232')?.result)
      .toBe('second dup');
  });

  it('injects the sibling roster and field guide topics into prompts', async () => {
    const sharedContext: SwarmSharedContextService = {
      read: async (runId): Promise<SwarmSharedContext> => ({
        path: `Q:\\swarm-runs\\${runId}\\field-guide\\index.md`,
        content: '# Field Guide',
        topics: [{
          path: 'field-guide/topics/api.md',
          content: 'API boundary decisions',
        }],
      }),
    };
    const agents = new ScriptedDelegation(({ taskId, call, prompt }) => {
      if (taskId === 'root' && call === 1) {
        return delegate(child('alpha'), child('beta'));
      }
      if (taskId === 'alpha') {
        expect(prompt).toContain('## Sibling ownership');
        expect(prompt).toContain('"taskId":"beta"');
        expect(prompt).toContain(
          '--- FIELD GUIDE TOPIC: field-guide/topics/api.md ---',
        );
        expect(prompt).toContain('API boundary decisions');
        return result('alpha done');
      }
      if (taskId === 'beta') return result('beta done');
      if (taskId === 'root' && call >= 2) return result('done');
      throw new Error(`Unexpected task ${taskId} call ${call}.`);
    });

    const run = await executeRun(
      createExecutor(agents, new InMemorySwarmRunEventStore(), {
        sharedContext,
      }),
      'roster-run',
    );

    expect(run.state).toBe('done');
  });

  it('exposes the full swarm provider API', () => {
    const provider = createSwarmProvider(
      createExecutor(new ScriptedDelegation(() => result('done'))),
    );

    expect(provider.list().map((descriptor) => descriptor.name)).toEqual([
      SWARM_RUNS_CREATE,
      SWARM_RUNS_GET,
      SWARM_RUNS_LIST,
      SWARM_RUNS_CANCEL,
      SWARM_RUNS_PAUSE,
      SWARM_RUNS_RESUME,
      SWARM_RUNS_DRIVE,
    ]);
  });
});

class ScriptedDelegation {
  readonly spawnInputs: Readonly<Record<string, unknown>>[] = [];
  readonly continueInputs: Readonly<Record<string, unknown>>[] = [];
  readonly cancelInputs: Readonly<Record<string, unknown>>[] = [];
  private readonly calls = new Map<string, number>();
  private waitInterruptions = 0;
  private readonly spawnFailures = new Map<string, Error>();
  private readonly waitBlocks = new Map<string, Promise<void>>();
  private readonly spawned = new Set<string>();
  private readonly spawnWaiters = new Map<string, () => void>();
  private readonly pending = new Map<string, {
    readonly taskId: string;
    response: unknown | Error;
    state: 'running' | 'done' | 'failed' | 'cancelled';
  }>();
  private spawnHook?: () => void;

  constructor(
    private readonly respond: (input: {
      readonly taskId: string;
      readonly call: number;
      readonly prompt: string;
    }) => unknown | Error,
  ) {}

  callsFor(taskId: string): number {
    return this.calls.get(taskId) ?? 0;
  }

  interruptNextWait(): void {
    this.waitInterruptions++;
  }

  failSpawn(taskId: string, error: Error): void {
    this.spawnFailures.set(taskId, error);
  }

  blockWait(taskId: string): () => void {
    let release!: () => void;
    this.waitBlocks.set(taskId, new Promise((resolve) => {
      release = resolve;
    }));
    return () => {
      this.waitBlocks.delete(taskId);
      release();
    };
  }

  pauseAfterSpawn(hook: () => void): void {
    this.spawnHook = hook;
  }

  whenSpawned(taskId: string): Promise<void> {
    if (this.spawned.has(taskId)) return Promise.resolve();
    return new Promise((resolve) => {
      this.spawnWaiters.set(taskId, () => resolve());
    });
  }

  async execute(
    target: string,
    inputValue: unknown,
  ): Promise<RuntimeExecResponse> {
    const input = inputValue as Readonly<Record<string, unknown>>;
    const delegationRecord = (delegationId: string) => {
      const pending = this.pending.get(delegationId)!;
      const reply = pending.response instanceof AgentReply
        ? pending.response
        : undefined;
      return {
        delegationId,
        state: pending.state,
        ...(pending.state === 'done'
          ? { result: reply?.response ?? pending.response }
          : {}),
        ...(reply?.changeRefs === undefined
          ? {}
          : { changeRefs: reply.changeRefs }),
        ...(pending.state === 'failed'
          ? { error: { message: (pending.response as Error).message } }
          : {}),
      };
    };
    if (target === 'runtime.delegation.spawn') {
      assertExactInput(
        input,
        ['prompt', 'role', 'scope', 'workspaceMode'],
        ['baseRef', 'model', 'parentDelegationId', 'reasoningEffort'],
      );
      this.spawnInputs.push(input);
      const prompt = input.prompt as string;
      const parentDelegationId = input.parentDelegationId as string | undefined;
      const taskId = parentDelegationId === undefined
        ? 'root'
        : taskIdFromPrompt(prompt);
      const spawnFailure = this.spawnFailures.get(taskId);
      if (spawnFailure) throw spawnFailure;
      const delegationId = parentDelegationId === undefined
        ? 'root:1'
        : `${parentDelegationId}/${taskId}:1`;
      this.calls.set(taskId, 1);
      this.pending.set(delegationId, {
        taskId,
        response: this.respond({ taskId, call: 1, prompt }),
        state: 'running',
      });
      this.spawned.add(taskId);
      this.spawnWaiters.get(taskId)?.();
      this.spawnWaiters.delete(taskId);
      this.spawnHook?.();
      return response(delegationRecord(delegationId));
    }
    if (target === 'runtime.delegation.continue') {
      assertExactInput(input, ['delegationId', 'prompt']);
      this.continueInputs.push(input);
      const delegationId = input.delegationId as string;
      const pending = this.pending.get(delegationId)!;
      const call = this.callsFor(pending.taskId) + 1;
      const prompt = input.prompt as string;
      this.calls.set(pending.taskId, call);
      pending.response = this.respond({ taskId: pending.taskId, call, prompt });
      pending.state = 'running';
      return response(delegationRecord(delegationId));
    }
    if (target === 'runtime.delegation.wait') {
      assertExactInput(input, ['delegationId']);
      if (this.waitInterruptions > 0) {
        this.waitInterruptions--;
        throw new Error('simulated wait interruption');
      }
      const delegationId = input.delegationId as string;
      const pending = this.pending.get(delegationId)!;
      await this.waitBlocks.get(pending.taskId);
      pending.state = pending.response instanceof Error ? 'failed' : 'done';
      return response(delegationRecord(delegationId));
    }
    if (target === 'runtime.delegation.cancel') {
      assertExactInput(input, ['delegationId'], ['recursive']);
      this.cancelInputs.push(input);
      const delegationId = input.delegationId as string;
      const pending = this.pending.get(delegationId)!;
      pending.state = 'cancelled';
      return response({ cancellations: [delegationRecord(delegationId)] });
    }
    if (target === 'runtime.delegation.pause') {
      assertExactInput(input, ['delegationId', 'reason']);
      return response({});
    }
    throw new Error(`Unexpected operation ${target}.`);
  }
}

function taskIdFromPrompt(prompt: string): string {
  const taskId = /^## Objective\r?\n\r?\nComplete (.+)$/m.exec(prompt)?.[1];
  if (!taskId) throw new Error('Spawn prompt did not identify the child task.');
  return taskId;
}

function assertExactInput(
  input: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  expect(Object.keys(input).sort()).toEqual(
    [...required, ...optional.filter((key) => key in input)].sort(),
  );
  for (const key of required) expect(input).toHaveProperty(key);
}

interface ExecutorServices {
  readonly baseline?: SwarmBaselineService;
  readonly sharedContext?: SwarmSharedContextService;
}

function createExecutor(
  agents: ScriptedDelegation,
  eventStore: SwarmRunEventStore = new InMemorySwarmRunEventStore(),
  services: ExecutorServices = {},
): SwarmExecutor {
  const sharedContext: SwarmSharedContextService = services.sharedContext ?? {
    read: async (runId) => ({
      path: `Q:\\swarm-runs\\${runId}\\field-guide\\index.md`,
      content: '# Field Guide',
    }),
  };
  const serviceContainer = new SwarmServiceContainer().bind<
    SwarmSharedContextService
  >(SwarmServiceSymbols.sharedContext, sharedContext);
  if (services.baseline !== undefined) {
    serviceContainer.bind<SwarmBaselineService>(
      SwarmServiceSymbols.baseline,
      services.baseline,
    );
  }
  const factory = {
    execute: (
      request: { readonly target: string; readonly input: unknown },
    ) => agents.execute(request.target, request.input),
  };
  return new SwarmExecutor(factory, { eventStore, serviceContainer });
}

async function executeRun(executor: SwarmExecutor, runId: string) {
  await executor.create({
    runId,
    objective: `Complete ${runId}`,
    scope: 'repository',
  }, invocation);
  return executor.drive({ runId }, invocation);
}

function child(
  taskId: string,
  role: SwarmTaskRole = 'worker',
  scope = 'repository',
) {
  return {
    taskId,
    role,
    objective: `Complete ${taskId}`,
    scope,
  };
}

function delegate(...children: readonly unknown[]) {
  return new AgentReply({ children });
}

function result(value: unknown, ...changeRefs: readonly string[]) {
  return new AgentReply(
    { result: value },
    changeRefs.length === 0 ? undefined : changeRefs,
  );
}

function review(findings: readonly unknown[] = []) {
  return new AgentReply({ reviewed: true, findings });
}

class AgentReply {
  constructor(
    readonly response: unknown,
    readonly changeRefs?: readonly string[],
  ) {}
}

function response(output: unknown): RuntimeExecResponse {
  return {
    status: 'success',
    result: { output },
  } as RuntimeExecResponse;
}
