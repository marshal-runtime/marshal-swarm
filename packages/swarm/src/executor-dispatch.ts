import { createHash } from "node:crypto";
import type { InvocationContext } from "@marshal/runtime";
import {
  replaySwarmRun,
  type SwarmRun,
  type SwarmRunUpdateEvent,
  type SwarmTask,
} from "./contracts.js";
import {
  tryGetSwarmSharedContextService,
  tryGetSwarmBaselineService,
  type SwarmBaseline,
} from "./services.js";
import {
  type ExecutableTask,
  type AgentLaunch,
  type ReservedTaskDispatch,
  launchFailure,
  childAttentionSignature,
  executionReceipt,
} from "./executor-tasks.js";
import {
  DESCENDANT_INTEGRATION_REJECTION,
  recordOf,
  requiredString,
  optionalCallerSessionId,
  stringValue,
  optionalChangeRefs,
  errorText,
  completionRejectedForLiveDescendant,
  pauseReasonForError,
} from "./executor-values.js";
import { promptFor } from "./executor-prompts.js";
import { SwarmExecutorCore } from "./executor-core.js";
/** Reserving, dispatching and launching task agents, and node completion. */
export class SwarmExecutorDispatch extends SwarmExecutorCore {
  protected async launch(
    runId: string,
    run: SwarmRun,
    ready: ExecutableTask,
    invocation: InvocationContext,
  ): Promise<AgentLaunch> {
    const task = ready.task;
    const fieldGuide = (await tryGetSwarmSharedContextService(this.serviceContainer)?.read(
      runId,
    )) ?? {
      path: "Not configured",
      content: "No shared Field Guide has been configured for this run.",
    };
    const baseline = await tryGetSwarmBaselineService(this.serviceContainer)?.resolve(
      runId,
      task.scope,
    );
    const prompt = promptFor(ready, fieldGuide, run, baseline);
    if (task.state === "pending") {
      const dispatch = await this.withStateTransition(async () => {
        const currentRun = await this.requireRun(runId);
        if (currentRun.state !== "running") {
          return { ready, error: "Run stopped." };
        }
        const currentTask = currentRun.tasks.find((entry) => entry.taskId === task.taskId);
        if (currentTask === undefined) {
          return { ready, error: `Task "${task.taskId}" no longer exists.` };
        }
        if (currentTask.state === "running" && currentTask.delegationId !== undefined) {
          return {
            ready: { ...ready, task: currentTask },
            delegationId: currentTask.delegationId,
          };
        }
        if (currentTask.state !== "pending") {
          return {
            ready: { ...ready, task: currentTask },
            error: `Task "${task.taskId}" is no longer executable.`,
          };
        }
        return this.reserveTaskDispatch(
          runId,
          currentRun,
          ready,
          currentTask,
          prompt,
          baseline,
          invocation,
        );
      });
      return "launchInput" in dispatch ? this.dispatchTask(dispatch) : dispatch;
    }
    if ((await this.requireRun(runId)).state !== "running") {
      return { ready, error: "Run stopped." };
    }
    if (task.executions.at(-1)?.dispatchState === "registered") {
      const dispatch = await this.reserveTaskDispatch(
        runId,
        run,
        ready,
        task,
        prompt,
        baseline,
        invocation,
      );
      return "launchInput" in dispatch ? this.dispatchTask(dispatch) : dispatch;
    }
    const delegationId = requiredString(task.delegationId, `Task "${task.taskId}" delegationId`);
    if (task.resumeReason) {
      const continued = await this.continueAgent(
        delegationId,
        `Explicit task resolution: ${task.resumeReason}\n${prompt}`,
        invocation,
      );
      if (continued?.error) return launchFailure(ready, continued, undefined, "continue");
      if (continued?.continuationDelivery === "held")
        return { ready, delegationId, continuationHeld: true };
      await this.appendWhileRunning(runId, [
        { type: "task.continued", taskId: task.taskId },
        ...(ready.childResults.length
          ? [
              {
                type: "task.childrenNotified" as const,
                taskId: task.taskId,
                signature: childAttentionSignature(ready),
              },
            ]
          : []),
      ]);
      return { ready, delegationId };
    }
    if (ready.childResults.length > 0) {
      const continued = await this.continueAgent(delegationId, prompt, invocation);
      const pauseReason = pauseReasonForError(continued, task.taskId);
      if (pauseReason !== undefined) {
        return {
          ready,
          error: errorText(recordOf(continued)?.error, pauseReason.message),
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
      if (continued?.continuationDelivery === "held")
        return { ready, delegationId, continuationHeld: true };
      if (continued?.error || stringValue(continued?.delegationId) !== delegationId) {
        return launchFailure(ready, continued, undefined, "continue");
      }
      await this.appendWhileRunning(runId, [
        {
          type: "task.childrenNotified",
          taskId: task.taskId,
          signature: childAttentionSignature(ready),
        },
      ]);
      return { ready, delegationId };
    }
    return { ready, delegationId };
  }
  protected replaceRejectedPlanner(
    runId: string,
    ready: ExecutableTask,
    rejectedDelegationId: string,
    prompt: string,
    baseline: SwarmBaseline | undefined,
    invocation: InvocationContext,
  ): Promise<AgentLaunch> {
    return this.withStateTransition(async () => {
      const currentRun = await this.requireRun(runId);
      if (currentRun.state !== "running") {
        return { ready, error: "Run stopped." };
      }
      const currentTask = currentRun.tasks.find((entry) => entry.taskId === ready.task.taskId);
      if (
        currentTask === undefined ||
        currentTask.state !== "running" ||
        currentTask.delegationId === undefined
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
      return this.reserveTaskDispatch(
        runId,
        currentRun,
        ready,
        currentTask,
        prompt,
        baseline,
        invocation,
      );
    }).then((dispatch) => ("launchInput" in dispatch ? this.dispatchTask(dispatch) : dispatch));
  }
  protected async reserveTaskDispatch(
    runId: string,
    run: SwarmRun,
    ready: ExecutableTask,
    task: SwarmTask,
    prompt: string,
    baseline: SwarmBaseline | undefined,
    invocation: InvocationContext,
  ): Promise<ReservedTaskDispatch | AgentLaunch> {
    const parentDelegationId =
      task.parentTaskId === undefined
        ? undefined
        : run.tasks.find((entry) => entry.taskId === task.parentTaskId)?.delegationId;
    const configuredRoleModel = this.resolveRoleModel(task.role, run, run);
    const callerSession = optionalCallerSessionId(invocation);
    const reserved =
      task.executions.at(-1)?.dispatchState === "registered" ? task.executions.at(-1) : undefined;
    if (
      reserved?.launchInput &&
      configuredRoleModel?.model &&
      (reserved.launchInput.model !== configuredRoleModel.model ||
        reserved.launchInput.reasoningEffort !== configuredRoleModel.reasoningEffort)
    ) {
      return {
        ready,
        error: `Reserved dispatch "${reserved.executionId}" conflicts with the current ${task.role} model policy; no dispatch was sent.`,
      };
    }
    const roleModel = reserved?.launchInput
      ? {
          model: stringValue(reserved.launchInput.model),
          reasoningEffort: stringValue(reserved.launchInput.reasoningEffort),
        }
      : configuredRoleModel;
    const executionId =
      reserved?.executionId ?? `swarm:${runId}:${task.taskId}:${task.executions.length}`;
    // Tree paths are logical identities, not filenames. The delegation store
    // requires one portable path segment; hashing also bounds deeply nested IDs.
    const delegationKey = `swarm-${createHash("sha256").update(executionId).digest("hex")}`;
    const launchInput = reserved?.launchInput ?? {
      prompt,
      idempotencyKey: executionId,
      delegationId: delegationKey,
      scope: task.scope,
      role: task.role,
      workspaceMode: task.role === "planner" ? "shared" : "isolated",
      ...(roleModel?.model === undefined ? {} : { model: roleModel.model }),
      ...(roleModel?.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: roleModel.reasoningEffort }),
      ...(parentDelegationId === undefined ? {} : { parentDelegationId }),
      ...(baseline?.head === undefined ? {} : { baseRef: baseline.head }),
      ...(this.reuseCallerSessions.has(runId) && task.parentTaskId === undefined && callerSession
        ? { backend: callerSession }
        : {}),
    };
    if (!reserved)
      await this.append(runId, [
        {
          type: "task.dispatched",
          taskId: task.taskId,
          execution: {
            executionId,
            kind: "dispatch",
            dispatchState: "registered",
            startedAt: new Date().toISOString(),
            launchInput,
            delegationId: delegationKey,
            ...(roleModel?.model ? { model: roleModel.model } : {}),
            ...(roleModel?.reasoningEffort ? { reasoningEffort: roleModel.reasoningEffort } : {}),
          },
        },
      ]);
    return {
      runId,
      ready,
      task,
      invocation,
      executionId,
      launchInput,
      startedAt: reserved?.startedAt ?? new Date().toISOString(),
      ...(roleModel === undefined ? {} : { roleModel }),
    };
  }
  protected async dispatchTask(dispatch: ReservedTaskDispatch): Promise<AgentLaunch> {
    const { runId, ready, task, invocation, executionId, launchInput, startedAt, roleModel } =
      dispatch;
    const spawned = await this.delegationCall("runtime.delegation.spawn", launchInput, invocation);
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
      return launchFailure(ready, delegation, spawned.error, "start");
    }
    const recordedTask = await this.withStateTransition(async () => {
      const run = await this.requireRun(runId);
      const currentTask = run.tasks.find((entry) => entry.taskId === task.taskId);
      if (
        run.state !== "running" ||
        currentTask?.state !== "running" ||
        currentTask.executions.at(-1)?.executionId !== executionId
      ) {
        return undefined;
      }
      await this.append(runId, [
        {
          type: "task.execution",
          taskId: task.taskId,
          execution: {
            executionId,
            kind: "dispatch",
            dispatchState: "dispatched",
            startedAt,
            delegationId,
            ...(stringValue(delegation?.sessionId)
              ? { sessionId: stringValue(delegation?.sessionId) }
              : {}),
            ...(stringValue(delegation?.transcriptRef)
              ? { transcriptRef: stringValue(delegation?.transcriptRef) }
              : {}),
            ...(roleModel?.model ? { model: roleModel.model } : {}),
            ...(roleModel?.reasoningEffort ? { reasoningEffort: roleModel.reasoningEffort } : {}),
          },
        },
      ]);
      return (await this.requireRun(runId)).tasks.find((entry) => entry.taskId === task.taskId);
    });
    return recordedTask
      ? { ready: { ...ready, task: recordedTask }, delegationId }
      : { ready, error: `Task "${task.taskId}" stopped while dispatching.` };
  }
  protected async completeNode(
    runId: string,
    input: Readonly<Record<string, unknown>>,
    invocation: InvocationContext,
  ): Promise<SwarmTask | undefined> {
    const prepared = await this.withStateTransition(async () => {
      const run = await this.requireRun(runId);
      const caller = this.callerTask(run, invocation);
      if (!caller) throw new Error("Caller does not own a task in this run.");
      const taskId = requiredString(input.taskId, "taskId");
      const task = run.tasks.find((entry) => entry.taskId === taskId);
      if (!task) throw new Error("Unknown task.");
      if (run.legacyReadOnly)
        throw new Error("Legacy runs are read-only. Start a new explicit-protocol run.");
      if (run.state !== "running") throw new Error("Run is not running.");
      if (caller.taskId !== task.taskId)
        throw new Error("Only the owning task may change this node.");
      if (task.state !== "running")
        throw new Error("Only running tasks may change state or publish artifacts.");
      const commits = optionalChangeRefs(input.commits) ?? [];
      const event: SwarmRunUpdateEvent = {
        type: "task.completed",
        taskId,
        changeRefs: commits,
      };
      replaySwarmRun([...(await this.options.eventStore.read(runId)), event]);
      return { task, taskId, commits, event };
    });
    let result: Record<string, unknown> | undefined;
    if (prepared.task.delegationId) {
      const completed = await this.delegationCall(
        "runtime.delegation.complete",
        { delegationId: prepared.task.delegationId },
        invocation,
      );
      if (completed.error)
        throw new Error(errorText(completed.error, "Completion integration failed."));
      result = recordOf(completed.result?.output);
      if (result?.error) throw new Error(errorText(result.error, "Completion integration failed."));
      if (result?.finalized !== true || result.state !== "done")
        throw new Error("Runtime did not finalize task completion.");
    }
    return this.withStateTransition(async () => {
      const run = await this.requireRun(runId);
      const caller = this.callerTask(run, invocation);
      const task = run.tasks.find((entry) => entry.taskId === prepared.taskId);
      if (!caller || !task || caller.taskId !== task.taskId)
        throw new Error("Caller no longer owns this task.");
      if (run.state !== "running" || task.state !== "running")
        throw new Error("Task is no longer running.");
      const receipt = result ? executionReceipt(task, result) : undefined;
      await this.append(runId, [
        ...(receipt ? [receipt] : []),
        {
          ...prepared.event,
          ...(stringValue(recordOf(result?.result)?.integrationWarning)
            ? {
                result: {
                  integrationWarning: stringValue(recordOf(result?.result)?.integrationWarning)!,
                },
              }
            : {}),
          changeRefs:
            input.commits !== undefined
              ? prepared.commits
              : (optionalChangeRefs(result?.changeRefs) ?? prepared.commits),
        },
      ]);
      return (await this.requireRun(runId)).tasks.find((entry) => entry.taskId === prepared.taskId);
    });
  }
}
