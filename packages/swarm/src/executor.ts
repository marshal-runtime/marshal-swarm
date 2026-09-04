import type {
  InvocationContext,
  RuntimeExecResponse,
} from '@marshal/runtime';
const RUNTIME_PROTOCOL_VERSION = '1.0.0';
import {
  replaySwarmRun,
  swarmRunTargets,
  type SwarmJsonValue,
  type SwarmPauseReason,
  type SwarmRun,
  type SwarmRunTarget,
  type SwarmRunUpdateEvent,
  type SwarmTask,
  type SwarmTaskDefinition,
  type SwarmTaskRole,
} from './contracts.js';
import {
  getSwarmServiceContainer,
  type SwarmServiceContainer,
} from './service-container.js';
import {
  getSwarmSharedContextService,
  tryGetSwarmBaselineService,
  tryGetSwarmRoleModelService,
  type SwarmBaseline,
  type SwarmSharedContext,
} from './services.js';
import { createSwarmRunId } from './run-id.js';
import { publishSwarmRunView } from './view-publish.js';
import type {
  SwarmRunCancelInput,
  SwarmRunCreateInput,
  SwarmRunInput,
  SwarmRunPauseInput,
  SwarmSourceOptions,
} from './types.js';
import type { SwarmExecutionContext } from './types.js';

const TERMINAL_RUN_STATES = new Set(['done', 'failed']);

interface ExecutableTask {
  readonly task: SwarmTask;
  readonly childResults: readonly ChildResult[];
  readonly outstanding: readonly OutstandingChild[];
}

interface ChildResult {
  readonly taskId: string;
  readonly role: SwarmTaskRole;
  readonly result?: SwarmJsonValue;
  readonly error?: SwarmJsonValue;
  readonly changeRefs?: readonly string[];
}

interface OutstandingChild {
  readonly taskId: string;
  readonly role: SwarmTaskRole;
  readonly scope: string;
  readonly objective: string;
}

interface ChildDelegation {
  readonly definition: SwarmTaskDefinition;
  readonly refusal?: string;
}

const REVIEWER_CONTRACT_MESSAGE =
  'Reviewer results must be structured as {"reviewed":true,"findings":[...]}. '
  + 'Narration without that structure is a failed review.';

const REVIEW_RECURRENCE_MESSAGE =
  'Refused: this integrated change ref was already reviewed and no worker or '
  + 'reconciler change ref has advanced since the previous review.';

const DESCENDANT_INTEGRATION_REJECTION =
  'All descendant tasks must be terminal before integration.';

const ROOT_COMPLETION_RECONCILIATION_REJECTION =
  'Root completion requires reconciliation after the latest implementation.';
const DEFAULT_WORKER_MODEL = 'gpt-5.6-luna';
const DEFAULT_WORKER_REASONING_EFFORT = 'medium';

interface AgentLaunch {
  readonly ready: ExecutableTask;
  readonly delegationId?: string;
  readonly error?: string;
  readonly pauseReason?: SwarmPauseReason;
}

interface AgentOutcome {
  readonly ready: ExecutableTask;
  readonly result?: unknown;
  readonly changeRefs?: readonly string[];
  readonly error?: string;
}

interface SettledTask {
  readonly taskId: string;
  readonly outcome: AgentOutcome;
}

export class SwarmExecutor {
  private readonly serviceContainer: SwarmServiceContainer;
  private stateTransition = Promise.resolve();
  private readonly driveInFlight = new Map<string, Promise<SwarmRun>>();
  private readonly reuseCallerSessions = new Set<string>();
  private readonly viewInvocations = new Map<string, InvocationContext>();

  constructor(
    private readonly factory: SwarmExecutionContext,
    private readonly options: SwarmSourceOptions,
  ) {
    this.serviceContainer = options.serviceContainer
      ?? getSwarmServiceContainer();
  }

  async create(
    input: SwarmRunCreateInput,
    invocation: InvocationContext,
  ): Promise<SwarmRun> {
    const objective = requiredString(input.objective, 'objective');
    const scope = requiredString(
      input.scope ?? callerWorkspace(invocation),
      'scope',
    );
    const runId = optionalString(input.runId, 'runId')
      ?? createSwarmRunId(callerSessionId(invocation));
    const targetRef = optionalTrimmed(input.targetRef, 'targetRef');
    const targetHead = optionalTrimmed(input.targetHead, 'targetHead');
    const targets = input.targets === undefined
      ? undefined
      : normalizeTargets(input.targets);
    const workerModel = optionalString(input.workerModel, 'workerModel');
    const workerReasoningEffort = optionalString(
      input.workerReasoningEffort,
      'workerReasoningEffort',
    );
    const root: SwarmTaskDefinition = {
      taskId: 'root',
      role: 'planner',
      objective,
      scope,
    };
    if (input.fresh !== true) this.reuseCallerSessions.add(runId);
    this.viewInvocations.set(runId, invocation);
    await this.options.eventStore.create(
      runId,
      objective,
      scope,
      targetRef,
      targetHead,
      targets,
      ...(workerModel === undefined && workerReasoningEffort === undefined
        ? []
        : [{ workerModel, workerReasoningEffort }]),
    );
    await this.append(runId, [{ type: 'task.added', task: root }]);
    return this.requireRun(runId);
  }

  async get(input: SwarmRunInput): Promise<SwarmRun> {
    return this.requireRun(requiredString(input.runId, 'runId'));
  }

  async list(): Promise<readonly SwarmRun[]> {
    return Promise.all(
      (await this.options.eventStore.list()).map((runId) =>
        this.requireRun(runId)),
    );
  }

  async cancel(
    input: SwarmRunCancelInput,
    invocation: InvocationContext,
  ): Promise<SwarmRun> {
    const runId = requiredString(input.runId, 'runId');
    this.viewInvocations.set(runId, invocation);
    const reason = requiredString(input.reason, 'reason');
    let rootDelegationId: string | undefined;
    const run = await this.withStateTransition(async () => {
      const current = await this.requireRun(runId);
      if (TERMINAL_RUN_STATES.has(current.state)) return current;
      rootDelegationId = current.tasks.find(
        (task) => task.parentTaskId === undefined,
      )?.delegationId;
      await this.append(runId, [{ type: 'run.cancelled', error: reason }]);
      return this.requireRun(runId);
    });
    if (rootDelegationId) {
      await this.cancelAgent(rootDelegationId, invocation);
    }
    return rootDelegationId === undefined ? run : this.requireRun(runId);
  }

  async pause(
    input: SwarmRunPauseInput,
    invocation: InvocationContext,
  ): Promise<SwarmRun> {
    const runId = requiredString(input.runId, 'runId');
    this.viewInvocations.set(runId, invocation);
    return this.pauseRun(
      runId,
      {
        kind: 'manual',
        message: requiredString(input.reason, 'reason'),
      },
      invocation,
    );
  }

  async resume(
    input: SwarmRunInput,
    invocation: InvocationContext,
  ): Promise<SwarmRun> {
    const runId = requiredString(input.runId, 'runId');
    this.viewInvocations.set(runId, invocation);
    let resumed = false;
    const run = await this.withStateTransition(async () => {
      const current = await this.requireRun(runId);
      if (TERMINAL_RUN_STATES.has(current.state) || current.state === 'running') {
        return current;
      }
      assertResumableScopes(current);
      await this.append(runId, [{ type: 'run.resumed' }]);
      resumed = true;
      return this.requireRun(runId);
    });
    return resumed ? this.drive({ runId }, invocation) : run;
  }

