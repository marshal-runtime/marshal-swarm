import { type InvocationContext, type RuntimeExecResponse } from "@marshal/runtime";
import {
  replaySwarmRun,
  SWARM_OWNER_SESSION_BUSY_ERROR,
  type SwarmPauseReason,
  type SwarmRun,
  type SwarmRunEvent,
  type SwarmRunUpdateEvent,
  type SwarmTask,
  type SwarmTaskRole,
} from "./contracts.js";
import { rootFailureCancellations, withFailureCascade } from "./failure-cascade.js";
import { getSwarmServiceContainer, type SwarmServiceContainer } from "./service-container.js";
import { tryGetSwarmRoleModelService } from "./services.js";
import { parseSwarmRunOwnerSessionId } from "./run-id.js";
import { publishSwarmRunView } from "./view-publish.js";
import {
  type SwarmRunCreateInput,
  type SwarmSourceOptions,
  type SwarmExecutionContext,
} from "./types.js";
import {
  RUNTIME_PROTOCOL_VERSION,
  DEFAULT_WORKER_MODEL,
  DEFAULT_WORKER_REASONING_EFFORT,
  recordOf,
  optionalCallerSessionId,
} from "./executor-values.js";
import { TERMINAL_RUN_STATES } from "./executor-tasks.js";
/** Journal, state mutex and runtime delegation calls shared by every executor layer. */
export class SwarmExecutorCore {
  protected readonly heldContinuations = new Map<string, Promise<void>>();
  protected readonly heldWakeups = new Set<string>();
  protected readonly serviceContainer: SwarmServiceContainer;
  protected stateTransition = Promise.resolve();
  protected readonly driveInFlight = new Map<string, Promise<SwarmRun>>();
  protected readonly reuseCallerSessions = new Set<string>();
  protected readonly viewInvocations = new Map<string, InvocationContext>();
  constructor(
    protected readonly factory: SwarmExecutionContext,
    protected readonly options: SwarmSourceOptions,
  ) {
    this.serviceContainer = options.serviceContainer ?? getSwarmServiceContainer();
  }
  protected canReadRun(run: SwarmRun, invocation: InvocationContext): boolean {
    if (!optionalCallerSessionId(invocation)) return false;
    const root = run.tasks.find((task) => task.parentTaskId === undefined);
    if (root?.ownerPrincipalId) return root.ownerPrincipalId === invocation.principal.id;
    // Historical runs without identity metadata retain their original owner-only path.
    return Boolean(this.callerTask(run, invocation));
  }
  protected callerTask(run: SwarmRun, invocation: InvocationContext): SwarmTask | undefined {
    const sessionId = optionalCallerSessionId(invocation);
    const root = run.tasks.find((task) => task.parentTaskId === undefined);
    if (run.legacyReadOnly && sessionId && root) {
      const canonical = run.runId.startsWith("marshal-swarm.")
        ? "owner." + run.runId.slice("marshal-swarm.".length)
        : run.runId;
      try {
        return parseSwarmRunOwnerSessionId(canonical) === sessionId ? root : undefined;
      } catch {
        return undefined;
      }
    }
    if (root?.ownerPrincipalId !== invocation.principal.id) return undefined;
    const delegationId = recordOf(invocation.metadata)?.delegationId;
    return run.tasks.find(
      (task) =>
        (sessionId && task.ownerSessionId === sessionId) ||
        task.executions.some(
          (e) =>
            (sessionId && e.sessionId === sessionId) ||
            (delegationId && e.delegationId === delegationId),
        ),
    );
  }
  protected resolveRoleModel(
    role: SwarmTaskRole,
    configuration: Pick<
      SwarmRunCreateInput,
      "roleModels" | "workerModel" | "workerReasoningEffort"
    >,
    run?: SwarmRun,
  ) {
    // Explicit selections are complete policies: never consult a possibly invalid
    // host default before honoring them, including when replaying a saved run.
    const explicit = configuration.roleModels?.[role];
    if (explicit) return { ...explicit };
    if (role === "worker" && configuration.workerModel)
      return {
        model: configuration.workerModel,
        reasoningEffort: configuration.workerReasoningEffort ?? DEFAULT_WORKER_REASONING_EFFORT,
      };
    const host = tryGetSwarmRoleModelService(this.serviceContainer)?.resolve(role, run);
    return role === "worker"
      ? {
          model: host?.model ?? DEFAULT_WORKER_MODEL,
          reasoningEffort:
            configuration.workerReasoningEffort ??
            host?.reasoningEffort ??
            DEFAULT_WORKER_REASONING_EFFORT,
        }
      : host;
  }
  protected async waitForAgent(
    delegationId: string,
    invocation: InvocationContext,
  ): Promise<Readonly<Record<string, unknown>> | undefined> {
    const response = await this.delegationCall(
      "runtime.delegation.wait",
      { delegationId },
      invocation,
    );
    return (
      recordOf(response.result?.output) ??
      (response.error === undefined ? undefined : { error: response.error })
    );
  }
  protected async continueAgent(
    delegationId: string,
    prompt: string,
    invocation: InvocationContext,
  ): Promise<Readonly<Record<string, unknown>> | undefined> {
    const response = await this.delegationCall(
      "runtime.delegation.continue",
      { delegationId, prompt },
      invocation,
    );
    return (
      recordOf(response.result?.output) ??
      (response.error === undefined ? undefined : { error: response.error })
    );
  }
  protected async failTask(
    runId: string,
    task: SwarmTask,
    error: string,
    changeRefs?: readonly string[],
  ): Promise<void> {
    await this.appendWhileRunning(runId, [
      {
        type: "task.failed",
        taskId: task.taskId,
        error,
        failureOrigin: "runtime",
        ...(error === SWARM_OWNER_SESSION_BUSY_ERROR
          ? { failureCode: "SESSION_BUSY" as const }
          : {}),
        ...(changeRefs === undefined ? {} : { changeRefs }),
      },
    ]);
  }
  protected async finishRun(runId: string): Promise<void> {
    await this.withStateTransition(async () => {
      const run = await this.requireRun(runId);
      if (TERMINAL_RUN_STATES.has(run.state) || run.state === "paused") return;
      const root = run.tasks.find((task) => task.parentTaskId === undefined);
      if (!root) {
        await this.append(runId, [
          {
            type: "run.failed",
            error: "Run has no root task.",
          },
        ]);
        return;
      }
      if (root.state === "failed") {
        const events = await this.options.eventStore.read(runId);
        const cancellations = rootFailureCancellations(
          run,
          events.at(-1) as SwarmRunEvent | undefined,
          root.error,
        );
        await this.append(runId, [
          ...cancellations.events,
          {
            type: "run.failed",
            error: root.error ?? "Root task failed.",
          },
        ]);
        const invocation = this.viewInvocations.get(runId);
        if (invocation)
          for (const delegationId of cancellations.cancelledDelegationIds)
            void this.cancelAgent(delegationId, invocation).catch(() => undefined);
        return;
      }
      if (root.state !== "completed") return;
      await this.append(runId, [
        {
          type: "run.completed",
          ...(root.result === undefined ? {} : { result: root.result }),
        },
      ]);
    });
  }
  protected async requireRun(runId: string): Promise<SwarmRun> {
    const run = replaySwarmRun(await this.options.eventStore.read(runId));
    return run;
  }
  protected async append(runId: string, events: readonly SwarmRunUpdateEvent[]): Promise<void> {
    const cascaded = withFailureCascade(await this.requireRun(runId), events);
    for (const event of cascaded.events) {
      await this.options.eventStore.append(runId, event);
    }
    const invocation = this.viewInvocations.get(runId);
    if (invocation)
      for (const delegationId of cascaded.cancelledDelegationIds)
        void this.cancelAgent(delegationId, invocation).catch(() => undefined);
    void this.publishView(runId).catch((error) => {
      console.warn(
        "Swarm view refresh failed; durable task state was preserved.",
        error instanceof Error ? error.message.slice(0, 512) : "Runtime UI unavailable",
      );
    });
  }
  protected async publishView(runId: string): Promise<void> {
    const invocation = this.viewInvocations.get(runId);
    if (!invocation) return;
    await publishSwarmRunView(
      await this.requireRun(runId),
      invocation,
      (request, context) => this.factory.execute(request, context),
      { openIfMissing: false },
    );
  }
  protected async stopped(runId: string): Promise<boolean> {
    return (await this.requireRun(runId)).state !== "running";
  }
  protected appendWhileRunning(runId: string, events: readonly SwarmRunUpdateEvent[]): Promise<void> {
    return this.withStateTransition(async () => {
      if ((await this.requireRun(runId)).state !== "running") return;
      await this.append(runId, events);
    });
  }
  protected pauseRun(
    runId: string,
    reason: SwarmPauseReason,
    invocation: InvocationContext,
  ): Promise<SwarmRun> {
    return this.withStateTransition(async () => {
      const run = await this.requireRun(runId);
      if (TERMINAL_RUN_STATES.has(run.state)) {
        return run;
      }
      if (run.state !== "paused")
        await this.append(runId, [
          {
            type: "run.paused",
            reason,
          },
        ]);
      const paused = await this.requireRun(runId);
      const delegationIds = new Set(
        paused.tasks.flatMap((task) =>
          task.state === "running" && task.delegationId !== undefined ? [task.delegationId] : [],
        ),
      );
      await Promise.all(
        [...delegationIds].map((delegationId) =>
          this.pauseAgent(delegationId, reason.message, invocation),
        ),
      );
      return this.requireRun(runId);
    });
  }
  protected async withStateTransition<T>(action: () => Promise<T>): Promise<T> {
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
  protected pauseAgent(
    delegationId: string,
    reason: string,
    invocation: InvocationContext,
  ): Promise<RuntimeExecResponse> {
    return this.delegationCall("runtime.delegation.pause", { delegationId, reason }, invocation);
  }
  protected cancelAgent(
    delegationId: string,
    invocation: InvocationContext,
  ): Promise<RuntimeExecResponse> {
    return this.delegationCall(
      "runtime.delegation.cancel",
      { delegationId, recursive: true },
      invocation,
    );
  }
  protected delegationCall(
    operation: string,
    input: unknown,
    invocation: InvocationContext,
  ): Promise<RuntimeExecResponse> {
    const request = {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      targetType: "operation" as const,
      target: operation,
      input,
      approval: invocation.approval,
    };
    return this.factory.execute(request, invocation);
  }
}
