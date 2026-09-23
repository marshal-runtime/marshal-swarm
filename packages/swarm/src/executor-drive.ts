import type { InvocationContext } from "@marshal/runtime";
import type { SwarmRun } from "./contracts.js";
import type { SwarmRunInput } from "./types.js";
import {
  TERMINAL_RUN_STATES,
  type ExecutableTask,
  type AgentLaunch,
  type AgentOutcome,
  type SettledTask,
  executableSwarmTasks,
  childAttentionSignature,
  isTerminalTask,
  executionReceipt,
} from "./executor-tasks.js";
import {
  DESCENDANT_INTEGRATION_REJECTION,
  requiredString,
  stringValue,
  optionalChangeRefs,
  plainError,
  errorText,
  completionRejectedForLiveDescendant,
  pauseReasonForError,
  diskFullPauseReason,
} from "./executor-values.js";
import { SwarmExecutorDispatch } from "./executor-dispatch.js";
/** The drive loop: selecting executable tasks, settling agents and recording outcomes. */
export class SwarmExecutorDrive extends SwarmExecutorDispatch {
  drive(input: SwarmRunInput, invocation: InvocationContext): Promise<SwarmRun> {
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
  protected wakeDrive(runId: string, invocation: InvocationContext): void {
    const active = this.driveInFlight.get(runId);
    if (!active) {
      void this.drive({ runId }, invocation).catch(() => undefined);
      return;
    }
    void active
      .finally(() => {
        if (!this.driveInFlight.has(runId))
          void this.drive({ runId }, invocation).catch(() => undefined);
      })
      .catch(() => undefined);
  }
  protected async driveLoop(runId: string, invocation: InvocationContext): Promise<SwarmRun> {
    const inFlight = new Map<string, Promise<SettledTask>>();
    const surfaced = new Map<string, string>();
    while (true) {
      const run = await this.requireRun(runId);
      if (run.legacyReadOnly)
        throw new Error("Legacy runs are read-only. Start a new explicit-protocol run.");
      if (TERMINAL_RUN_STATES.has(run.state)) return run;
      if (run.state === "paused") return run;
      const failedDependencies = run.tasks
        .filter((task) => task.state === "pending")
        .flatMap((task) => {
          const failed = (task.dependencyTaskIds ?? []).filter(
            (id) => run.tasks.find((dependency) => dependency.taskId === id)?.state === "failed",
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
        if (
          !ready.task.resumeReason &&
          ready.childResults.length > 0 &&
          ready.task.childAttentionSignature === childAttentionSignature(ready)
        )
          continue;
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
        if (
          executableSwarmTasks(latest).some((ready) =>
            this.heldWakeups.has(JSON.stringify([runId, ready.task.taskId])),
          )
        )
          continue;
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
  protected waitForHeldContinuation(
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
    const waiting = Promise.resolve()
      .then(async () => {
        let snapshot: Readonly<Record<string, unknown>> | undefined;
        do {
          [snapshot] = await Promise.all([
            this.waitForAgent(delegationId, invocation),
            new Promise<void>((resolve) => setTimeout(resolve, 250)),
          ]);
          if (await this.stopped(runId)) return;
        } while (snapshot?.state === "running" || snapshot?.state === "pending");
        if (!["done", "completed", "idle"].includes(stringValue(snapshot?.state) ?? ""))
          throw new Error(
            errorText(snapshot?.error, "Held continuation native wait did not reach idle."),
          );
        const current = await this.requireRun(runId);
        const task = current.tasks.find((entry) => entry.taskId === ready.task.taskId);
        if (
          current.state !== "running" ||
          task?.state !== "running" ||
          task.delegationId !== delegationId ||
          task.resumeCount !== ready.task.resumeCount
        )
          return;
        this.heldContinuations.delete(key);
        this.heldWakeups.add(key);
        await this.drive({ runId }, invocation);
        // If idle arrived during the preceding drive's final await, consume the
        // still-pending wake in a fresh drive. A consumed wake never dispatches twice.
        if (this.heldWakeups.has(key) && !(await this.stopped(runId)))
          await this.drive({ runId }, invocation);
      })
      .catch(async (error: unknown) => {
        // A stale pause/cancellation observer cannot fail a newer task attempt.
        const current = await this.requireRun(runId);
        const task = current.tasks.find((entry) => entry.taskId === ready.task.taskId);
        if (
          current.state !== "running" ||
          task?.state !== "running" ||
          task.delegationId !== delegationId ||
          task.resumeCount !== ready.task.resumeCount
        )
          return;
        await this.recordOutcome(runId, { ready, error: plainError(error) });
        await this.finishRun(runId);
      })
      .finally(() => {
        if (this.heldContinuations.get(key) === waiting) this.heldContinuations.delete(key);
      });
    this.heldContinuations.set(key, waiting);
    void waiting.catch((error: unknown) =>
      console.warn("Held continuation recovery failed.", error),
    );
  }
  protected async settleTask(
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
      await this.pauseAgent(launch.delegationId, pauseReason.message, invocation);
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
    const diskFullReason = diskFullPauseReason(delegation?.error, ready.task.taskId);
    if (diskFullReason !== undefined) {
      await this.pauseRun(runId, diskFullReason, invocation);
      return { ready, error: diskFullReason.message };
    }
    const currentTask = (await this.requireRun(runId)).tasks.find(
      (t) => t.taskId === ready.task.taskId,
    );
    const execution = currentTask?.executions.find((e) => e.delegationId === launch.delegationId);
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
  protected async recordOutcome(runId: string, outcome: AgentOutcome): Promise<boolean | void> {
    if (await this.stopped(runId)) return;
    const run = await this.requireRun(runId);
    const task = run.tasks.find((entry) => entry.taskId === outcome.ready.task.taskId);
    if (task === undefined || task.state === "completed" || task.state === "failed") {
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
    if (task.state !== "running" || task.resumeCount !== outcome.ready.task.resumeCount) return;
    const liveChildren = run.tasks.some(
      (child) => child.parentTaskId === task.taskId && !isTerminalTask(child),
    );
    if (!liveChildren && (task.idleReminders ?? 0) >= 2) {
      await this.appendWhileRunning(runId, [
        {
          type: "task.blocked",
          taskId: task.taskId,
          reason:
            "Agent remained idle without an explicit outcome or continuation request after two reminders; explicit resolution is required.",
        },
      ]);
      return;
    }
    if (!liveChildren && (task.idleReminders ?? 0) < 2 && task.delegationId) {
      const stillRunning =
        (await this.requireRun(runId)).tasks.find((t) => t.taskId === task.taskId)?.state ===
        "running";
      if (!stillRunning) return;
      const invocation = this.viewInvocations.get(runId);
      if (invocation) {
        const continued = await this.continueAgent(
          task.delegationId,
          "The owned Swarm task remains running. Continue the work, or use swarm.nodes.complete after acceptance; block/fail only when the task cannot proceed. Conversational final text does not complete the task.",
          invocation,
        );
        if (continued?.continuationDelivery === "held") return true;
        await this.appendWhileRunning(runId, [{ type: "task.reminded", taskId: task.taskId }]);
      }
    }
    // A conversational final answer is telemetry only. Lifecycle changes require
    // authenticated swarm.nodes operations, never JSON extracted from narration.
  }
}