  drive(
    input: SwarmRunInput,
    invocation: InvocationContext,
  ): Promise<SwarmRun> {
    const runId = requiredString(input.runId, 'runId');
    this.viewInvocations.set(runId, invocation);
    const existing = this.driveInFlight.get(runId);
    if (existing !== undefined) return existing;
    let drive!: Promise<SwarmRun>;
    drive = this.driveLoop(runId, invocation).finally(() => {
      if (this.driveInFlight.get(runId) === drive) {
        this.driveInFlight.delete(runId);
      }
    });
    this.driveInFlight.set(runId, drive);
    return drive;
  }

  private async driveLoop(
    runId: string,
    invocation: InvocationContext,
  ): Promise<SwarmRun> {
    const inFlight = new Map<string, Promise<SettledTask>>();
    const surfaced = new Map<string, number>();
    while (true) {
      const run = await this.requireRun(runId);
      if (TERMINAL_RUN_STATES.has(run.state)) return run;
      if (run.state === 'paused') return run;

      for (const ready of executableSwarmTasks(run)) {
        const taskId = ready.task.taskId;
        if (inFlight.has(taskId)) continue;
        const terminalCount = ready.childResults.length;
        if (terminalCount > 0) {
          if (terminalCount <= (surfaced.get(taskId) ?? 0)) continue;
          surfaced.set(taskId, terminalCount);
        }
        inFlight.set(
          taskId,
          this.settleTask(runId, run, ready, invocation).then((outcome) => ({
            taskId,
            outcome,
          })),
        );
      }

      if (inFlight.size === 0) {
        await this.finishRun(runId);
        return this.requireRun(runId);
      }

      const settled = await Promise.race(inFlight.values());
      inFlight.delete(settled.taskId);
      if (await this.stopped(runId)) return this.requireRun(runId);
      await this.recordOutcome(runId, settled.outcome);
      await this.finishRun(runId);
    }
  }

  private async settleTask(
    runId: string,
    run: SwarmRun,
    ready: ExecutableTask,
    invocation: InvocationContext,
  ): Promise<AgentOutcome> {
    let launch: AgentLaunch;
    try {
      launch = await this.launch(runId, run, ready, invocation);
    } catch (error) {
      const pauseReason = pauseReasonForError(
        error,
        ready.task.taskId,
      );
      if (pauseReason !== undefined) {
        await this.pauseRun(runId, pauseReason, invocation);
        return { ready, error: pauseReason.message };
      }
      return { ready, error: plainError(error) };
    }
    if (launch.pauseReason !== undefined) {
      await this.pauseRun(runId, launch.pauseReason, invocation);
      return { ready, error: launch.pauseReason.message };
    }
    if (!launch.delegationId) {
      return {
        ready,
        error: launch.error ?? 'Delegation did not start.',
      };
    }
    const current = await this.requireRun(runId);
    if (current.state === 'paused') {
      const pauseReason = current.pauseReason;
      if (pauseReason === undefined) {
        throw new Error(`Paused swarm run "${runId}" has no pause reason.`);
      }
      await this.pauseAgent(
        launch.delegationId,
        pauseReason.message,
        invocation,
      );
      return { ready, error: 'Run paused.' };
    }
    if (current.state !== 'running') {
      await this.cancelAgent(launch.delegationId, invocation);
      return { ready, error: 'Run stopped.' };
    }

    let delegation: Readonly<Record<string, unknown>> | undefined;
    try {
      delegation = await this.waitForAgent(launch.delegationId, invocation);
    } catch (error) {
      const pauseReason = pauseReasonForError(error, ready.task.taskId);
      if (pauseReason !== undefined) {
        await this.pauseRun(runId, pauseReason, invocation);
        return { ready, error: pauseReason.message };
      }
      throw new Error(
        `Waiting for delegation "${launch.delegationId}" for task `
          + `"${ready.task.taskId}" failed: ${plainError(error)}.`,
        { cause: error },
      );
    }
    while (delegation !== undefined && ready.task.role === 'planner') {
      const currentRun = await this.requireRun(runId);
      const validationError = plannerResponseValidationError(
        delegation,
        ready.task,
        currentRun,
      );
      if (validationError === undefined) break;
      if (currentRun.state === 'paused') {
        const pauseReason = currentRun.pauseReason;
        if (pauseReason === undefined) {
          throw new Error(`Paused swarm run "${runId}" has no pause reason.`);
        }
        await this.pauseAgent(
          launch.delegationId,
          pauseReason.message,
          invocation,
        );
        return { ready, error: 'Run paused.' };
      }
      if (currentRun.state !== 'running') {
        await this.cancelAgent(launch.delegationId, invocation);
        return { ready, error: 'Run stopped.' };
      }
      let correction: Readonly<Record<string, unknown>> | undefined;
      try {
        correction = await this.continueAgent(
          launch.delegationId,
          plannerCorrectionPrompt(validationError, currentRun, ready.task),
          invocation,
        );
      } catch (error) {
        const pauseReason = pauseReasonForError(error, ready.task.taskId);
        if (pauseReason !== undefined) {
          await this.pauseRun(runId, pauseReason, invocation);
          return { ready, error: pauseReason.message };
        }
        return {
          ready,
          error: `Correcting planner task "${ready.task.taskId}" failed: `
            + plainError(error),
        };
      }
      const correctionPauseReason = pauseReasonForError(
        correction?.error,
        ready.task.taskId,
      );
      if (correctionPauseReason !== undefined) {
        await this.pauseRun(runId, correctionPauseReason, invocation);
        return { ready, error: correctionPauseReason.message };
      }
      if (stringValue(correction?.delegationId) !== launch.delegationId) {
        return launchFailure(ready, correction, undefined, 'continue');
      }
      try {
        delegation = await this.waitForAgent(
          launch.delegationId,
          invocation,
        );
      } catch (error) {
        const pauseReason = pauseReasonForError(error, ready.task.taskId);
        if (pauseReason !== undefined) {
          await this.pauseRun(runId, pauseReason, invocation);
          return { ready, error: pauseReason.message };
        }
        throw new Error(
          `Waiting for corrected delegation "${launch.delegationId}" `
            + `for task "${ready.task.taskId}" failed: ${plainError(error)}.`,
          { cause: error },
        );
      }
    }
    const diskFullReason = diskFullPauseReason(
      delegation?.error,
      ready.task.taskId,
    );
    if (diskFullReason !== undefined) {
      await this.pauseRun(runId, diskFullReason, invocation);
      return { ready, error: diskFullReason.message };
    }
    const state = stringValue(delegation?.state) ?? 'failed';
    const changeRefs = optionalChangeRefs(delegation?.changeRefs);
    if (completionRejectedForLiveDescendant(delegation?.error)) {
      return {
        ready,
        error: DESCENDANT_INTEGRATION_REJECTION,
        ...(changeRefs === undefined ? {} : { changeRefs }),
      };
    }
    if (state !== 'done') {
      return {
        ready,
        error: errorText(
          delegation?.error,
          `Agent for task "${ready.task.taskId}" returned ${state}.`,
        ),
        ...(changeRefs === undefined ? {} : { changeRefs }),
      };
    }
    return {
      ready,
      result: delegation?.result,
      ...(changeRefs === undefined ? {} : { changeRefs }),
    };
  }

