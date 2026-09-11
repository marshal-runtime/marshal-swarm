import { readSwarmEvidenceFile } from "./read-evidence-file.js";
import { createHash } from "node:crypto";
import type { InvocationContext, RuntimeExecResponse } from "@marshal/runtime";
const RUNTIME_PROTOCOL_VERSION = "1.0.0";
import {
  replaySwarmRun,
  SWARM_OWNER_SESSION_BUSY_ERROR,
  SWARM_OWNER_SESSION_SUPERSEDED_ERROR,
  validateSwarmRoleModels,
  swarmRunTargets,
  type SwarmJsonValue,
  type SwarmPauseReason,
  type SwarmRun,
  type SwarmRunTarget,
  type SwarmRunUpdateEvent,
  type SwarmTask,
  type SwarmTaskDefinition,
  type SwarmTaskRole,
  type SwarmRoleModels,
  type SwarmArtifactReference,
} from "./contracts.js";
import {
  getSwarmServiceContainer,
  type SwarmServiceContainer,
} from "./service-container.js";
import {
  tryGetSwarmSharedContextService,
  tryGetSwarmBaselineService,
  tryGetSwarmTranscriptReaderService,
  tryGetSwarmRoleModelService,
  type SwarmBaseline,
  type SwarmSharedContext,
} from "./services.js";
import { createSwarmRunId, parseSwarmRunOwnerSessionId } from "./run-id.js";
import { publishSwarmRunView } from "./view-publish.js";
import type {
  SwarmRunCancelInput,
  SwarmRunCreateInput,
  SwarmRunInput,
  SwarmRunPauseInput,
  SwarmRunRecoverSystemFailureInput,
  SwarmRunSetRoleModelsInput,
  SwarmSourceOptions,
} from "./types.js";
import type { SwarmExecutionContext } from "./types.js";
const TERMINAL_RUN_STATES = new Set(["completed", "failed"]);
interface ExecutableTask {
  readonly task: SwarmTask;
  readonly childResults: readonly ChildResult[];
  readonly outstanding: readonly OutstandingChild[];
}
interface ChildResult {
  readonly state: SwarmTask["state"];
  readonly reason?: string;
  readonly resumeCount: number;
  readonly taskId: string;
  readonly role: SwarmTaskRole;
  readonly result?: SwarmJsonValue;
  readonly error?: SwarmJsonValue;
  readonly changeRefs?: readonly string[];
}
interface OutstandingChild {
  readonly state: SwarmTask["state"];
  readonly reason?: string;
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
  'Reviewer results must be structured as {"reviewed":true,"findings":[...]}. ' +
  "Narration without that structure is a failed review.";
const REVIEW_RECURRENCE_MESSAGE =
  "Refused: this integrated change ref was already reviewed and no worker or " +
  "reconciler change ref has advanced since the previous review.";
const DESCENDANT_INTEGRATION_REJECTION =
  "All descendant tasks must be terminal before integration.";
const ROOT_COMPLETION_RECONCILIATION_REJECTION =
  "Root completion requires reconciliation after the latest implementation.";
const DEFAULT_WORKER_MODEL = "gpt-5.6-luna";
const DEFAULT_WORKER_REASONING_EFFORT = "medium";
interface AgentLaunch {
  readonly continuationHeld?: boolean;
  readonly ready: ExecutableTask;
  readonly delegationId?: string;
  readonly error?: string;
  readonly pauseReason?: SwarmPauseReason;
}
interface AgentOutcome {
  readonly continuationHeld?: boolean;
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
  private readonly heldContinuations = new Map<string, Promise<void>>();
  private readonly heldWakeups = new Set<string>();
  private readonly serviceContainer: SwarmServiceContainer;
  private stateTransition = Promise.resolve();
  private readonly driveInFlight = new Map<string, Promise<SwarmRun>>();
  private readonly reuseCallerSessions = new Set<string>();
  private readonly viewInvocations = new Map<string, InvocationContext>();
  constructor(
    private readonly factory: SwarmExecutionContext,
    private readonly options: SwarmSourceOptions,
  ) {
    this.serviceContainer =
      options.serviceContainer ?? getSwarmServiceContainer();
  }
  async create(
    input: SwarmRunCreateInput,
    invocation: InvocationContext,
  ): Promise<SwarmRun> {
    const objective = requiredString(input.objective, "objective");
    const scope = requiredString(
      input.scope ?? callerWorkspace(invocation),
      "scope",
    );
    const runId =
      optionalString(input.runId, "runId") ??
      createSwarmRunId(callerSessionId(invocation));
    const targetRef = optionalTrimmed(input.targetRef, "targetRef");
    const targetHead = optionalTrimmed(input.targetHead, "targetHead");
    const targets =
      input.targets === undefined ? undefined : normalizeTargets(input.targets);
    const workerModel = optionalString(input.workerModel, "workerModel");
    const workerReasoningEffort = optionalString(
      input.workerReasoningEffort,
      "workerReasoningEffort",
    );
    if (input.roleModels !== undefined) validateSwarmRoleModels(input.roleModels);
    const roleModels: SwarmRoleModels = Object.fromEntries(
      (["planner", "reviewer", "worker", "reconciler"] as const).flatMap((role) => {
        const selection = this.resolveRoleModel(role, { ...input, workerModel, workerReasoningEffort });
        return selection?.model ? [[role, selection]] : [];
      }),
    );
    const root: SwarmTaskDefinition = {
      taskId: "root",
      ownerSessionId: callerSessionId(invocation),
      ownerPrincipalId: invocation.principal.id,
      createdAt: new Date().toISOString(),
      role: "planner",
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
      { ...(workerModel === undefined ? {} : { workerModel }), ...(workerReasoningEffort === undefined ? {} : { workerReasoningEffort }), ...(Object.keys(roleModels).length ? { roleModels } : {}) },
    );
    await this.append(runId, [{ type: "task.added", task: root }]);
    return this.requireRun(runId);
  }
  async get(input: SwarmRunInput): Promise<SwarmRun> {
    return this.requireRun(requiredString(input.runId, "runId"));
  }
  async list(): Promise<readonly SwarmRun[]> {
    return Promise.all(
      (await this.options.eventStore.list()).map((runId) =>
        this.requireRun(runId),
      ),
    );
  }
  async listAuthorized(
    invocation: InvocationContext,
  ): Promise<readonly SwarmRun[]> {
    return (await this.list()).filter((run) =>
      this.canReadRun(run, invocation),
    );
  }
  /** The chat panel shows participation, not every run the account may inspect. */
  async listEvidence(invocation: InvocationContext): Promise<readonly SwarmRun[]> {
    return (await this.listAuthorized(invocation)).filter((run) =>
      Boolean(this.callerTask(run, invocation)),
    );
  }
  async getAuthorized(
    input: SwarmRunInput,
    invocation: InvocationContext,
  ): Promise<SwarmRun> {
    const run = await this.get(input);
    if (!this.canReadRun(run, invocation))
      throw new Error("Caller does not share this run owner identity.");
    return run;
  }
  async getRootAuthorized(
    input: SwarmRunInput,
    invocation: InvocationContext,
  ): Promise<SwarmRun> {
    const run = await this.getAuthorized(input, invocation);
    if (run.legacyReadOnly)
      throw new Error(
        "Legacy runs are read-only. Start a new explicit-protocol run.",
      );
    const caller = this.callerTask(run, invocation);
    if (!caller || caller.parentTaskId !== undefined)
      throw new Error("Only the root owner controls the run.");
    return run;
  }
  async openEvidence(
    runId: string,
    invocation: InvocationContext,
  ): Promise<SwarmRun> {
    const run = await this.getAuthorized({ runId }, invocation);
    if (this.callerTask(run, invocation)) this.viewInvocations.set(runId, invocation);
    await publishSwarmRunView(
      run,
      invocation,
      (request, context) => this.factory.execute(request, context),
      { focus: true },
    );
    return run;
  }
  async readEvidence(
    input: { readonly runId: string; readonly taskId: string; readonly uri: string; readonly offset?: number },
    invocation: InvocationContext,
  ) {
    const run = await this.getAuthorized(input, invocation);
    const reader = tryGetSwarmTranscriptReaderService(this.serviceContainer);
    return readSwarmEvidenceFile(run, input, reader
      ? (request) => reader.read(request, invocation)
      : undefined);
  }
  private canReadRun(run: SwarmRun, invocation: InvocationContext): boolean {
    if (!optionalCallerSessionId(invocation)) return false;
    const root = run.tasks.find((task) => task.parentTaskId === undefined);
    if (root?.ownerPrincipalId) return root.ownerPrincipalId === invocation.principal.id;
    // Historical runs without identity metadata retain their original owner-only path.
    return Boolean(this.callerTask(run, invocation));
  }
  private callerTask(
    run: SwarmRun,
    invocation: InvocationContext,
  ): SwarmTask | undefined {
    const sessionId = optionalCallerSessionId(invocation);
    const root = run.tasks.find((task) => task.parentTaskId === undefined);
    if (run.legacyReadOnly && sessionId && root) {
      const canonical = run.runId.startsWith("marshal-swarm.")
        ? "owner." + run.runId.slice("marshal-swarm.".length)
        : run.runId;
      try {
        return parseSwarmRunOwnerSessionId(canonical) === sessionId
          ? root
          : undefined;
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
  async nodeOperation(
    name: string,
    input: Readonly<Record<string, unknown>>,
    invocation: InvocationContext,
  ): Promise<unknown> {
    const runId = requiredString(input.runId, "runId");
    if (name === "list" || name === "get") {
      const run = await this.getAuthorized({ runId }, invocation);
      if (name === "list") return run.tasks;
      const task = run.tasks.find((entry) => entry.taskId === requiredString(input.taskId, "taskId"));
      if (!task) throw new Error("Unknown task.");
      return task;
    }
    const output = await this.withStateTransition(async () => {
      const run = await this.requireRun(runId);
      const caller = this.callerTask(run, invocation);
      if (!caller) throw new Error("Caller does not own a task in this run.");
      const taskId = requiredString(
        name === "launch" ? input.parentTaskId : input.taskId,
        "taskId",
      );
      const task = run.tasks.find((t) => t.taskId === taskId);
      if (!task) throw new Error("Unknown task.");
      if (run.legacyReadOnly)
        throw new Error(
          "Legacy runs are read-only. Start a new explicit-protocol run.",
        );
      if (run.state !== "running") throw new Error("Run is not running.");
      if (
        caller.taskId !== task.taskId &&
        !(name === "resume" && caller.taskId === task.parentTaskId)
      )
        throw new Error("Only the owning task may change this node.");
      if (name === "launch") {
        if (task.role !== "planner")
          throw new Error("Role cannot launch children.");
        const key = requiredString(input.idempotencyKey, "idempotencyKey");
        const local = requiredString(input.taskId, "taskId");
        if (!/^[A-Za-z0-9._-]+$/.test(local))
          throw new Error("Child taskId must be a local identifier.");
        const definition: SwarmTaskDefinition = {
          taskId: `${task.taskId}/${local}`,
          parentTaskId: task.taskId,
          role: requiredRole(input.role, "role"),
          objective: requiredString(input.objective, "objective"),
          scope: requiredString(input.scope, "scope"),
          dependencyTaskIds: optionalChangeRefs(input.dependencyTaskIds) ?? [],
          idempotencyKey: key,
          createdAt: new Date().toISOString(),
        };
        const prior = run.tasks.find(
          (t) => t.parentTaskId === task.taskId && t.idempotencyKey === key,
        );
        if (prior) {
          if (
            ["taskId", "role", "objective", "scope", "dependencyTaskIds"].some(
              (k) =>
                JSON.stringify(
                  (prior as unknown as Record<string, unknown>)[k],
                ) !==
                JSON.stringify(
                  (definition as unknown as Record<string, unknown>)[k],
                ),
            )
          )
            throw new Error("Idempotency key was used with different input.");
          return prior;
        }
        if (task.state !== "running")
          throw new Error("Only running parents launch children.");
        if (!permittedScopeNames(run, task).includes(definition.scope))
          throw new Error("Child scope is not a declared repository target.");
        for (const id of definition.dependencyTaskIds ?? []) {
          if (id === task.taskId || task.taskId.startsWith(`${id}/`))
            throw new Error("A child cannot depend on its owner or ancestor.");
          if (!run.tasks.some((t) => t.taskId === id))
            throw new Error("Unknown dependency.");
        }
        await this.append(runId, [{ type: "task.added", task: definition }]);
        return (await this.requireRun(runId)).tasks.find(
          (t) => t.taskId === definition.taskId,
        );
      }
      if (name === "resume") {
        await this.append(runId, [
          {
            type: "task.resumed",
            taskId,
            reason: requiredString(input.reason, "reason"),
          },
        ]);
      } else if (task.state !== "running")
        throw new Error(
          "Only running tasks may change state or publish artifacts.",
        );
      else if (name === "publishArtifact") {
        await this.append(runId, [
          {
            type: "task.artifact",
            taskId,
            artifact: input.artifact as SwarmArtifactReference,
          },
        ]);
      } else if (name === "block" || name === "fail") {
        const reason = requiredString(input.reason, "reason");
        await this.append(runId, [
          name === "block"
            ? { type: "task.blocked", taskId, reason }
            : { type: "task.failed", taskId, error: reason, failureOrigin: "agent" },
        ]);
      } else if (name === "complete") {
        const commits = optionalChangeRefs(input.commits) ?? [];
        const event: SwarmRunUpdateEvent = {
          type: "task.completed",
          taskId,
          changeRefs: commits,
        };
        replaySwarmRun([...(await this.options.eventStore.read(runId)), event]);
        if (task.delegationId) {
          const completed = await this.delegationCall(
            "runtime.delegation.complete",
            { delegationId: task.delegationId },
            invocation,
          );
          if (completed.error)
            throw new Error(
              errorText(completed.error, "Completion integration failed."),
            );
          const result = recordOf(completed.result?.output);
          if (result?.error)
            throw new Error(
              errorText(result.error, "Completion integration failed."),
            );
          if (result?.finalized !== true || result.state !== "done")
            throw new Error("Runtime did not finalize task completion.");
          const receipt = executionReceipt(task, result);
          await this.append(runId, [
            ...(receipt ? [receipt] : []),
            {
              ...event,
              ...(stringValue(recordOf(result.result)?.integrationWarning)
                ? {
                    result: {
                      integrationWarning: stringValue(
                        recordOf(result.result)?.integrationWarning,
                      )!,
                    },
                  }
                : {}),
              // Declared task outputs are distinct from the native checkout's
              // integration refs. Finalization still validates native ownership;
              // it does not verify or replace the caller's declared commits.
              changeRefs: input.commits !== undefined
                ? commits
                : optionalChangeRefs(result?.changeRefs) ?? commits,
            },
          ]);
        } else await this.append(runId, [event]);
      } else throw new Error(`Unknown node operation ${name}.`);
      return (await this.requireRun(runId)).tasks.find(
        (t) => t.taskId === taskId,
      );
    });
    await this.finishRun(runId);
    if (
      name === "launch" ||
      name === "resume" ||
      name === "complete" ||
      name === "block" ||
      name === "fail"
    )
      void this.drive(
        { runId },
        this.viewInvocations.get(runId) ?? invocation,
      ).catch(() => undefined);
    return output;
  }
  async cancel(
    input: SwarmRunCancelInput,
    invocation: InvocationContext,
  ): Promise<SwarmRun> {
    const runId = requiredString(input.runId, "runId");
    const ownedRun = await this.getRootAuthorized({ runId }, invocation);
    if (this.callerTask(ownedRun, invocation)?.parentTaskId !== undefined)
      throw new Error("Only the root owner controls the run.");
    this.viewInvocations.set(runId, invocation);
    const reason = requiredString(input.reason, "reason");
    let rootDelegationId: string | undefined;
    const run = await this.withStateTransition(async () => {
      const current = await this.requireRun(runId);
      if (TERMINAL_RUN_STATES.has(current.state)) return current;
      rootDelegationId = current.tasks.find(
        (task) => task.parentTaskId === undefined,
      )?.delegationId;
      await this.append(runId, [
        ...current.tasks
          .filter((task) => !isTerminalTask(task))
          .map((task) => ({
            type: "task.cancelled" as const,
            taskId: task.taskId,
            error: reason,
          })),
        { type: "run.cancelled", error: reason },
      ]);
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
    const runId = requiredString(input.runId, "runId");
    const ownedRun = await this.getRootAuthorized({ runId }, invocation);
    if (this.callerTask(ownedRun, invocation)?.parentTaskId !== undefined)
      throw new Error("Only the root owner controls the run.");
    this.viewInvocations.set(runId, invocation);
    return this.pauseRun(
      runId,
      {
        kind: "manual",
        message: requiredString(input.reason, "reason"),
      },
      invocation,
    );
  }
  async resume(
    input: SwarmRunInput,
    invocation: InvocationContext,
  ): Promise<SwarmRun> {
    const runId = requiredString(input.runId, "runId");
    const ownedRun = await this.getRootAuthorized({ runId }, invocation);
    if (this.callerTask(ownedRun, invocation)?.parentTaskId !== undefined)
      throw new Error("Only the root owner controls the run.");
    this.viewInvocations.set(runId, invocation);
    let resumed = false;
    const run = await this.withStateTransition(async () => {
      const current = await this.requireRun(runId);
      if (
        TERMINAL_RUN_STATES.has(current.state) ||
        current.state === "running"
      ) {
        return current;
      }
      assertResumableScopes(current);
      await this.append(runId, [{ type: "run.resumed" }]);
      resumed = true;
      return this.requireRun(runId);
    });
    return resumed ? this.drive({ runId }, invocation) : run;
  }
  async recoverSystemFailure(
    input: SwarmRunRecoverSystemFailureInput,
    invocation: InvocationContext,
  ): Promise<SwarmRun> {
    const runId = requiredString(input.runId, "runId");
    await this.getRootAuthorized({ runId }, invocation);
    this.viewInvocations.set(runId, invocation);
    return this.withStateTransition(async () => {
      const events = await this.options.eventStore.read(runId);
      const run = replaySwarmRun(events);
      const root = run.tasks.find((task) => task.parentTaskId === undefined)!;
      // Explicit operator classification of a legacy incident is part of the audit.
      // Caller must be the original owner session, not merely a child delegation.
      if (!root.ownerSessionId || !root.ownerPrincipalId || root.ownerSessionId !== optionalCallerSessionId(invocation) || root.ownerPrincipalId !== invocation.principal.id)
        throw new Error("Only the original root owner session may recover a system failure.");
      const event: SwarmRunUpdateEvent = {
        type: "run.systemFailureRecovered", taskId: root.taskId,
        classification: input.classification,
        expectedTaskFailureIndex: input.expectedTaskFailureIndex,
        expectedRunFailureIndex: input.expectedRunFailureIndex,
        reason: requiredString(input.reason, "reason"),
        ownerSessionId: root.ownerSessionId, ownerPrincipalId: root.ownerPrincipalId,
      };
      const prior = events.find((value) => value.type === "run.systemFailureRecovered" &&
        value.expectedTaskFailureIndex === input.expectedTaskFailureIndex && value.expectedRunFailureIndex === input.expectedRunFailureIndex);
      if (prior) {
        if (JSON.stringify(prior) !== JSON.stringify(event)) throw new Error("Recovery reference was already used with different input.");
        return run;
      }
      // Validate the complete transition before one durable append. Never dispatch
      // here: the recovered run remains paused until a separate explicit resume.
      replaySwarmRun([...events, event]);
      const delegationId = requiredString(root.delegationId, "Root delegationId");
      const response = await this.delegationCall("runtime.delegation.recover", {
        delegationId,
        expectedError: input.classification === "owner-session-superseded-transport" ? SWARM_OWNER_SESSION_SUPERSEDED_ERROR : SWARM_OWNER_SESSION_BUSY_ERROR,
        reason: event.reason,
        idempotencyKey: `swarm-recovery-${createHash("sha256").update(JSON.stringify([runId, input.expectedTaskFailureIndex, input.expectedRunFailureIndex])).digest("hex")}`,
      }, invocation);
      const recovered = recordOf(response.result?.output);
      if (recovered?.delegationId !== delegationId || recovered.sessionId !== root.ownerSessionId ||
          recovered.finalized === true || (recovered.state !== "running" && recovered.state !== "done") || recovered.error !== undefined) {
        throw new Error("Native root delegation recovery did not confirm the same live owner session; Swarm remains failed.");
      }
      await this.append(runId, [event]);
      return this.requireRun(runId);
    });
  }
  async setRoleModels(input: SwarmRunSetRoleModelsInput, invocation: InvocationContext): Promise<SwarmRun> {
    const runId = requiredString(input.runId, "runId");
    await this.getRootAuthorized({ runId }, invocation);
    validateSwarmRoleModels(input.roleModels);
    const reason = requiredString(input.reason, "reason");
    this.viewInvocations.set(runId, invocation);
    return this.withStateTransition(async () => {
      const current = await this.requireRun(runId);
      const root = current.tasks.find((task) => task.parentTaskId === undefined)!;
      if (!root.ownerSessionId || !root.ownerPrincipalId || root.ownerSessionId !== optionalCallerSessionId(invocation) || root.ownerPrincipalId !== invocation.principal.id)
        throw new Error("Only the original root owner may update role models.");
      const event: SwarmRunUpdateEvent = {
        type: "run.roleModelsUpdated", roleModels: input.roleModels, reason,
        ownerSessionId: root.ownerSessionId, ownerPrincipalId: root.ownerPrincipalId,
      };
      replaySwarmRun([...(await this.options.eventStore.read(runId)), event]);
      await this.append(runId, [event]);
      // Policy changes never dispatch or mutate an already-created session.
      return this.requireRun(runId);
    });
  }
  drive(
    input: SwarmRunInput,
    invocation: InvocationContext,
  ): Promise<SwarmRun> {
    const runId = requiredString(input.runId, "runId");
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
    const surfaced = new Map<string, string>();
    while (true) {
      const run = await this.requireRun(runId);
      if (run.legacyReadOnly)
        throw new Error(
          "Legacy runs are read-only. Start a new explicit-protocol run.",
        );
      if (TERMINAL_RUN_STATES.has(run.state)) return run;
      if (run.state === "paused") return run;
      const failedDependencies = run.tasks
        .filter((task) => task.state === "pending")
        .flatMap((task) => {
          const failed = (task.dependencyTaskIds ?? []).filter(
            (id) =>
              run.tasks.find((dependency) => dependency.taskId === id)
                ?.state === "failed",
          );
          return failed.length
            ? [
                {
                  type: "task.failed" as const,
                  taskId: task.taskId,
                  error: `Required dependency failed: ${failed.join(", ")}. The parent may launch replacement work.`,
                },
              ]
            : [];
        });
      if (failedDependencies.length) {
        await this.appendWhileRunning(runId, failedDependencies);
        continue;
      }
      for (const ready of executableSwarmTasks(run)) {
        const taskId = ready.task.taskId;
        const heldKey = JSON.stringify([runId, taskId]);
        if (this.heldWakeups.delete(heldKey)) surfaced.delete(taskId);
        if (inFlight.has(taskId) || this.heldContinuations.has(heldKey)) continue;
        const signature = JSON.stringify([
          ready.task.resumeCount ?? 0,
          ready.task.idleReminders ?? 0,
          ready.childResults,
        ]);
        if (surfaced.get(taskId) === signature) continue;
        if (!ready.task.resumeReason && ready.childResults.length > 0 &&
            ready.task.childAttentionSignature === childAttentionSignature(ready)) continue;
        surfaced.set(taskId, signature);
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
        const latest = await this.requireRun(runId);
        if (executableSwarmTasks(latest).some((ready) =>
          this.heldWakeups.has(JSON.stringify([runId, ready.task.taskId])))) continue;
        return latest;
      }
      const settled = await Promise.race([
        ...inFlight.values(),
        new Promise<undefined>((resolve) => {
          setTimeout(resolve, 250);
        }),
      ]);
      if (!settled) continue;
      inFlight.delete(settled.taskId);
      if (await this.stopped(runId)) return this.requireRun(runId);
      if (settled.outcome.continuationHeld) {
        this.waitForHeldContinuation(runId, settled.outcome.ready, invocation);
        continue;
      }
      if (await this.recordOutcome(runId, settled.outcome)) {
        this.waitForHeldContinuation(runId, settled.outcome.ready, invocation);
      }
      await this.finishRun(runId);
    }
  }
  private waitForHeldContinuation(
    runId: string,
    ready: ExecutableTask,
    invocation: InvocationContext,
  ): void {
    const delegationId = ready.task.delegationId;
    if (!delegationId) return;
    const key = JSON.stringify([runId, ready.task.taskId]);
    if (this.heldContinuations.has(key)) return;
    // A busy owner can itself be calling a Swarm tool. Never await its turn
    // from that tool: return the held result and observe idle in the background.
    const waiting = Promise.resolve().then(async () => {
      let snapshot: Readonly<Record<string, unknown>> | undefined;
      do {
        [snapshot] = await Promise.all([
          this.waitForAgent(delegationId, invocation),
          new Promise<void>((resolve) => setTimeout(resolve, 250)),
        ]);
        if (await this.stopped(runId)) return;
      } while (snapshot?.state === "running" || snapshot?.state === "pending");
      if (!["done", "completed", "idle"].includes(stringValue(snapshot?.state) ?? ""))
        throw new Error(errorText(snapshot?.error, "Held continuation native wait did not reach idle."));
      const current = await this.requireRun(runId);
      const task = current.tasks.find((entry) => entry.taskId === ready.task.taskId);
      if (current.state !== "running" || task?.state !== "running" ||
          task.delegationId !== delegationId || task.resumeCount !== ready.task.resumeCount) return;
      this.heldContinuations.delete(key);
      this.heldWakeups.add(key);
      await this.drive({ runId }, invocation);
      // If idle arrived during the preceding drive's final await, consume the
      // still-pending wake in a fresh drive. A consumed wake never dispatches twice.
      if (this.heldWakeups.has(key) && !(await this.stopped(runId)))
        await this.drive({ runId }, invocation);
    }).catch(async (error: unknown) => {
      // A stale pause/cancellation observer cannot fail a newer task attempt.
      const current = await this.requireRun(runId);
      const task = current.tasks.find((entry) => entry.taskId === ready.task.taskId);
      if (current.state !== "running" || task?.state !== "running" ||
          task.delegationId !== delegationId || task.resumeCount !== ready.task.resumeCount) return;
      await this.recordOutcome(runId, { ready, error: plainError(error) });
      await this.finishRun(runId);
    }).finally(() => {
      if (this.heldContinuations.get(key) === waiting) this.heldContinuations.delete(key);
    });
    this.heldContinuations.set(key, waiting);
    void waiting.catch((error: unknown) => console.warn("Held continuation recovery failed.", error));
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
      const pauseReason = pauseReasonForError(error, ready.task.taskId);
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
        error: launch.error ?? "Delegation did not start.",
      };
    }
    const current = await this.requireRun(runId);
    if (current.state === "paused") {
      const pauseReason = current.pauseReason;
      if (pauseReason === undefined) {
        throw new Error(`Paused swarm run "${runId}" has no pause reason.`);
      }
      await this.pauseAgent(
        launch.delegationId,
        pauseReason.message,
        invocation,
      );
      return { ready, error: "Run paused." };
    }
    if (current.state !== "running") {
      await this.cancelAgent(launch.delegationId, invocation);
      return { ready, error: "Run stopped." };
    }
    if (launch.continuationHeld) return { ready, continuationHeld: true };
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
        `Waiting for delegation "${launch.delegationId}" for task ` +
          `"${ready.task.taskId}" failed: ${plainError(error)}.`,
        { cause: error },
      );
    }
    const diskFullReason = diskFullPauseReason(
      delegation?.error,
      ready.task.taskId,
    );
    if (diskFullReason !== undefined) {
      await this.pauseRun(runId, diskFullReason, invocation);
      return { ready, error: diskFullReason.message };
    }
    const currentTask = (await this.requireRun(runId)).tasks.find(
      (t) => t.taskId === ready.task.taskId,
    );
    const execution = currentTask?.executions.find(
      (e) => e.delegationId === launch.delegationId,
    );
    if (execution && currentTask && delegation) {
      const receipt = executionReceipt(currentTask, delegation);
      if (receipt) await this.append(runId, [receipt]);
    }
    const state = stringValue(delegation?.state) ?? "failed";
    const changeRefs = optionalChangeRefs(delegation?.changeRefs);
    if (completionRejectedForLiveDescendant(delegation?.error)) {
      return {
        ready,
        error: DESCENDANT_INTEGRATION_REJECTION,
        ...(changeRefs === undefined ? {} : { changeRefs }),
      };
    }
    if (state !== "done" && state !== "completed" && state !== "idle") {
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
    const fieldGuide = (await tryGetSwarmSharedContextService(
      this.serviceContainer,
    )?.read(runId)) ?? {
      path: "Not configured",
      content: "No shared Field Guide has been configured for this run.",
    };
    const baseline = await tryGetSwarmBaselineService(
      this.serviceContainer,
    )?.resolve(runId, task.scope);
    const prompt = promptFor(ready, fieldGuide, run, baseline);
    if (task.state === "pending") {
      return this.withStateTransition(async () => {
        const currentRun = await this.requireRun(runId);
        if (currentRun.state !== "running") {
          return { ready, error: "Run stopped." };
        }
        const currentTask = currentRun.tasks.find(
          (entry) => entry.taskId === task.taskId,
        );
        if (currentTask === undefined) {
          return { ready, error: `Task "${task.taskId}" no longer exists.` };
        }
        if (
          currentTask.state === "running" &&
          currentTask.delegationId !== undefined
        ) {
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
    if ((await this.requireRun(runId)).state !== "running") {
      return { ready, error: "Run stopped." };
    }
    if (task.executions.at(-1)?.dispatchState === "registered")
      return this.spawnTask(
        runId,
        run,
        ready,
        task,
        prompt,
        baseline,
        invocation,
      );
    const delegationId = requiredString(
      task.delegationId,
      `Task "${task.taskId}" delegationId`,
    );
    if (task.resumeReason) {
      const continued = await this.continueAgent(
        delegationId,
        `Explicit task resolution: ${task.resumeReason}\n${prompt}`,
        invocation,
      );
      if (continued?.error)
        return launchFailure(ready, continued, undefined, "continue");
      if (continued?.continuationDelivery === "held")
        return { ready, delegationId, continuationHeld: true };
      await this.appendWhileRunning(runId, [
        { type: "task.continued", taskId: task.taskId },
        ...(ready.childResults.length ? [{ type: "task.childrenNotified" as const, taskId: task.taskId, signature: childAttentionSignature(ready) }] : []),
      ]);
      return { ready, delegationId };
    }
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
      await this.appendWhileRunning(runId, [{
        type: "task.childrenNotified", taskId: task.taskId, signature: childAttentionSignature(ready),
      }]);
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
      if (currentRun.state !== "running") {
        return { ready, error: "Run stopped." };
      }
      const currentTask = currentRun.tasks.find(
        (entry) => entry.taskId === ready.task.taskId,
      );
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
  private resolveRoleModel(
    role: SwarmTaskRole,
    configuration: Pick<SwarmRunCreateInput, "roleModels" | "workerModel" | "workerReasoningEffort">,
    run?: SwarmRun,
  ) {
    // Explicit selections are complete policies: never consult a possibly invalid
    // host default before honoring them, including when replaying a saved run.
    const explicit = configuration.roleModels?.[role];
    if (explicit) return { ...explicit };
    if (role === "worker" && configuration.workerModel) return {
      model: configuration.workerModel,
      reasoningEffort: configuration.workerReasoningEffort ?? DEFAULT_WORKER_REASONING_EFFORT,
    };
    const host = tryGetSwarmRoleModelService(this.serviceContainer)?.resolve(role, run);
    return role === "worker" ? {
      model: host?.model ?? DEFAULT_WORKER_MODEL,
      reasoningEffort: configuration.workerReasoningEffort ?? host?.reasoningEffort ?? DEFAULT_WORKER_REASONING_EFFORT,
    } : host;
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
    const parentDelegationId =
      task.parentTaskId === undefined
        ? undefined
        : run.tasks.find((entry) => entry.taskId === task.parentTaskId)
            ?.delegationId;
    const configuredRoleModel = this.resolveRoleModel(task.role, run, run);
    const callerSession = optionalCallerSessionId(invocation);
    const reserved =
      task.executions.at(-1)?.dispatchState === "registered"
        ? task.executions.at(-1)
        : undefined;
    if (reserved?.launchInput && configuredRoleModel?.model &&
      (reserved.launchInput.model !== configuredRoleModel.model ||
        reserved.launchInput.reasoningEffort !== configuredRoleModel.reasoningEffort)) {
      return { ready, error: `Reserved dispatch "${reserved.executionId}" conflicts with the current ${task.role} model policy; no dispatch was sent.` };
    }
    const roleModel = reserved?.launchInput
      ? { model: stringValue(reserved.launchInput.model), reasoningEffort: stringValue(reserved.launchInput.reasoningEffort) }
      : configuredRoleModel;
    const executionId =
      reserved?.executionId ??
      `swarm:${runId}:${task.taskId}:${task.executions.length}`;
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
      ...(this.reuseCallerSessions.has(runId) &&
      task.parentTaskId === undefined &&
      callerSession
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
            ...(roleModel?.reasoningEffort
              ? { reasoningEffort: roleModel.reasoningEffort }
              : {}),
          },
        },
      ]);
    const spawned = await this.delegationCall(
      "runtime.delegation.spawn",
      launchInput,
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
      return launchFailure(ready, delegation, spawned.error, "start");
    }
    await this.append(runId, [
      {
        type: "task.execution",
        taskId: task.taskId,
        execution: {
          executionId,
          kind: "dispatch",
          dispatchState: "dispatched",
          startedAt: reserved?.startedAt ?? new Date().toISOString(),
          delegationId,
          ...(stringValue(delegation?.sessionId)
            ? { sessionId: stringValue(delegation?.sessionId) }
            : {}),
          ...(stringValue(delegation?.transcriptRef)
            ? { transcriptRef: stringValue(delegation?.transcriptRef) }
            : {}),
          ...(roleModel?.model ? { model: roleModel.model } : {}),
          ...(roleModel?.reasoningEffort
            ? { reasoningEffort: roleModel.reasoningEffort }
            : {}),
        },
      },
    ]);
    return { ready: { ...ready, task }, delegationId };
  }
  private async waitForAgent(
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
  private async continueAgent(
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
  private async recordOutcome(
    runId: string,
    outcome: AgentOutcome,
  ): Promise<boolean | void> {
    if (await this.stopped(runId)) return;
    const run = await this.requireRun(runId);
    const task = run.tasks.find(
      (entry) => entry.taskId === outcome.ready.task.taskId,
    );
    if (
      task === undefined ||
      task.state === "completed" ||
      task.state === "failed"
    ) {
      return;
    }
    if (
      (task.state !== "running" && task.state !== "pending") ||
      task.resumeCount !== outcome.ready.task.resumeCount
    )
      return;
    if (completionRejectedForLiveDescendant(outcome.error)) return;
    if (outcome.error !== undefined) {
      await this.failTask(runId, task, outcome.error, outcome.changeRefs);
      return;
    }
    if (
      task.state !== "running" ||
      task.resumeCount !== outcome.ready.task.resumeCount
    )
      return;
    const liveChildren = run.tasks.some(
      (child) => child.parentTaskId === task.taskId && !isTerminalTask(child),
    );
    if (!liveChildren && (task.idleReminders ?? 0) >= 2) {
      await this.appendWhileRunning(runId, [
        {
          type: "task.blocked",
          taskId: task.taskId,
          reason:
            "Agent remained idle without an explicit outcome after two reminders; explicit resolution is required.",
        },
      ]);
      return;
    }
    if (!liveChildren && (task.idleReminders ?? 0) < 2 && task.delegationId) {
      const stillRunning =
        (await this.requireRun(runId)).tasks.find(
          (t) => t.taskId === task.taskId,
        )?.state === "running";
      if (!stillRunning) return;
      const invocation = this.viewInvocations.get(runId);
      if (invocation) {
        const continued = await this.continueAgent(
          task.delegationId,
          "Your conversation is idle but the owned Swarm task remains running. Use swarm.nodes.complete after acceptance, or block/fail with a reason. Conversational final text does not complete the task.",
          invocation,
        );
        if (continued?.continuationDelivery === "held") return true;
        await this.appendWhileRunning(runId, [
          { type: "task.reminded", taskId: task.taskId },
        ]);
      }
    }
    // A conversational final answer is telemetry only. Lifecycle changes require
    // authenticated swarm.nodes operations, never JSON extracted from narration.
  }
  private async failTask(
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
        ...(error === SWARM_OWNER_SESSION_BUSY_ERROR ? { failureCode: "SESSION_BUSY" as const } : {}),
        ...(changeRefs === undefined ? {} : { changeRefs }),
      },
    ]);
  }
  private async finishRun(runId: string): Promise<void> {
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
        await this.append(runId, [
          {
            type: "run.failed",
            error: root.error ?? "Root task failed.",
          },
        ]);
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
    // The journal is authoritative. A failed presentation must not prevent the
    // subsequent delegation launch/pause or make a committed mutation look failed.
    try {
      await this.publishView(runId);
    } catch (error) {
      console.warn("Swarm view refresh failed; durable task state was preserved.",
        error instanceof Error ? error.message.slice(0, 512) : "Runtime UI unavailable");
    }
  }
  private async publishView(runId: string): Promise<void> {
    const invocation = this.viewInvocations.get(runId);
    if (!invocation) return;
    await publishSwarmRunView(
      await this.requireRun(runId),
      invocation,
      (request, context) => this.factory.execute(request, context),
    );
  }
  private async stopped(runId: string): Promise<boolean> {
    return (await this.requireRun(runId)).state !== "running";
  }
  private appendWhileRunning(
    runId: string,
    events: readonly SwarmRunUpdateEvent[],
  ): Promise<void> {
    return this.withStateTransition(async () => {
      if ((await this.requireRun(runId)).state !== "running") return;
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
      if (TERMINAL_RUN_STATES.has(run.state)) {
        return run;
      }
      if (run.state !== "paused") await this.append(runId, [
        {
          type: "run.paused",
          reason,
        },
      ]);
      const paused = await this.requireRun(runId);
      const delegationIds = new Set(
        paused.tasks.flatMap((task) =>
          task.state === "running" && task.delegationId !== undefined
            ? [task.delegationId]
            : [],
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
      "runtime.delegation.pause",
      { delegationId, reason },
      invocation,
    );
  }
  private cancelAgent(
    delegationId: string,
    invocation: InvocationContext,
  ): Promise<RuntimeExecResponse> {
    return this.delegationCall(
      "runtime.delegation.cancel",
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
      targetType: "operation" as const,
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
  action: "start" | "continue",
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
  if (run.state !== "running") return [];
  const childrenByParent = new Map<string, SwarmTask[]>();
  for (const task of run.tasks) {
    if (task.parentTaskId === undefined) continue;
    const children = childrenByParent.get(task.parentTaskId) ?? [];
    children.push(task);
    childrenByParent.set(task.parentTaskId, children);
  }
  return run.tasks.flatMap((task): ExecutableTask[] => {
    const children = childrenByParent.get(task.taskId) ?? [];
    if (task.state === "pending") {
      return (task.dependencyTaskIds ?? []).every(
        (id) => run.tasks.find((t) => t.taskId === id)?.state === "completed",
      )
        ? [{ task, childResults: [], outstanding: [] }]
        : [];
    }
    if (task.state !== "running" || task.delegationId === undefined) return [];
    if (children.length === 0) {
      return [{ task, childResults: [], outstanding: [] }];
    }
    // A blocker requires parent attention but remains live for completion and dependencies.
    const outcomes = children.filter((child) => isTerminalTask(child) || child.state === "blocked");
    if (outcomes.length === 0 && !task.resumeReason) return [];
    return [
      {
        task,
        childResults: outcomes.map((child) => ({
          state: child.state,
          reason: child.reason,
          // The same reason after a resume is a new notification.
          resumeCount: child.resumeCount ?? 0,
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
            state: child.state,
            reason: child.reason,
            taskId: parentLocalTaskId(task.taskId, child.taskId),
            role: child.role,
            scope: child.scope,
            objective: child.objective,
          })),
      },
    ];
  });
}
function childAttentionSignature(ready: ExecutableTask): string {
  return createHash("sha256").update(JSON.stringify(ready.childResults)).digest("hex");
}
function isTerminalTask(task: SwarmTask): boolean {
  return task.state === "completed" || task.state === "failed";
}
function permittedScopeNames(
  run: SwarmRun,
  task: SwarmTask,
): readonly string[] {
  const targets = declaredTargetScopes(run);
  return [...(targets ?? new Set([task.scope]))];
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
    throw new TypeError("targets must be an array.");
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
        `Run "${run.runId}" cannot resume: task "${task.taskId}" scope ` +
          `"${task.scope}" is not one of the declared repository targets.`,
      );
    }
  }
}
function parentLocalTaskId(parentTaskId: string, taskId: string): string {
  const prefix = `${parentTaskId}/`;
  if (!taskId.startsWith(prefix)) return taskId;
  return decodeURIComponent(taskId.slice(prefix.length));
}
function promptFor(
  ready: ExecutableTask,
  fieldGuide: SwarmSharedContext,
  run: SwarmRun,
  baseline?: SwarmBaseline,
): string {
  const task = ready.task;
  const childOutcomes = ready.childResults.map((child) => ({
    state: child.state,
    ...(child.reason === undefined ? {} : { reason: child.reason }),
    taskId: child.taskId,
    role: child.role,
    ...(child.result === undefined ? {} : { result: child.result }),
    ...(child.error === undefined ? {} : { error: child.error }),
    changeRefs: child.changeRefs ?? [],
  }));
  const fieldGuidePath = requiredString(fieldGuide.path, "Field Guide path");
  if (typeof fieldGuide.content !== "string") {
    throw new TypeError("Field Guide content must be a string.");
  }
  const nodePosition = task.parentTaskId === undefined ? "root" : "descendant";
  const turnPhase =
    childOutcomes.length === 0
      ? "initial"
      : "resumed with direct child outcomes";
  const scopeTarget = swarmRunTargets(run).find(
    (target) => target.scope === task.scope,
  );
  const targetRef = scopeTarget?.ref ?? run.targetRef ?? "not recorded";
  const targetHead = scopeTarget?.head ?? run.targetHead ?? "not recorded";
  return [
    "# Current swarm task",
    "",
    `- Node: ${nodePosition}`,
    `- Turn: ${turnPhase}`,
    `- Role: ${task.role}`,
    `- Repository scope: ${task.scope}`,
    `- Original target ref: ${targetRef}`,
    `- Original target head: ${targetHead}`,
    `- Latest integration baseline ref: ${baseline?.ref ?? "not resolved"}`,
    `- Latest integration baseline head: ${baseline?.head ?? "not resolved"}`,
    `- Baseline ref: ${baseline?.ref ?? "not resolved"}`,
    `- Baseline head: ${baseline?.head ?? "not resolved"}`,
    `- Scope target ref: ${targetRef}`,
    `- Scope target head: ${targetHead}`,
    "",
    ...(task.parentTaskId === undefined
      ? []
      : [
          "## Overall swarm goal (context only)",
          "",
          run.objective,
          "",
          "This supplies the original constraints and acceptance context; it does not authorize work outside this task or its repository scope.",
          "",
        ]),
    "## Objective",
    "",
    task.objective,
    "",
    "## Direct child outcomes",
    "",
    JSON.stringify(childOutcomes),
    "",
    ...siblingRosterSection(task, run),
    ...outstandingSection(ready.outstanding),
    "## Shared Field Guide",
    "",
    `- Absolute path: ${fieldGuidePath}`,
    "",
    "--- FIELD GUIDE START ---",
    fieldGuide.content,
    "--- FIELD GUIDE END ---",
    "",
    ...topicSections(fieldGuide),
    "Read the Field Guide for concise durable design decisions and surprising repository facts.",
    "Only the planner ownership rules below permit editing any Field Guide file.",
    "",
    "## Role contract",
    "",
    ...roleInstructions(task),
    "",
    "## Response interface",
    "",
    "Use the TypeScript runtime capabilities swarm.nodes.list/get/launch/publishArtifact/block/fail/complete/resume for all task lifecycle changes.",
    "These are broker capability names, not an ambient swarm object or separate native tools. Invoke them through runtimeInvoke({capability: \"swarm.nodes.<operation>\", input: {...}}). For runtimeExecuteTypeScript, use: export default async (input, context) => context.runtime.invoke(\"swarm.nodes.<operation>\", input); Pass the capability arguments as the tool input. The second function argument is a context containing runtime; invoke takes the capability name and input as two positional arguments and returns the capability output directly.",
    "For discovery, use runtimeSearch({name: \"swarm.nodes.<operation>\"}) with the exact capability name. A failure in unrelated catalog search does not imply this capability is unavailable; direct invocation remains the supported path for known capabilities.",
    `Your durable identity is runId=${run.runId}, taskId=${task.taskId}.`,
    "Launch input: {runId,parentTaskId,taskId,role,objective,scope,dependencyTaskIds?,idempotencyKey}. taskId is parent-local. Only planners may launch children; child scope must be a declared repository.",
    "Before completing, publish an artifact reference through swarm.nodes.publishArtifact with {runId,taskId,artifact:{uri,kind,summary}}. Required artifact kinds: planner uses plan, decision, or report; reviewer uses review; reconciler uses reconciliation. Write a readable decision/action/rationale summary to that file; never publish hidden chain-of-thought. An inline artifact passed to swarm.nodes.complete does not publish a reference.",
    "Complete explicitly with {runId,taskId,commits?:string[]}; code output is a simple commits list. Block or fail with {runId,taskId,reason}. Blocked work resumes only after explicit resume with a resolution reason.",
    "Your final conversational response does not launch children or complete this task. Pending children start once dependencies complete. Inspect sibling ownership and publish shared decisions before dependent work.",
  ].join("\n");
}
function siblingRosterSection(task: SwarmTask, run: SwarmRun): string[] {
  const parentTaskId = task.parentTaskId;
  if (parentTaskId === undefined) return [];
  const siblings = run.tasks.filter(
    (entry) =>
      entry.parentTaskId === parentTaskId &&
      entry.taskId !== task.taskId &&
      !isTerminalTask(entry),
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
    "## Sibling ownership",
    "",
    "These tasks share your parent. Do not decide or redefine a shared " +
      "interface or exported symbol another sibling owns; defer any shared " +
      "contract to your nearest common planner.",
    JSON.stringify(roster),
    "",
  ];
}
function outstandingSection(
  outstanding: readonly OutstandingChild[],
): string[] {
  if (outstanding.length === 0) return [];
  return [
    "## Outstanding children",
    "",
    "These direct children are still live. You may react to the outcomes above " +
      "and delegate more work, but you may not complete while any child remains " +
      "outstanding. Blocked children need your decision or resolution; inspect their reason and use swarm.nodes.resume only once it is resolved.",
    JSON.stringify(outstanding),
    "",
  ];
}
function topicSections(fieldGuide: SwarmSharedContext): string[] {
  const topics = fieldGuide.topics ?? [];
  return topics.flatMap((topic) => {
    const path = requiredString(topic.path, "Field Guide topic path");
    if (typeof topic.content !== "string") {
      throw new TypeError("Field Guide topic content must be a string.");
    }
    return [
      `--- FIELD GUIDE TOPIC: ${path} ---`,
      topic.content,
      "--- FIELD GUIDE TOPIC END ---",
      "",
    ];
  });
}
const ROLE_INSTRUCTIONS: Readonly<Record<SwarmTaskRole, readonly string[]>> = {
  planner: [
    "Own material architecture and shared-contract decisions before delegating implementation; then delegate coherent outcomes without editing implementation files yourself.",
    "If substantial design remains unresolved, delegate it to a planner child that resolves the design and delegates its implementation; routine implementation choices remain with workers.",
    "An architectural designer is a planner: it must resolve architecture and delegate implementation, and may not terminate as a leaf.",
    "Choose boundaries by coherent outcomes and independent decision lanes, not by file count or a one-worker-per-file rule.",
    "Good delegation identifies independent outcomes promptly and may use parallel lanes; use the run-specific permitted scope names shown in the response interface rather than copying a scope literal from an example.",
    "For example, a planner may resolve the shared storage contract first, then delegate one worker to implement the cohesive library and extension against it.",
    "Normally assign each coherent implementation outcome to one worker, even when it spans related files, helpers, exports, and tests; do not split merely to create smaller leaves.",
    "When sibling subtrees genuinely share a TypeScript interface or exported symbol, decide that contract here at the nearest common planner, record it in your owned topic file, and assign one owner to land it before dependent work. A separate boundary-only worker is optional, not mandatory; a coherent implementation worker may own the boundary when that is the useful outcome. Never implement it yourself and never let two subtrees decide or redefine the same exported contract.",
    "Use planner children only when a material design or architecture decision remains unresolved or implementation lanes are genuinely independent.",
    "Do not perform exhaustive repository or node_modules inventories. Inspect only enough to define owned outcomes and concrete boundaries.",
    "Give children disjoint decision ownership, include every relevant Field Guide decision, user constraint, acceptance condition, repository identity/ref, and relative implementation paths in their objectives. Children edit only their assigned checkout; name external source paths as read-only references and keep each child within one repository scope. All delegated work, including repairs, uses swarm.nodes.launch with the appropriate planner, worker, reviewer, or reconciler role; native task, fleet, agent, or CLI spawning tools are not alternate Swarm delegation.",
    "For example, if an executable repair is needed, launch a worker child for that repair with its relative paths and acceptance conditions; the executor creates and tracks it.",
    "For executable outcomes, assign the original required end-to-end check to a coherent worker outcome and claim completion only when its acceptance is achieved; report any remaining limitation when blocked.",
    "A planner checkout may remain at an older revision than the latest integration baseline. Missing files there do not prove missing integration: inspect the supplied latest baseline ref/head and child-ref ancestry or containment before requesting reconciliation, reuse actual child verification for the same integrated ref, and repeat it only for relevant changes or missing coverage.",
    "Never merge sibling work. Use a neutral reconciler only when sibling refs genuinely need integration, a real conflict or missing integration must be resolved, or neutral resolution is otherwise needed; do not create one solely to re-cherry-pick a single usable patch.",
    "Request decorrelated read-only review lenses for an integrated subtree once its change ref has advanced, using judgment and risk rather than a mandatory cadence or fixed set of lenses.",
    "Triage review findings once; delegate only actionable repairs. Fold repairs into the next review of an advanced change ref rather than creating an automatic review or reconcile cycle for each repair.",
    "Report capacity, session, worktree, or tooling failures upward; do not answer them with replacement child fan-out.",
    "When a focused intentional core break is worthwhile, return the rationale for durable curation and delegate downstream repair leaves rather than preserving ossified behavior.",
  ],
  worker: [
    "Implement the coherent owned outcome, including its related files, helpers, exports, and tests; do not merge sibling work.",
    "Perform repository edits and Git operations in your assigned working directory/worktree. Translate original or canonical repository paths to equivalent paths there; explicit external source references may be read, but do not write to another checkout.",
    "For an executable outcome, run the smallest actual user-requested end-to-end check in the real host and report the command and result plainly; syntax checks or guessed/static outputs are not substitutes. Own ordinary failures within your scope by fixing and rerunning the same check; report only concrete blockers outside your ability or authority, and do not claim completion until the objective acceptance is achieved.",
    "When your objective names a shared interface or exported symbol owned by another task, import that named symbol; never redefine or re-export it. If it has not landed yet, return a plain blocker instead of inventing your own.",
    "When your objective is a boundary task, land exactly the exported TypeScript interface or symbol named in the objective so siblings can import it; do not implement unrelated behavior in the same task.",
    "A research objective returns ranked options, evidence, and a recommendation; it may also write a concise durable report artifact outside the Field Guide and return its short path or link. It must not introduce any new exported symbol or edit implementation files.",
    'Research is a worker role: use role "worker" with a research objective; do not invent a separate leaf role.',
    "Never edit the Field Guide. If a genuinely bloated or high-contention megafile blocks safe work, return its path and reason without adding more code to it.",
    "A focused intentional core break is allowed when the objective requires it. Return the rationale to the parent planner.",
    "Implement the owned outcome or report the concrete blocker that prevents it. The runtime carries your ordinary change reference separately.",
  ],
  reconciler: [
    "Act as a neutral integrator; do not favor any sibling implementation.",
    "Perform repository edits and Git operations in your assigned working directory/worktree. Translate original or canonical repository paths to equivalent paths there; explicit external source references may be read, but do not write to another checkout.",
    "Apply the sibling change refs named in the objective in this fresh worktree, resolve conflicts impartially, and commit one integrated result.",
    "When assigned as the root reconciler, apply only named implementation refs not already contained in the latest integration baseline shown above. If all named refs are contained and correct, return that existing ref without creating a new commit; otherwise commit the real integration.",
    "Never edit the Field Guide. Return any contradictory durable decisions to the parent planner.",
    "Return the integrated outcome or a plain blocker. The runtime carries your integrated change reference separately.",
  ],
  reviewer: [
    "Review only; do not edit the repository or Field Guide, merge, or repair.",
    'Inspect the integrated result through the distinct lens named in the objective and return {"reviewed":true,"findings":[...]} with concrete, actionable findings for the parent planner.',
    "Check the current Field Guide and original objective where relevant. Do not invent a score, quorum, approval record, or review ledger.",
  ],
};
function roleInstructions(task: SwarmTask): readonly string[] {
  if (task.role !== "planner") return ROLE_INSTRUCTIONS[task.role];
  const guideOwnership =
    task.parentTaskId === undefined
      ? [
          "You are the only owner of field-guide/index.md. Keep it small: curate only durable global decisions, surprising facts, and links to explicitly assigned topic files.",
          "Own assembly of the whole product: arrange any needed neutral integration and read-only review of the assembled product when it is ready. This obligation does not impose a fixed topology, stage sequence, fan-out, or depth.",
        ]
      : [
          "Never edit field-guide/index.md. You may edit only one explicit topic file when its exact path and single-writer ownership are assigned in this objective; otherwise do not edit the Field Guide.",
        ];
  return [...guideOwnership, ...ROLE_INSTRUCTIONS.planner];
}
function executionReceipt(
  task: SwarmTask,
  value: Readonly<Record<string, unknown>>,
): SwarmRunUpdateEvent | undefined {
  const receiptId = stringValue(value.executionId);
  const matched = receiptId
    ? task.executions.find((e) => e.executionId === receiptId)
    : undefined;
  if (task.state === "completed" && receiptId && !matched) return undefined;
  const previous =
    matched ??
    task.executions.filter((e) => e.delegationId === task.delegationId).at(-1);
  if (!previous) return undefined;
  const usage = recordOf(value.usage);
  return {
    type: "task.execution",
    taskId: task.taskId,
    execution: {
      ...previous,
      executionId: receiptId ?? previous.executionId,
      kind: "turn",
      ...(receiptId && receiptId !== previous.executionId
        ? {
            usage: undefined,
            usageByModel: undefined,
            startedAt: new Date().toISOString(),
          }
        : {}),
      completedAt: new Date().toISOString(),
      ...(stringValue(value.transcriptRef)
        ? { transcriptRef: stringValue(value.transcriptRef) }
        : {}),
      ...(stringValue(value.model) ? { model: stringValue(value.model) } : {}),
      ...(stringValue(value.reasoningEffort)
        ? { reasoningEffort: stringValue(value.reasoningEffort) }
        : {}),
      ...(Array.isArray(value.usageByModel)
        ? {
            usageByModel: value.usageByModel.map((raw) => {
              const entry = recordOf(raw);
              const measured = recordOf(entry?.usage);
              if (!measured) throw new Error("Invalid model usage receipt.");
              return {
                ...(stringValue(entry?.model)
                  ? { model: stringValue(entry?.model) }
                  : {}),
                usage: {
                  ...(typeof measured.inputTokens === "number"
                    ? { inputTokens: measured.inputTokens }
                    : {}),
                  ...(typeof measured.outputTokens === "number"
                    ? { outputTokens: measured.outputTokens }
                    : {}),
                  ...(typeof measured.cachedInputTokens === "number"
                    ? { cachedInputTokens: measured.cachedInputTokens }
                    : {}),
                  ...(typeof measured.costUsd === "number"
                    ? { reportedCost: measured.costUsd }
                    : {}),
                },
              };
            }),
          }
        : {}),
      ...(usage
        ? {
            usage: {
              ...(typeof usage.inputTokens === "number"
                ? { inputTokens: usage.inputTokens }
                : {}),
              ...(typeof usage.outputTokens === "number"
                ? { outputTokens: usage.outputTokens }
                : {}),
              ...(typeof usage.cachedInputTokens === "number"
                ? { cachedInputTokens: usage.cachedInputTokens }
                : {}),
              ...(typeof usage.costUsd === "number"
                ? { reportedCost: usage.costUsd }
                : {}),
            },
          }
        : {}),
    },
  };
}

function recordOf(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}
function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value.trim();
}
function callerSessionId(invocation: InvocationContext): string {
  const sessionId = optionalCallerSessionId(invocation);
  if (!sessionId) throw new TypeError("Swarm create requires a session scope.");
  return sessionId;
}
function optionalCallerSessionId(
  invocation: InvocationContext,
): string | undefined {
  const sessionId = invocation.scope?.sessionId?.trim();
  return sessionId || undefined;
}
function callerWorkspace(invocation: InvocationContext): string | undefined {
  const metadata = invocation.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
    return undefined;
  const name = (
    metadata as {
      marshalWorkspaceName?: unknown;
    }
  ).marshalWorkspaceName;
  return typeof name === "string" && name.trim() ? name.trim() : undefined;
}
function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, label);
}
function requiredRole(value: unknown, label: string): SwarmTaskRole {
  switch (value) {
    case "planner":
    case "worker":
    case "reconciler":
    case "reviewer":
      return value;
    default:
      throw new TypeError(
        `${label} must be planner, worker, reconciler, or reviewer.`,
      );
  }
}
function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function optionalChangeRefs(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new TypeError("Delegation changeRefs must be an array.");
  }
  return value.map((entry, index) =>
    requiredString(entry, `Delegation changeRefs[${index}]`),
  );
}
function plainError(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  return String(value);
}
function errorText(value: unknown, fallback: string): string {
  if (value === undefined || value === null) return fallback;
  const error = recordOf(value);
  return plainError(error?.message ?? error?.code ?? value);
}
function completionRejectedForLiveDescendant(value: unknown): boolean {
  const error = errorText(value, "");
  return (
    error === DESCENDANT_INTEGRATION_REJECTION ||
    error === ROOT_COMPLETION_RECONCILIATION_REJECTION
  );
}
function environmentalWorktreePauseReason(
  value: unknown,
  taskId: string,
): SwarmPauseReason | undefined {
  const error = recordOf(value);
  if (
    error?.kind !== "environmental" ||
    error.operation !== "worktree.create" ||
    error.attempts !== 3
  ) {
    return undefined;
  }
  const code = stringValue(error.code);
  const category = stringValue(error.category);
  return {
    kind: "environmental",
    operation: "worktree.create",
    taskId,
    attempts: 3,
    message: requiredString(error.message, "Environmental error message"),
    ...(code === undefined ? {} : { code }),
    ...(category === undefined ? {} : { category }),
  };
}
function pauseReasonForError(
  value: unknown,
  taskId: string,
): SwarmPauseReason | undefined {
  return (
    diskFullPauseReason(value, taskId) ??
    environmentalWorktreePauseReason(value, taskId)
  );
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
    kind: "environmental",
    operation: "worktree.create",
    taskId,
    attempts: 3,
    message,
    ...(code === undefined
      ? {}
      : { code: typeof code === "string" ? code : String(code) }),
    category: "disk-full",
  } as SwarmPauseReason;
}
function isDiskFullError(
  value: unknown,
  seen = new WeakSet<object>(),
  contextual = false,
): boolean {
  if (typeof value === "string") {
    if (
      /^-?(28|39)$|enospc|no space left on device|not enough space on (?:the )?disk|not enough disk space|disk(?:\s+is)?\s+full|error_handle_disk_full|error[_ -]?disk[_ -]?full/i.test(
        value,
      )
    )
      return true;
    return contextual && /^(?:error\s*)?112$/i.test(value.trim());
  }
  if (typeof value === "number") {
    return (
      value === 28 ||
      value === -28 ||
      value === 39 ||
      (value === 112 && contextual)
    );
  }
  if (value === null || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (
    value instanceof Error &&
    isDiskFullError(value.message, seen, contextual)
  ) {
    return true;
  }
  const record = recordOf(value);
  if (!record) return false;
  const context =
    contextual ||
    Object.entries(record).some(
      ([key, entry]) =>
        (key === "platform" ||
          key === "os" ||
          key === "system" ||
          key === "operatingSystem" ||
          key === "category" ||
          key === "operation") &&
        typeof entry === "string" &&
        /windows|win32|disk[- ]?full/i.test(entry),
    );
  for (const [key, entry] of Object.entries(record)) {
    if (
      key === "message" ||
      key === "code" ||
      key === "errno" ||
      key === "error" ||
      key === "cause" ||
      key === "details" ||
      key === "innerError" ||
      key === "originalError"
    ) {
      if (isDiskFullError(entry, seen, context)) return true;
    }
  }
  return false;
}
