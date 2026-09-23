import { readSwarmEvidenceFile } from "./read-evidence-file.js";
import { createHash } from "node:crypto";
import type { InvocationContext } from "@marshal/runtime";
import {
  replaySwarmRun,
  SWARM_OWNER_SESSION_BUSY_ERROR,
  SWARM_OWNER_SESSION_SUPERSEDED_ERROR,
  validateSwarmRoleModels,
  type SwarmRun,
  type SwarmRunUpdateEvent,
  type SwarmTaskDefinition,
  type SwarmRoleModels,
  type SwarmArtifactReference,
  type SwarmNodeAck,
} from "./contracts.js";
import { tryGetSwarmTranscriptReaderService } from "./services.js";
import { createSwarmRunId } from "./run-id.js";
import { publishSwarmRunView } from "./view-publish.js";
import type {
  SwarmRunCancelInput,
  SwarmRunCreateInput,
  SwarmRunInput,
  SwarmRunPauseInput,
  SwarmRunRecoverSystemFailureInput,
  SwarmRunSetRoleModelsInput,
} from "./types.js";
import {
  TERMINAL_RUN_STATES,
  isTerminalTask,
  permittedScopeNames,
  normalizeTargets,
  assertResumableScopes,
} from "./executor-tasks.js";
import {
  optionalTrimmed,
  recordOf,
  requiredString,
  callerSessionId,
  optionalCallerSessionId,
  callerWorkspace,
  optionalString,
  requiredRole,
  optionalChangeRefs,
} from "./executor-values.js";
import { SwarmExecutorDrive } from "./executor-drive.js";
export class SwarmExecutor extends SwarmExecutorDrive {
  async create(input: SwarmRunCreateInput, invocation: InvocationContext): Promise<SwarmRun> {
    const objective = requiredString(input.objective, "objective");
    const scope = requiredString(input.scope ?? callerWorkspace(invocation), "scope");
    const runId =
      optionalString(input.runId, "runId") ?? createSwarmRunId(callerSessionId(invocation));
    const targetRef = optionalTrimmed(input.targetRef, "targetRef");
    const targetHead = optionalTrimmed(input.targetHead, "targetHead");
    const targets = input.targets === undefined ? undefined : normalizeTargets(input.targets);
    const workerModel = optionalString(input.workerModel, "workerModel");
    const workerReasoningEffort = optionalString(
      input.workerReasoningEffort,
      "workerReasoningEffort",
    );
    if (input.roleModels !== undefined) validateSwarmRoleModels(input.roleModels);
    const roleModels: SwarmRoleModels = Object.fromEntries(
      (["planner", "reviewer", "worker", "reconciler"] as const).flatMap((role) => {
        const selection = this.resolveRoleModel(role, {
          ...input,
          workerModel,
          workerReasoningEffort,
        });
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
    await this.options.eventStore.create(runId, objective, scope, targetRef, targetHead, targets, {
      ...(workerModel === undefined ? {} : { workerModel }),
      ...(workerReasoningEffort === undefined ? {} : { workerReasoningEffort }),
      ...(Object.keys(roleModels).length ? { roleModels } : {}),
    });
    await this.append(runId, [{ type: "task.added", task: root }]);
    return this.requireRun(runId);
  }
  async get(input: SwarmRunInput): Promise<SwarmRun> {
    return this.requireRun(requiredString(input.runId, "runId"));
  }
  async list(): Promise<readonly SwarmRun[]> {
    return Promise.all(
      (await this.options.eventStore.list()).map((runId) => this.requireRun(runId)),
    );
  }
  async listAuthorized(invocation: InvocationContext): Promise<readonly SwarmRun[]> {
    return (await this.list()).filter((run) => this.canReadRun(run, invocation));
  }
  /** The chat panel shows participation, not every run the account may inspect. */
  async listEvidence(invocation: InvocationContext): Promise<readonly SwarmRun[]> {
    return (await this.listAuthorized(invocation)).filter((run) =>
      Boolean(this.callerTask(run, invocation)),
    );
  }
  async getAuthorized(input: SwarmRunInput, invocation: InvocationContext): Promise<SwarmRun> {
    const run = await this.get(input);
    if (!this.canReadRun(run, invocation))
      throw new Error("Caller does not share this run owner identity.");
    return run;
  }
  async getRootAuthorized(input: SwarmRunInput, invocation: InvocationContext): Promise<SwarmRun> {
    const run = await this.getAuthorized(input, invocation);
    if (run.legacyReadOnly)
      throw new Error("Legacy runs are read-only. Start a new explicit-protocol run.");
    const caller = this.callerTask(run, invocation);
    if (!caller || caller.parentTaskId !== undefined)
      throw new Error("Only the root owner controls the run.");
    return run;
  }
  async openEvidence(runId: string, invocation: InvocationContext): Promise<SwarmRun> {
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
    input: {
      readonly runId: string;
      readonly taskId: string;
      readonly uri: string;
      readonly offset?: number;
    },
    invocation: InvocationContext,
  ) {
    const run = await this.getAuthorized(input, invocation);
    const reader = tryGetSwarmTranscriptReaderService(this.serviceContainer);
    return readSwarmEvidenceFile(
      run,
      input,
      reader ? (request) => reader.read(request, invocation) : undefined,
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
      const task = run.tasks.find(
        (entry) => entry.taskId === requiredString(input.taskId, "taskId"),
      );
      if (!task) throw new Error("Unknown task.");
      return task;
    }
    if (name === "complete") {
      const output = await this.completeNode(runId, input, invocation);
      await this.finishRun(runId);
      this.wakeDrive(runId, this.viewInvocations.get(runId) ?? invocation);
      return output;
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
        throw new Error("Legacy runs are read-only. Start a new explicit-protocol run.");
      if (run.state !== "running") throw new Error("Run is not running.");
      if (
        caller.taskId !== task.taskId &&
        !(name === "resume" && caller.taskId === task.parentTaskId)
      )
        throw new Error("Only the owning task may change this node.");
      if (name === "launch") {
        if (task.role !== "planner") throw new Error("Role cannot launch children.");
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
                JSON.stringify((prior as unknown as Record<string, unknown>)[k]) !==
                JSON.stringify((definition as unknown as Record<string, unknown>)[k]),
            )
          )
            throw new Error("Idempotency key was used with different input.");
          return prior;
        }
        if (task.state !== "running") throw new Error("Only running parents launch children.");
        if (!permittedScopeNames(run, task).includes(definition.scope))
          throw new Error("Child scope is not a declared repository target.");
        for (const id of definition.dependencyTaskIds ?? []) {
          if (id === task.taskId || task.taskId.startsWith(`${id}/`))
            throw new Error("A child cannot depend on its owner or ancestor.");
          if (!run.tasks.some((t) => t.taskId === id)) throw new Error("Unknown dependency.");
        }
        await this.append(runId, [{ type: "task.added", task: definition }]);
        return (await this.requireRun(runId)).tasks.find((t) => t.taskId === definition.taskId);
      }
      if (name === "resume") {
        await this.append(runId, [
          {
            type: "task.resumed",
            taskId,
            reason: requiredString(input.reason, "reason"),
          },
        ]);
      } else if (name === "continue") {
        if (task.state !== "running")
          throw new Error("Only running tasks may request another turn.");
        await this.append(runId, [
          {
            type: "task.continuationRequested",
            taskId,
            reason: requiredString(input.reason, "reason"),
          },
        ]);
      } else if (task.state !== "running")
        throw new Error("Only running tasks may change state or publish artifacts.");
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
      } else throw new Error(`Unknown node operation ${name}.`);
      const finalTask = (await this.requireRun(runId)).tasks.find((t) => t.taskId === taskId);
      if (name === "resume" || name === "block" || name === "continue")
        return {
          taskId: finalTask!.taskId,
          state: finalTask!.state,
          resumeCount: finalTask!.resumeCount ?? 0,
        } satisfies SwarmNodeAck;
      return finalTask;
    });
    await this.finishRun(runId);
    if (
      name === "launch" ||
      name === "resume" ||
      name === "continue" ||
      name === "complete" ||
      name === "block" ||
      name === "fail"
    )
      this.wakeDrive(runId, this.viewInvocations.get(runId) ?? invocation);
    return output;
  }
  async cancel(input: SwarmRunCancelInput, invocation: InvocationContext): Promise<SwarmRun> {
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
  async pause(input: SwarmRunPauseInput, invocation: InvocationContext): Promise<SwarmRun> {
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
  async resume(input: SwarmRunInput, invocation: InvocationContext): Promise<SwarmRun> {
    const runId = requiredString(input.runId, "runId");
    const ownedRun = await this.getRootAuthorized({ runId }, invocation);
    if (this.callerTask(ownedRun, invocation)?.parentTaskId !== undefined)
      throw new Error("Only the root owner controls the run.");
    this.viewInvocations.set(runId, invocation);
    let resumed = false;
    const run = await this.withStateTransition(async () => {
      const current = await this.requireRun(runId);
      if (TERMINAL_RUN_STATES.has(current.state) || current.state === "running") {
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
      if (
        !root.ownerSessionId ||
        !root.ownerPrincipalId ||
        root.ownerSessionId !== optionalCallerSessionId(invocation) ||
        root.ownerPrincipalId !== invocation.principal.id
      )
        throw new Error("Only the original root owner session may recover a system failure.");
      const event: SwarmRunUpdateEvent = {
        type: "run.systemFailureRecovered",
        taskId: root.taskId,
        classification: input.classification,
        expectedTaskFailureIndex: input.expectedTaskFailureIndex,
        expectedRunFailureIndex: input.expectedRunFailureIndex,
        reason: requiredString(input.reason, "reason"),
        ownerSessionId: root.ownerSessionId,
        ownerPrincipalId: root.ownerPrincipalId,
      };
      const prior = events.find(
        (value) =>
          value.type === "run.systemFailureRecovered" &&
          value.expectedTaskFailureIndex === input.expectedTaskFailureIndex &&
          value.expectedRunFailureIndex === input.expectedRunFailureIndex,
      );
      if (prior) {
        if (JSON.stringify(prior) !== JSON.stringify(event))
          throw new Error("Recovery reference was already used with different input.");
        return run;
      }
      // Validate the complete transition before one durable append. Never dispatch
      // here: the recovered run remains paused until a separate explicit resume.
      replaySwarmRun([...events, event]);
      const delegationId = requiredString(root.delegationId, "Root delegationId");
      const response = await this.delegationCall(
        "runtime.delegation.recover",
        {
          delegationId,
          expectedError:
            input.classification === "owner-session-superseded-transport"
              ? SWARM_OWNER_SESSION_SUPERSEDED_ERROR
              : SWARM_OWNER_SESSION_BUSY_ERROR,
          reason: event.reason,
          idempotencyKey: `swarm-recovery-${createHash("sha256")
            .update(
              JSON.stringify([
                runId,
                input.expectedTaskFailureIndex,
                input.expectedRunFailureIndex,
              ]),
            )
            .digest("hex")}`,
        },
        invocation,
      );
      const recovered = recordOf(response.result?.output);
      if (
        recovered?.delegationId !== delegationId ||
        recovered.sessionId !== root.ownerSessionId ||
        recovered.finalized === true ||
        (recovered.state !== "running" && recovered.state !== "done") ||
        recovered.error !== undefined
      ) {
        throw new Error(
          "Native root delegation recovery did not confirm the same live owner session; Swarm remains failed.",
        );
      }
      await this.append(runId, [event]);
      return this.requireRun(runId);
    });
  }
  async setRoleModels(
    input: SwarmRunSetRoleModelsInput,
    invocation: InvocationContext,
  ): Promise<SwarmRun> {
    const runId = requiredString(input.runId, "runId");
    await this.getRootAuthorized({ runId }, invocation);
    validateSwarmRoleModels(input.roleModels);
    const reason = requiredString(input.reason, "reason");
    this.viewInvocations.set(runId, invocation);
    return this.withStateTransition(async () => {
      const current = await this.requireRun(runId);
      const root = current.tasks.find((task) => task.parentTaskId === undefined)!;
      if (
        !root.ownerSessionId ||
        !root.ownerPrincipalId ||
        root.ownerSessionId !== optionalCallerSessionId(invocation) ||
        root.ownerPrincipalId !== invocation.principal.id
      )
        throw new Error("Only the original root owner may update role models.");
      const event: SwarmRunUpdateEvent = {
        type: "run.roleModelsUpdated",
        roleModels: input.roleModels,
        reason,
        ownerSessionId: root.ownerSessionId,
        ownerPrincipalId: root.ownerPrincipalId,
      };
      replaySwarmRun([...(await this.options.eventStore.read(runId)), event]);
      await this.append(runId, [event]);
      // Policy changes never dispatch or mutate an already-created session.
      return this.requireRun(runId);
    });
  }
}