  private async launch(
    runId: string,
    run: SwarmRun,
    ready: ExecutableTask,
    invocation: InvocationContext,
  ): Promise<AgentLaunch> {
    const task = ready.task;
    const fieldGuide = await getSwarmSharedContextService(
      this.serviceContainer,
    ).read(runId);
    const baseline = await tryGetSwarmBaselineService(this.serviceContainer)
      ?.resolve(runId, task.scope);
    const prompt = promptFor(
      ready,
      fieldGuide,
      run,
      baseline,
    );
    if (task.state === 'pending') {
      return this.withStateTransition(async () => {
        const currentRun = await this.requireRun(runId);
        if (currentRun.state !== 'running') {
          return { ready, error: 'Run stopped.' };
        }
        const currentTask = currentRun.tasks.find(
          (entry) => entry.taskId === task.taskId,
        );
        if (currentTask === undefined) {
          return { ready, error: `Task "${task.taskId}" no longer exists.` };
        }
        if (
          currentTask.state === 'running'
          && currentTask.delegationId !== undefined
        ) {
          return {
            ready: { ...ready, task: currentTask },
            delegationId: currentTask.delegationId,
          };
        }
        if (currentTask.state !== 'pending') {
          return {
            ready: { ...ready, task: currentTask },
            error: `Task "${task.taskId}" is no longer executable.`,
          };
        }
        return this.spawnTask(
          runId,
          currentRun,
          ready,
          currentTask,
          prompt,
          baseline,
          invocation,
        );
      });
    }

    if ((await this.requireRun(runId)).state !== 'running') {
      return { ready, error: 'Run stopped.' };
    }

    const delegationId = requiredString(
      task.delegationId,
      `Task "${task.taskId}" delegationId`,
    );
    if (ready.childResults.length > 0) {
      const continued = await this.continueAgent(
        delegationId,
        prompt,
        invocation,
      );
      const pauseReason = pauseReasonForError(continued, task.taskId);
      if (pauseReason !== undefined) {
        return {
          ready,
          error: errorText(
            recordOf(continued)?.error,
            pauseReason.message,
          ),
          pauseReason,
        };
      }
      if (completionRejectedForLiveDescendant(continued?.error)) {
        // Failed delegations cannot continue. Wait for the final child so the
        // replacement planner receives one complete outcome set.
        if (ready.outstanding.length > 0) {
          return { ready, error: DESCENDANT_INTEGRATION_REJECTION };
        }
        return this.replaceRejectedPlanner(
          runId,
          ready,
          delegationId,
          prompt,
          baseline,
          invocation,
        );
      }
      if (stringValue(continued?.delegationId) !== delegationId) {
        return launchFailure(ready, continued, undefined, 'continue');
      }
      return { ready, delegationId };
    }

    return { ready, delegationId };
  }

  private replaceRejectedPlanner(
    runId: string,
    ready: ExecutableTask,
    rejectedDelegationId: string,
    prompt: string,
    baseline: SwarmBaseline | undefined,
    invocation: InvocationContext,
  ): Promise<AgentLaunch> {
    return this.withStateTransition(async () => {
      const currentRun = await this.requireRun(runId);
      if (currentRun.state !== 'running') {
        return { ready, error: 'Run stopped.' };
      }
      const currentTask = currentRun.tasks.find(
        (entry) => entry.taskId === ready.task.taskId,
      );
      if (
        currentTask === undefined
        || currentTask.state !== 'running'
        || currentTask.delegationId === undefined
      ) {
        return {
          ready,
          error: `Task "${ready.task.taskId}" is no longer executable.`,
        };
      }
      if (currentTask.delegationId !== rejectedDelegationId) {
        return {
          ready: { ...ready, task: currentTask },
          delegationId: currentTask.delegationId,
        };
      }
      return this.spawnTask(
        runId,
        currentRun,
        ready,
        currentTask,
        prompt,
        baseline,
        invocation,
      );
    });
  }

  private async spawnTask(
    runId: string,
    run: SwarmRun,
    ready: ExecutableTask,
    task: SwarmTask,
    prompt: string,
    baseline: SwarmBaseline | undefined,
    invocation: InvocationContext,
  ): Promise<AgentLaunch> {
    const parentDelegationId = task.parentTaskId === undefined
      ? undefined
      : run.tasks.find(
          (entry) => entry.taskId === task.parentTaskId,
        )?.delegationId;
    const serviceRoleModel = tryGetSwarmRoleModelService(
      this.serviceContainer,
    )?.resolve(task.role, run);
    const roleModel = task.role === 'worker'
      ? {
          model: run.workerModel
            ?? serviceRoleModel?.model
            ?? DEFAULT_WORKER_MODEL,
          reasoningEffort: run.workerReasoningEffort
            ?? serviceRoleModel?.reasoningEffort
            ?? DEFAULT_WORKER_REASONING_EFFORT,
        }
      : serviceRoleModel;
    const callerSession = optionalCallerSessionId(invocation);
    const spawned = await this.delegationCall(
      'runtime.delegation.spawn',
      {
        prompt,
        scope: task.scope,
        role: task.role,
        workspaceMode: task.role === 'planner' ? 'shared' : 'isolated',
        ...(roleModel?.model === undefined
          ? {}
          : { model: roleModel.model }),
        ...(roleModel?.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: roleModel.reasoningEffort }),
        ...(parentDelegationId === undefined ? {} : { parentDelegationId }),
        ...(baseline?.head === undefined ? {} : { baseRef: baseline.head }),
        ...(this.reuseCallerSessions.has(runId)
          && task.parentTaskId === undefined
          && callerSession
          ? { backend: callerSession }
          : {}),
      },
      invocation,
    );
    const delegation = recordOf(spawned.result?.output);
    const spawnError = delegation?.error ?? spawned.error;
    const pauseReason = pauseReasonForError(spawnError, task.taskId);
    if (pauseReason !== undefined) {
      return {
        ready,
        error: errorText(
          spawnError,
          `Delegation could not provision a workspace for task "${task.taskId}".`,
        ),
        pauseReason,
      };
    }
    const delegationId = stringValue(delegation?.delegationId);
    if (!delegationId) {
      return launchFailure(ready, delegation, spawned.error, 'start');
    }
    await this.append(runId, [{
      type: 'task.started',
      taskId: task.taskId,
      delegationId,
    }]);
    return { ready: { ...ready, task }, delegationId };
  }

  private async waitForAgent(
    delegationId: string,
    invocation: InvocationContext,
  ): Promise<Readonly<Record<string, unknown>> | undefined> {
    const response = await this.delegationCall(
      'runtime.delegation.wait',
      { delegationId },
      invocation,
    );
    return recordOf(response.result?.output)
      ?? (response.error === undefined ? undefined : { error: response.error });
  }

  private async continueAgent(
    delegationId: string,
    prompt: string,
    invocation: InvocationContext,
  ): Promise<Readonly<Record<string, unknown>> | undefined> {
    const response = await this.delegationCall(
      'runtime.delegation.continue',
      { delegationId, prompt },
      invocation,
    );
    return recordOf(response.result?.output)
      ?? (response.error === undefined ? undefined : { error: response.error });
  }

  private async recordOutcome(
    runId: string,
    outcome: AgentOutcome,
  ): Promise<void> {
    if (await this.stopped(runId)) return;
    const run = await this.requireRun(runId);
    const task = run.tasks.find(
      (entry) => entry.taskId === outcome.ready.task.taskId,
    );
    if (task === undefined
      || task.state === 'done'
      || task.state === 'failed') {
      return;
    }
    if (completionRejectedForLiveDescendant(outcome.error)) return;
    if (outcome.error !== undefined) {
      await this.failTask(runId, task, outcome.error, outcome.changeRefs);
      return;
    }
    if (task.state !== 'running') return;

    let response: Readonly<Record<string, unknown>>;
    let children: readonly ChildDelegation[] | undefined;
    try {
      response = parseAgentResponse(outcome.result);
      children = validateChildren(response, task, run);
    } catch (error) {
      await this.failTask(runId, task, plainError(error), outcome.changeRefs);
      return;
    }

    if (children !== undefined) {
      const events = children.flatMap((child): SwarmRunUpdateEvent[] => {
        const added: SwarmRunUpdateEvent = {
          type: 'task.added',
          task: child.definition,
        };
        return child.refusal === undefined
          ? [added]
          : [added, {
              type: 'task.failed',
              taskId: child.definition.taskId,
              error: child.refusal,
            }];
      });
      await this.appendWhileRunning(runId, events);
      return;
    }

    if (task.role === 'reviewer' && reviewerVerdict(response) === undefined) {
      await this.failTask(
        runId,
        task,
        REVIEWER_CONTRACT_MESSAGE,
        outcome.changeRefs,
      );
      return;
    }

    const hasLiveChild = run.tasks.some(
      (entry) => entry.parentTaskId === task.taskId
        && (entry.state === 'pending' || entry.state === 'running'),
    );
    if (hasLiveChild) {
      // Partial re-entry decision turn: a planner may react and delegate while
      // its children run, but may not complete while any child is still live.
      // The delegation stays idle and is re-continued when more children finish.
      return;
    }

    await this.appendWhileRunning(runId, [{
      type: 'task.completed',
      taskId: task.taskId,
      result: completionResult(response),
      ...(reviewCompletionChangeRefs(task, run, outcome.changeRefs) === undefined
        ? {}
        : {
            changeRefs: reviewCompletionChangeRefs(task, run, outcome.changeRefs),
          }),
    }]);
  }

  private async failTask(
    runId: string,
    task: SwarmTask,
    error: string,
    changeRefs?: readonly string[],
  ): Promise<void> {
    await this.appendWhileRunning(runId, [{
      type: 'task.failed',
      taskId: task.taskId,
      error,
      ...(changeRefs === undefined ? {} : { changeRefs }),
    }]);
  }

  private async finishRun(
    runId: string,
  ): Promise<void> {
    await this.withStateTransition(async () => {
      const run = await this.requireRun(runId);
      if (TERMINAL_RUN_STATES.has(run.state) || run.state === 'paused') return;
      const root = run.tasks.find((task) => task.parentTaskId === undefined);
      if (!root) {
        await this.append(runId, [{
          type: 'run.failed',
          error: 'Run has no root task.',
        }]);
        return;
      }
      if (root.state === 'failed') {
        await this.append(runId, [{
          type: 'run.failed',
          error: root.error ?? 'Root task failed.',
        }]);
        return;
      }
      if (root.state !== 'done') return;

      await this.append(runId, [{
        type: 'run.completed',
        ...(root.result === undefined ? {} : { result: root.result }),
      }]);
    });
  }

  private async requireRun(runId: string): Promise<SwarmRun> {
    const run = replaySwarmRun(await this.options.eventStore.read(runId));
    return run;
  }

  private async append(
    runId: string,
    events: readonly SwarmRunUpdateEvent[],
  ): Promise<void> {
    for (const event of events) {
      await this.options.eventStore.append(runId, event);
    }
    await this.publishView(runId);
  }

  private async publishView(runId: string): Promise<void> {
    const invocation = this.viewInvocations.get(runId);
    if (!invocation) return;
    await publishSwarmRunView(await this.requireRun(runId), invocation, (request, context) =>
      this.factory.execute(request, context));
  }

  private async stopped(runId: string): Promise<boolean> {
    return (await this.requireRun(runId)).state !== 'running';
  }

  private appendWhileRunning(
    runId: string,
    events: readonly SwarmRunUpdateEvent[],
  ): Promise<void> {
    return this.withStateTransition(async () => {
      if ((await this.requireRun(runId)).state !== 'running') return;
      await this.append(runId, events);
    });
  }

  private pauseRun(
    runId: string,
    reason: SwarmPauseReason,
    invocation: InvocationContext,
  ): Promise<SwarmRun> {
    return this.withStateTransition(async () => {
      const run = await this.requireRun(runId);
      if (TERMINAL_RUN_STATES.has(run.state) || run.state === 'paused') {
        return run;
      }

      await this.append(runId, [{
        type: 'run.paused',
        reason,
      }]);
      const paused = await this.requireRun(runId);
      const delegationIds = new Set(
        paused.tasks.flatMap((task) =>
          task.state === 'running' && task.delegationId !== undefined
            ? [task.delegationId]
            : []),
      );
      await Promise.all(
        [...delegationIds].map((delegationId) =>
          this.pauseAgent(delegationId, reason.message, invocation)),
      );
      return this.requireRun(runId);
    });
  }

  private async withStateTransition<T>(action: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.stateTransition;
    this.stateTransition = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await action();
    } finally {
      release();
    }
  }

  private pauseAgent(
    delegationId: string,
    reason: string,
    invocation: InvocationContext,
  ): Promise<RuntimeExecResponse> {
    return this.delegationCall(
      'runtime.delegation.pause',
      { delegationId, reason },
      invocation,
    );
  }

  private cancelAgent(
    delegationId: string,
    invocation: InvocationContext,
  ): Promise<RuntimeExecResponse> {
    return this.delegationCall(
      'runtime.delegation.cancel',
      { delegationId, recursive: true },
      invocation,
    );
  }

  private delegationCall(
    operation: string,
    input: unknown,
    invocation: InvocationContext,
  ): Promise<RuntimeExecResponse> {
    const request = {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      targetType: 'operation' as const,
      target: operation,
      input,
      approval: invocation.approval,
    };
    return this.factory.execute(request, invocation);
  }
}

function launchFailure(
  ready: ExecutableTask,
  delegation: Readonly<Record<string, unknown>> | undefined,
  operationError: unknown,
  action: 'start' | 'continue',
): AgentLaunch {
  return {
    ready,
    error: errorText(
      delegation?.error ?? operationError,
      `Delegation did not ${action} task "${ready.task.taskId}".`,
    ),
  };
}

function executableSwarmTasks(run: SwarmRun): readonly ExecutableTask[] {
  if (run.state !== 'running') return [];
  const childrenByParent = new Map<string, SwarmTask[]>();
  for (const task of run.tasks) {
    if (task.parentTaskId === undefined) continue;
    const children = childrenByParent.get(task.parentTaskId) ?? [];
    children.push(task);
    childrenByParent.set(task.parentTaskId, children);
  }

  return run.tasks.flatMap((task): ExecutableTask[] => {
    const children = childrenByParent.get(task.taskId) ?? [];
    if (task.state === 'pending') {
      return children.length === 0
        ? [{ task, childResults: [], outstanding: [] }]
        : [];
    }
    if (task.state !== 'running' || task.delegationId === undefined) return [];
    if (children.length === 0) {
      return [{ task, childResults: [], outstanding: [] }];
    }
    const terminal = children.filter(isTerminalTask);
    if (terminal.length === 0) return [];
    return [{
      task,
      childResults: terminal.map((child) => ({
        taskId: parentLocalTaskId(task.taskId, child.taskId),
        role: child.role,
        ...(child.result === undefined ? {} : { result: child.result }),
        ...(child.error === undefined ? {} : { error: child.error }),
        ...(child.changeRefs === undefined
          ? {}
          : { changeRefs: child.changeRefs }),
      })),
      outstanding: children
        .filter((child) => !isTerminalTask(child))
        .map((child) => ({
          taskId: parentLocalTaskId(task.taskId, child.taskId),
          role: child.role,
          scope: child.scope,
          objective: child.objective,
        })),
    }];
  });
}

function isTerminalTask(task: SwarmTask): boolean {
  return task.state === 'done' || task.state === 'failed';
}

function plannerResponseValidationError(
  delegation: Readonly<Record<string, unknown>>,
  task: SwarmTask,
  run: SwarmRun,
): string | undefined {
  if (stringValue(delegation.state) !== 'done') return undefined;
  try {
    const response = parseAgentResponse(delegation.result);
    validateChildren(response, task, run);
    return undefined;
  } catch (error) {
    const message = plainError(error);
    return message.includes('not one of the run\'s declared repository targets')
      ? undefined
      : message;
  }
}

function plannerCorrectionPrompt(
  validationError: string,
  run: SwarmRun,
  task: SwarmTask,
): string {
  return [
    '## Correction required',
    '',
    `Your previous planner response was rejected: ${validationError}`,
    `Permitted repository scope names for this run: ${permittedScopeNames(run, task).join(', ')}.`,
    'Return one corrected planner response only. Preserve the original objective and ownership. For delegation, use the response interface shape and a permitted scope.',
    'Do not change the requested ownership or use a scope name outside the permitted names.',
  ].join('\n');
}

function permittedScopeNames(
  run: SwarmRun,
  task: SwarmTask,
): readonly string[] {
  const targets = declaredTargetScopes(run);
  return [...(targets ?? new Set([task.scope]))];
}

function permittedScopeForExample(run: SwarmRun, task: SwarmTask): string {
  const scopes = permittedScopeNames(run, task);
  return scopes.includes(task.scope) ? task.scope : scopes[0]!;
}

function plannerDelegationExample(
  run: SwarmRun,
  task: SwarmTask,
): string {
  const scope = permittedScopeForExample(run, task);
  return JSON.stringify({
    children: [
      {
        role: 'worker',
        taskId: 'api',
        objective: 'Implement the API lane in your assigned checkout, changing a relative implementation path; use any explicitly named external Runtime path only as a read-only reference.',
        scope,
      },
      {
        role: 'worker',
        taskId: 'research',
        objective: 'Research and rank compatibility options in your assigned checkout, returning a concise recommendation and preserving the repository identity/ref handoff.',
        scope,
      },
    ],
  });
}

function validateChildren(
  response: Readonly<Record<string, unknown>>,
  parent: SwarmTask,
  run: SwarmRun,
): readonly ChildDelegation[] | undefined {
  if (!('children' in response)) {
    return undefined;
  }
  if (parent.role !== 'planner') {
    throw new TypeError(
      `Task "${parent.taskId}" has role "${parent.role}" and may not delegate children.`,
    );
  }
  if (!Array.isArray(response.children)) {
    throw new TypeError('Planner children must be an array.');
  }
  if (response.children.length === 0) return undefined;

  const targetScopes = declaredTargetScopes(run);
  const declaredIds = new Set<string>();
  const taken = new Set(run.tasks.map((task) => task.taskId));
  const reviewerRefusal = reviewerRecurrenceRefused(parent, run)
    ? REVIEW_RECURRENCE_MESSAGE
    : undefined;

  return response.children.map((value, index): ChildDelegation => {
    const child = requiredRecord(value, `children[${index}]`);
    const localTaskId = requiredString(
      child.taskId,
      `children[${index}].taskId`,
    );
    if (declaredIds.has(localTaskId)) {
      throw new TypeError(`Task "${localTaskId}" is declared more than once.`);
    }
    declaredIds.add(localTaskId);
    const objective = requiredString(
      child.objective,
      `children[${index}].objective`,
    );
    const role = requiredRole(child.role, `children[${index}].role`);
    const scope = requiredString(child.scope, `children[${index}].scope`);
    if (targetScopes !== undefined && !targetScopes.has(scope)) {
      throw new TypeError(
        `Task "${localTaskId}" scope "${scope}" is not one of the run's declared repository targets.`,
      );
    }
    const taskId = allocateChildTaskId(parent.taskId, localTaskId, taken);
    taken.add(taskId);
    const definition: SwarmTaskDefinition = {
      taskId,
      parentTaskId: parent.taskId,
      role,
      objective,
      scope,
    };
    return role === 'reviewer' && reviewerRefusal !== undefined
      ? { definition, refusal: reviewerRefusal }
      : { definition };
  });
}

function declaredTargetScopes(run: SwarmRun): Set<string> | undefined {
  const targets = swarmRunTargets(run);
  if (targets.length === 0) return undefined;
  return new Set(targets.map((target) => target.scope));
}

function optionalTrimmed(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : requiredString(value, label);
}

function normalizeTargets(value: unknown): readonly SwarmRunTarget[] {
  if (!Array.isArray(value)) {
    throw new TypeError('targets must be an array.');
  }
  return value.map((entry, index): SwarmRunTarget => ({
    scope: requiredString(recordOf(entry)?.scope, `targets[${index}].scope`),
    ref: requiredString(recordOf(entry)?.ref, `targets[${index}].ref`),
    head: requiredString(recordOf(entry)?.head, `targets[${index}].head`),
  }));
}

function assertResumableScopes(run: SwarmRun): void {
  const scopes = declaredTargetScopes(run);
  if (scopes === undefined) return;
  for (const task of run.tasks) {
    if (!scopes.has(task.scope)) {
      throw new TypeError(
        `Run "${run.runId}" cannot resume: task "${task.taskId}" scope `
        + `"${task.scope}" is not one of the declared repository targets.`,
      );
    }
  }
}

function allocateChildTaskId(
  parentTaskId: string,
  localTaskId: string,
  taken: ReadonlySet<string>,
): string {
  const base = childTaskId(parentTaskId, localTaskId);
  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix++) {
    const candidate = childTaskId(parentTaskId, `${localTaskId}#${suffix}`);
    if (!taken.has(candidate)) return candidate;
  }
}

function reviewerRecurrenceRefused(parent: SwarmTask, run: SwarmRun): boolean {
  const direct = run.tasks.filter(
    (task) => task.parentTaskId === parent.taskId,
  );
  const reviewers = direct.filter(
    (task) => task.role === 'reviewer' && task.state === 'done',
  );
  if (reviewers.length === 0) return false;
  const reviewedRefs = new Set(
    reviewers.flatMap((reviewer) => reviewer.changeRefs ?? []),
  );
  const implementationRefs = direct
    .filter((task) =>
      (task.role === 'worker' || task.role === 'reconciler')
      && isTerminalTask(task))
    .flatMap((task) => task.changeRefs ?? []);
  return implementationRefs.length === 0
    || implementationRefs.every((changeRef) => reviewedRefs.has(changeRef));
}

function implementationChangeRefs(
  run: SwarmRun,
  reviewer: SwarmTask,
): readonly string[] {
  return run.tasks
    .filter((task) =>
      task.parentTaskId === reviewer.parentTaskId
      && (task.role === 'worker' || task.role === 'reconciler')
      && isTerminalTask(task))
    .flatMap((task) => task.changeRefs ?? []);
}

function reviewCompletionChangeRefs(
  task: SwarmTask,
  run: SwarmRun,
  outcomeChangeRefs: readonly string[] | undefined,
): readonly string[] | undefined {
  if (task.role !== 'reviewer') return outcomeChangeRefs;
  const refs = implementationChangeRefs(run, task);
  if (refs.length === 0) return outcomeChangeRefs;
  return [...new Set([...refs, ...(outcomeChangeRefs ?? [])])];
}

function reviewerVerdict(
  response: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> | undefined {
  const candidates = [response];
  const inner = recordOf(response.result);
  if (inner !== undefined) candidates.push(inner);
  for (const candidate of candidates) {
    if (candidate.reviewed === true && Array.isArray(candidate.findings)) {
      return candidate;
    }
  }
  return undefined;
}

function childTaskId(parentTaskId: string, localTaskId: string): string {
  return `${parentTaskId}/${encodeURIComponent(localTaskId)}`;
}

function parentLocalTaskId(parentTaskId: string, taskId: string): string {
  const prefix = `${parentTaskId}/`;
  if (!taskId.startsWith(prefix)) return taskId;
  return decodeURIComponent(taskId.slice(prefix.length));
}

function completionResult(
  response: Readonly<Record<string, unknown>>,
): SwarmJsonValue {
  return asJson('result' in response ? response.result : response, 'Agent result');
}

function promptFor(
  ready: ExecutableTask,
  fieldGuide: SwarmSharedContext,
  run: SwarmRun,
  baseline?: SwarmBaseline,
): string {
  const task = ready.task;
  const childOutcomes = ready.childResults.map((child) => ({
    taskId: child.taskId,
    role: child.role,
    ...(child.result === undefined ? {} : { result: child.result }),
    ...(child.error === undefined ? {} : { error: child.error }),
    changeRefs: child.changeRefs ?? [],
  }));
  const fieldGuidePath = requiredString(fieldGuide.path, 'Field Guide path');
  if (typeof fieldGuide.content !== 'string') {
    throw new TypeError('Field Guide content must be a string.');
  }
  const nodePosition = task.parentTaskId === undefined ? 'root' : 'descendant';
  const turnPhase = childOutcomes.length === 0
    ? 'initial'
    : 'resumed with direct child outcomes';
  const scopeTarget = swarmRunTargets(run).find(
    (target) => target.scope === task.scope,
  );
  const targetRef = scopeTarget?.ref ?? run.targetRef ?? 'not recorded';
  const targetHead = scopeTarget?.head ?? run.targetHead ?? 'not recorded';
  return [
    '# Current swarm task',
    '',
    `- Node: ${nodePosition}`,
    `- Turn: ${turnPhase}`,
    `- Role: ${task.role}`,
    `- Repository scope: ${task.scope}`,
    `- Original target ref: ${targetRef}`,
    `- Original target head: ${targetHead}`,
    `- Latest integration baseline ref: ${baseline?.ref ?? 'not resolved'}`,
    `- Latest integration baseline head: ${baseline?.head ?? 'not resolved'}`,
    `- Baseline ref: ${baseline?.ref ?? 'not resolved'}`,
    `- Baseline head: ${baseline?.head ?? 'not resolved'}`,
    `- Scope target ref: ${targetRef}`,
    `- Scope target head: ${targetHead}`,
    '',
    ...(task.parentTaskId === undefined
      ? []
      : [
          '## Overall swarm goal (context only)',
          '',
          run.objective,
          '',
          'This supplies the original constraints and acceptance context; it does not authorize work outside this task or its repository scope.',
          '',
        ]),
    '## Objective',
    '',
    task.objective,
    '',
    '## Direct child outcomes',
    '',
    JSON.stringify(childOutcomes),
    '',
    ...siblingRosterSection(task, run),
    ...outstandingSection(ready.outstanding),
    '## Shared Field Guide',
    '',
    `- Absolute path: ${fieldGuidePath}`,
    '',
    '--- FIELD GUIDE START ---',
    fieldGuide.content,
    '--- FIELD GUIDE END ---',
    '',
    ...topicSections(fieldGuide),
    'Read the Field Guide for concise durable design decisions and surprising repository facts.',
    'Only the planner ownership rules below permit editing any Field Guide file.',
    '',
    '## Role contract',
    '',
    ...roleInstructions(task),
    '',
    '## Response interface',
    '',
    ...(task.role === 'planner'
      ? [
          'To delegate, return only this JSON shape:',
          JSON.stringify({
            children: [{
              role: 'worker',
              taskId: 'stable-unique-id',
              objective: 'owned outcome, user constraints and acceptance conditions, repository/ref handoffs, relative implementation paths, and explicit lens or change refs when applicable',
              scope: permittedScopeForExample(run, task),
            }],
          }),
          '',
          'Allowed child roles are planner, worker, reconciler, and reviewer.',
          `Permitted repository scope names for this run: ${permittedScopeNames(run, task).join(', ')}.`,
          `Positive parallel-lanes example: ${plannerDelegationExample(run, task)}`,
          'Every child requires role, taskId, objective, and exactly one repository scope. Never return delegation JSON and a completion result together.',
          'Preserve task-specific constraints and acceptance conditions, including repository/ref handoffs, relative implementation paths, and read-only external references; the supplied overall goal is additional context, not a broader work assignment.',
          'You may delegate again on any resumed turn while children remain outstanding, but you may not complete while any child is still live.',
          'When every direct child has finished and the owned outcome is assembled, return a normal JSON-safe result instead.',
        ]
      : task.role === 'reviewer'
        ? [
            'Return only this JSON shape: {"reviewed":true,"findings":[...]}.',
            'findings is an array of concrete, actionable findings; an empty array means no findings.',
            'Narration without that structure is treated as a failed review.',
          ]
        : [
            'This role may not return children. Return only a normal JSON-safe result with the completed outcome, concrete findings, or a plain blocker.',
          ]),
  ].join('\n');
}

function siblingRosterSection(task: SwarmTask, run: SwarmRun): string[] {
  const parentTaskId = task.parentTaskId;
  if (parentTaskId === undefined) return [];
  const siblings = run.tasks.filter(
    (entry) => entry.parentTaskId === parentTaskId
      && entry.taskId !== task.taskId
      && !isTerminalTask(entry),
  );
  if (siblings.length === 0) return [];
  const roster = siblings.map((sibling) => ({
    taskId: parentLocalTaskId(parentTaskId, sibling.taskId),
    role: sibling.role,
    scope: sibling.scope,
    state: sibling.state,
    objective: sibling.objective,
  }));
  return [
    '## Sibling ownership',
    '',
    'These tasks share your parent. Do not decide or redefine a shared '
    + 'interface or exported symbol another sibling owns; defer any shared '
    + 'contract to your nearest common planner.',
    JSON.stringify(roster),
    '',
  ];
}

function outstandingSection(outstanding: readonly OutstandingChild[]): string[] {
  if (outstanding.length === 0) return [];
  return [
    '## Outstanding children',
    '',
    'These direct children are still live. You may react to the outcomes above '
    + 'and delegate more work, but you may not complete while any child remains '
    + 'outstanding.',
    JSON.stringify(outstanding),
    '',
  ];
}

function topicSections(fieldGuide: SwarmSharedContext): string[] {
  const topics = fieldGuide.topics ?? [];
  return topics.flatMap((topic) => {
    const path = requiredString(topic.path, 'Field Guide topic path');
    if (typeof topic.content !== 'string') {
      throw new TypeError('Field Guide topic content must be a string.');
    }
    return [
      `--- FIELD GUIDE TOPIC: ${path} ---`,
      topic.content,
      '--- FIELD GUIDE TOPIC END ---',
      '',
    ];
  });
}

const ROLE_INSTRUCTIONS: Readonly<
  Record<SwarmTaskRole, readonly string[]>
> = {
  planner: [
    'Own material architecture and shared-contract decisions before delegating implementation; then delegate coherent outcomes without editing implementation files yourself.',
    'If substantial design remains unresolved, delegate it to a planner child that resolves the design and delegates its implementation; routine implementation choices remain with workers.',
    'An architectural designer is a planner: it must resolve architecture and delegate implementation, and may not terminate as a leaf.',
    'Choose boundaries by coherent outcomes and independent decision lanes, not by file count or a one-worker-per-file rule.',
    'Good delegation identifies independent outcomes promptly and may use parallel lanes; use the run-specific permitted scope names shown in the response interface rather than copying a scope literal from an example.',
    'For example, a planner may resolve the shared storage contract first, then delegate one worker to implement the cohesive library and extension against it.',
    'Normally assign each coherent implementation outcome to one worker, even when it spans related files, helpers, exports, and tests; do not split merely to create smaller leaves.',
    'When sibling subtrees genuinely share a TypeScript interface or exported symbol, decide that contract here at the nearest common planner, record it in your owned topic file, and assign one owner to land it before dependent work. A separate boundary-only worker is optional, not mandatory; a coherent implementation worker may own the boundary when that is the useful outcome. Never implement it yourself and never let two subtrees decide or redefine the same exported contract.',
    'Use planner children only when a material design or architecture decision remains unresolved or implementation lanes are genuinely independent.',
    'Do not perform exhaustive repository or node_modules inventories. Inspect only enough to define owned outcomes and concrete boundaries.',
    'Give children disjoint decision ownership, include every relevant Field Guide decision, user constraint, acceptance condition, repository identity/ref, and relative implementation paths in their objectives. Children edit only their assigned checkout; name external source paths as read-only references and keep each child within one repository scope. All delegated work, including repairs, is returned through this children response interface with the appropriate planner, worker, reviewer, or reconciler role; native task, fleet, agent, or CLI spawning tools are not alternate Swarm delegation.',
    'For example, if an executable repair is needed, return a worker child for that repair with its relative paths and acceptance conditions; the executor creates and tracks it.',
    'For executable outcomes, assign the original required end-to-end check to a coherent worker outcome and claim completion only when its acceptance is achieved; report any remaining limitation when blocked.',
    'A planner checkout may remain at an older revision than the latest integration baseline. Missing files there do not prove missing integration: inspect the supplied latest baseline ref/head and child-ref ancestry or containment before requesting reconciliation, reuse actual child verification for the same integrated ref, and repeat it only for relevant changes or missing coverage.',
    'Never merge sibling work. Use a neutral reconciler only when sibling refs genuinely need integration, a real conflict or missing integration must be resolved, or neutral resolution is otherwise needed; do not create one solely to re-cherry-pick a single usable patch.',
    'Request decorrelated read-only review lenses for an integrated subtree once its change ref has advanced, using judgment and risk rather than a mandatory cadence or fixed set of lenses.',
    'Triage review findings once; delegate only actionable repairs. Fold repairs into the next review of an advanced change ref rather than creating an automatic review or reconcile cycle for each repair.',
    'Report capacity, session, worktree, or tooling failures upward; do not answer them with replacement child fan-out.',
    'When a focused intentional core break is worthwhile, return the rationale for durable curation and delegate downstream repair leaves rather than preserving ossified behavior.',
  ],
  worker: [
    'Implement the coherent owned outcome, including its related files, helpers, exports, and tests; do not delegate or merge sibling work.',
    'Perform repository edits and Git operations in your assigned working directory/worktree. Translate original or canonical repository paths to equivalent paths there; explicit external source references may be read, but do not write to another checkout.',
    'For an executable outcome, run the smallest actual user-requested end-to-end check in the real host and report the command and result plainly; syntax checks or guessed/static outputs are not substitutes. Own ordinary failures within your scope by fixing and rerunning the same check; report only concrete blockers outside your ability or authority, and do not claim completion until the objective acceptance is achieved.',
    'When your objective names a shared interface or exported symbol owned by another task, import that named symbol; never redefine or re-export it. If it has not landed yet, return a plain blocker instead of inventing your own.',
    'When your objective is a boundary task, land exactly the exported TypeScript interface or symbol named in the objective so siblings can import it; do not implement unrelated behavior in the same task.',
    'A research objective returns ranked options, evidence, and a recommendation; it may also write a concise durable report artifact outside the Field Guide and return its short path or link. It must not introduce any new exported symbol or edit implementation files.',
    'Research is a worker role: use role "worker" with a research objective; do not invent a separate leaf role.',
    'Never edit the Field Guide. If a genuinely bloated or high-contention megafile blocks safe work, return its path and reason without adding more code to it.',
    'A focused intentional core break is allowed when the objective requires it. Return the rationale to the parent planner.',
    'Implement the owned outcome or report the concrete blocker that prevents it. The runtime carries your ordinary change reference separately.',
  ],
  reconciler: [
    'Act as a neutral integrator; do not delegate and do not favor any sibling implementation.',
    'Perform repository edits and Git operations in your assigned working directory/worktree. Translate original or canonical repository paths to equivalent paths there; explicit external source references may be read, but do not write to another checkout.',
    'Apply the sibling change refs named in the objective in this fresh worktree, resolve conflicts impartially, and commit one integrated result.',
    'When assigned as the root reconciler, apply only named implementation refs not already contained in the latest integration baseline shown above. If all named refs are contained and correct, return that existing ref without creating a new commit; otherwise commit the real integration.',
    'Never edit the Field Guide. Return any contradictory durable decisions to the parent planner.',
    'Return the integrated outcome or a plain blocker. The runtime carries your integrated change reference separately.',
  ],
  reviewer: [
    'Review only; do not edit the repository or Field Guide, delegate, merge, or repair.',
    'Inspect the integrated result through the distinct lens named in the objective and return {"reviewed":true,"findings":[...]} with concrete, actionable findings for the parent planner.',
    'Check the current Field Guide and original objective where relevant. Do not invent a score, quorum, approval record, or review ledger.',
  ],
};

function roleInstructions(task: SwarmTask): readonly string[] {
  if (task.role !== 'planner') return ROLE_INSTRUCTIONS[task.role];
  const guideOwnership = task.parentTaskId === undefined
    ? [
        'You are the only owner of field-guide/index.md. Keep it small: curate only durable global decisions, surprising facts, and links to explicitly assigned topic files.',
        'Own assembly of the whole product: arrange any needed neutral integration and read-only review of the assembled product when it is ready. This obligation does not impose a fixed topology, stage sequence, fan-out, or depth.',
      ]
    : [
        'Never edit field-guide/index.md. You may edit only one explicit topic file when its exact path and single-writer ownership are assigned in this objective; otherwise do not edit the Field Guide.',
      ];
  return [...guideOwnership, ...ROLE_INSTRUCTIONS.planner];
}

export function parseAgentResponse(
  value: unknown,
): Readonly<Record<string, unknown>> {
  const direct = recordOf(value);
  if (direct) return direct;
  if (typeof value === 'string') {
    try {
      const parsed = recordOf(JSON.parse(value.trim()) as unknown);
      if (parsed) return parsed;
    } catch {
      // A non-JSON string is a valid completion result.
    }
  }
  return { result: asJson(value, 'Agent result') };
}

function asJson(value: unknown, label: string): SwarmJsonValue {
  assertJson(value, label, new WeakSet<object>());
  return value;
}

function assertJson(
  value: unknown,
  label: string,
  seen: WeakSet<object>,
): asserts value is SwarmJsonValue {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))
  ) {
    return;
  }
  if (typeof value !== 'object') {
    throw new TypeError(`${label} must contain only JSON values.`);
  }
  if (seen.has(value)) throw new TypeError(`${label} must not contain a cycle.`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertJson(entry, `${label}[${index}]`, seen));
  } else {
    for (const [key, entry] of Object.entries(value)) {
      assertJson(entry, `${label}.${key}`, seen);
    }
  }
  seen.delete(value);
}

function recordOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

function requiredRecord(
  value: unknown,
  label: string,
): Readonly<Record<string, unknown>> {
  const record = recordOf(value);
  if (!record) throw new TypeError(`${label} must be one JSON object.`);
  return record;
}

function requiredString(
  value: unknown,
  label: string,
): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function callerSessionId(invocation: InvocationContext): string {
  const sessionId = optionalCallerSessionId(invocation);
  if (!sessionId) throw new TypeError('Swarm create requires a session scope.');
  return sessionId;
}

function optionalCallerSessionId(invocation: InvocationContext): string | undefined {
  const sessionId = invocation.scope?.sessionId?.trim();
  return sessionId || undefined;
}

function callerWorkspace(invocation: InvocationContext): string | undefined {
  const metadata = invocation.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;
  const name = (metadata as { marshalWorkspaceName?: unknown }).marshalWorkspaceName;
  return typeof name === 'string' && name.trim() ? name.trim() : undefined;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, label);
}

function requiredRole(value: unknown, label: string): SwarmTaskRole {
  switch (value) {
    case 'planner':
    case 'worker':
    case 'reconciler':
    case 'reviewer':
      return value;
    default:
      throw new TypeError(
        `${label} must be planner, worker, reconciler, or reviewer.`,
      );
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionalChangeRefs(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new TypeError('Delegation changeRefs must be an array.');
  }
  return value.map((entry, index) =>
    requiredString(entry, `Delegation changeRefs[${index}]`));
}

function plainError(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  return String(value);
}

function errorText(value: unknown, fallback: string): string {
  if (value === undefined || value === null) return fallback;
  const error = recordOf(value);
  return plainError(error?.message ?? error?.code ?? value);
}

function completionRejectedForLiveDescendant(value: unknown): boolean {
  const error = errorText(value, '');
  return error === DESCENDANT_INTEGRATION_REJECTION
    || error === ROOT_COMPLETION_RECONCILIATION_REJECTION;
}

function environmentalWorktreePauseReason(
  value: unknown,
  taskId: string,
): SwarmPauseReason | undefined {
  const error = recordOf(value);
  if (
    error?.kind !== 'environmental'
    || error.operation !== 'worktree.create'
    || error.attempts !== 3
  ) {
    return undefined;
  }
  const code = stringValue(error.code);
  const category = stringValue(error.category);
  return {
    kind: 'environmental',
    operation: 'worktree.create',
    taskId,
    attempts: 3,
    message: requiredString(error.message, 'Environmental error message'),
    ...(code === undefined ? {} : { code }),
    ...(category === undefined ? {} : { category }),
  };
}

function pauseReasonForError(
  value: unknown,
  taskId: string,
): SwarmPauseReason | undefined {
  return diskFullPauseReason(value, taskId)
    ?? environmentalWorktreePauseReason(value, taskId);
}

function diskFullPauseReason(
  value: unknown,
  taskId: string,
): SwarmPauseReason | undefined {
  if (!isDiskFullError(value)) return undefined;
  const error = recordOf(value);
  const message = errorText(
    error?.message ?? value,
    `Disk full while provisioning task "${taskId}".`,
  );
  const code = error?.code ?? error?.errno;
  return {
    kind: 'environmental',
    operation: 'worktree.create',
    taskId,
    attempts: 3,
    message,
    ...(code === undefined
      ? {}
      : { code: typeof code === 'string' ? code : String(code) }),
    category: 'disk-full',
  } as SwarmPauseReason;
}

function isDiskFullError(
  value: unknown,
  seen = new WeakSet<object>(),
  contextual = false,
): boolean {
  if (typeof value === 'string') {
    if (
      /^-?(28|39)$|enospc|no space left on device|not enough space on (?:the )?disk|not enough disk space|disk(?:\s+is)?\s+full|error_handle_disk_full|error[_ -]?disk[_ -]?full/i
        .test(value)
    ) return true;
    return contextual && /^(?:error\s*)?112$/i.test(value.trim());
  }
  if (typeof value === 'number') {
    return value === 28 || value === -28 || value === 39
      || (value === 112 && contextual);
  }
  if (value === null || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (value instanceof Error && isDiskFullError(value.message, seen, contextual)) {
    return true;
  }
  const record = recordOf(value);
  if (!record) return false;
  const context = contextual || Object.entries(record).some(([key, entry]) =>
    (key === 'platform' || key === 'os' || key === 'system'
      || key === 'operatingSystem' || key === 'category' || key === 'operation')
    && typeof entry === 'string'
    && /windows|win32|disk[- ]?full/i.test(entry));
  for (const [key, entry] of Object.entries(record)) {
    if (
      key === 'message' || key === 'code' || key === 'errno'
      || key === 'error' || key === 'cause' || key === 'details'
      || key === 'innerError' || key === 'originalError'
    ) {
      if (isDiskFullError(entry, seen, context)) return true;
    }
  }
  return false;
}
