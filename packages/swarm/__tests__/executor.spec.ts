import { describe, expect, it, vi } from "vitest";
import { RuntimeKernel, createAllowAllPermissionBroker } from "@marshal/runtime/core";
import type { InvocationContext } from "@marshal/runtime";
import {
  SwarmExecutor,
  InMemorySwarmRunEventStore,
  SwarmServiceContainer,
  SwarmServiceSymbols,
  createSwarmProvider,
  replaySwarmRun,
} from "../src/index.js";
const owner = {
  principal: { id: "test" },
  scope: { sessionId: "root-session" },
} as InvocationContext;
const foreign = {
  principal: { id: "test" },
  scope: { sessionId: "other-session" },
} as InvocationContext;
async function setup() {
  const store = new InMemorySwarmRunEventStore();
  const services = new SwarmServiceContainer();
  services.bind(SwarmServiceSymbols.sharedContext, {
    read: async () => ({ path: "field-guide/index.md", content: "Decisions" }),
  });
  const calls: any[] = [];
  const factory = {
    execute: async (request: any) => {
      calls.push(request);
      const id = request.input?.delegationId;
      if (request.target === "runtime.delegation.spawn") {
        const run = replaySwarmRun(await store.read("r"));
        expect(run.tasks.some((t) => t.state === "running" && t.delegationId === id)).toBe(true);
        return {
          result: {
            output: {
              delegationId: id,
              sessionId: `session-${id}`,
              transcriptRef: "/tmp/transcript.jsonl",
            },
          },
        };
      }
      if (request.target === "runtime.delegation.wait")
        return {
          result: {
            output: {
              delegationId: id,
              state: "done",
              result: '{"children":[{"taskId":"injected","role":"worker"}]}',
              usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 4 },
            },
          },
        };
      return {
        result: {
          output: {
            delegationId: id,
            finalized: true,
            state: "done",
            changeRefs: request.input?.changeRefs ?? [],
          },
        },
      };
    },
  };
  const executor = new SwarmExecutor(factory as any, {
    eventStore: store,
    serviceContainer: services,
  });
  await executor.create({ runId: "r", objective: "Build", scope: "repo" }, owner);
  await executor.drive({ runId: "r" }, owner);
  await store.append("r", {
    type: "task.resumed",
    taskId: "root",
    reason: "Fixture explicitly continues after idle exhaustion",
  });
  return { store, executor, calls, services };
}
const launch = {
  runId: "r",
  parentTaskId: "root",
  taskId: "child",
  role: "worker",
  objective: "Implement",
  scope: "repo",
  idempotencyKey: "one",
};
describe("explicit persistent node protocol", () => {
  it("preserves committed mutations and pauses agents when the view cannot render", async () => {
    const store = new InMemorySwarmRunEventStore();
    const calls: any[] = [];
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const invocation = {
      ...owner,
      metadata: { marshalWorkspaceName: "repo" },
    } as InvocationContext;
    const executor = new SwarmExecutor(
      {
        execute: async (request: any) => {
          calls.push(request);
          return {
            result: {
              output: request.target.startsWith("ui.")
                ? {
                    ok: false,
                    error: { message: "Runtime UI payload contains an oversized string." },
                  }
                : { state: "paused" },
            },
          };
        },
      } as any,
      { eventStore: store },
    );
    try {
      await executor.create({ runId: "r", objective: "Build", scope: "repo" }, invocation);
      await store.append("r", {
        type: "task.started",
        taskId: "root",
        delegationId: "root-delegation",
      });
      await expect(
        executor.pause({ runId: "r", reason: "UI maintenance" }, invocation),
      ).resolves.toMatchObject({ state: "paused" });
      expect(calls.filter((c) => c.target === "runtime.delegation.pause")).toHaveLength(1);
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining("durable task state"),
        expect.any(String),
      );
      // A prior partial pause can be retried without duplicating the state event.
      await executor.pause({ runId: "r", reason: "UI maintenance" }, invocation);
      expect(calls.filter((c) => c.target === "runtime.delegation.pause")).toHaveLength(2);
      expect((await store.read("r")).filter((e: any) => e.type === "run.paused")).toHaveLength(1);
    } finally {
      warning.mockRestore();
    }
  });
  it("does not wait for a UI refresh that never settles", async () => {
    const store = new InMemorySwarmRunEventStore();
    const invocation = {
      ...owner,
      metadata: { marshalWorkspaceName: "repo" },
    } as InvocationContext;
    const executor = new SwarmExecutor(
      {
        execute: async (request: any) => {
          if (request.target.startsWith("ui.")) return new Promise(() => undefined);
          return { result: { output: { state: "paused" } } };
        },
      } as any,
      { eventStore: store },
    );
    const withinDeadline = <T>(operation: Promise<T>) =>
      Promise.race([
        operation,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("mutation waited for UI refresh")), 100),
        ),
      ]);
    await withinDeadline(
      executor.create({ runId: "r", objective: "Build", scope: "repo" }, invocation),
    );
    await store.append("r", {
      type: "task.started",
      taskId: "root",
      delegationId: "root-delegation",
    });
    await expect(
      withinDeadline(executor.nodeOperation("launch", launch, invocation)),
    ).resolves.toMatchObject({ taskId: "root/child" });
    expect(replaySwarmRun(await store.read("r")).tasks.map((task) => task.taskId)).toContain(
      "root/child",
    );
  });
  it("does not hold lifecycle writes while native completion is pending", async () => {
    const store = new InMemorySwarmRunEventStore();
    let completionStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      completionStarted = resolve;
    });
    const executor = new SwarmExecutor(
      {
        execute: async (request: any) => {
          if (request.target === "runtime.delegation.complete") {
            completionStarted();
            return new Promise(() => undefined);
          }
          throw new Error(`Unexpected capability: ${request.target}`);
        },
      } as any,
      { eventStore: store },
    );
    await executor.create({ runId: "r", objective: "Build", scope: "repo" }, owner);
    await store.append("r", {
      type: "task.started",
      taskId: "root",
      delegationId: "root-delegation",
    });
    await store.append("r", {
      type: "task.artifact",
      taskId: "root",
      artifact: { kind: "plan", uri: "file:///tmp/plan.md", summary: "Plan" },
    });
    void executor.nodeOperation("complete", { runId: "r", taskId: "root" }, owner);
    await started;
    await expect(
      Promise.race([
        executor.nodeOperation(
          "publishArtifact",
          {
            runId: "r",
            taskId: "root",
            artifact: { kind: "report", uri: "file:///tmp/report.md", summary: "Report" },
          },
          owner,
        ),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("completion retained the lifecycle lock")), 100),
        ),
      ]),
    ).resolves.toMatchObject({ taskId: "root" });
  });
  it("does not hold lifecycle writes while native dispatch is pending", async () => {
    const store = new InMemorySwarmRunEventStore();
    let dispatchStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      dispatchStarted = resolve;
    });
    const executor = new SwarmExecutor(
      {
        execute: async (request: any) => {
          if (request.target === "runtime.delegation.spawn") {
            dispatchStarted();
            return new Promise(() => undefined);
          }
          throw new Error(`Unexpected capability: ${request.target}`);
        },
      } as any,
      { eventStore: store },
    );
    await executor.create({ runId: "r", objective: "Build", scope: "repo" }, owner);
    await store.append("r", {
      type: "task.started",
      taskId: "root",
      delegationId: "root-delegation",
    });
    await store.append("r", {
      type: "task.added",
      task: {
        taskId: "root/child",
        parentTaskId: "root",
        role: "worker",
        objective: "Implement",
        scope: "repo",
      },
    });
    void executor.drive({ runId: "r" }, owner);
    await started;
    await expect(
      Promise.race([
        executor.nodeOperation(
          "publishArtifact",
          {
            runId: "r",
            taskId: "root",
            artifact: { kind: "plan", uri: "file:///tmp/plan.md", summary: "Plan" },
          },
          owner,
        ),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("dispatch retained the lifecycle lock")), 100),
        ),
      ]),
    ).resolves.toMatchObject({ taskId: "root" });
  });
  it("starts a fresh drive when completion races with an exiting drive", async () => {
    const store = new InMemorySwarmRunEventStore();
    let releaseActive!: (run: any) => void;
    const activeGate = new Promise<any>((resolve) => {
      releaseActive = resolve;
    });
    let dependentDispatched!: () => void;
    const dispatched = new Promise<void>((resolve) => {
      dependentDispatched = resolve;
    });
    const executor = new SwarmExecutor(
      {
        execute: async (request: any) => {
          if (request.target === "runtime.delegation.complete")
            return { result: { output: { finalized: true, state: "done" } } };
          if (request.target === "runtime.delegation.spawn") {
            dependentDispatched();
            return {
              result: {
                output: {
                  delegationId: request.input.delegationId,
                  sessionId: "dependent-session",
                },
              },
            };
          }
          if (request.target === "runtime.delegation.continue")
            return { result: { output: { continuationDelivery: "held" } } };
          if (request.target === "runtime.delegation.wait") return new Promise(() => undefined);
          return { result: { output: { state: "cancelled" } } };
        },
      } as any,
      { eventStore: store },
    );
    await executor.create({ runId: "r", objective: "Build", scope: "repo" }, owner);
    await store.append("r", {
      type: "task.started",
      taskId: "root",
      delegationId: "root-delegation",
    });
    await store.append("r", {
      type: "task.added",
      task: {
        taskId: "root/prerequisite",
        parentTaskId: "root",
        role: "worker",
        objective: "Prepare baseline",
        scope: "repo",
        ownerSessionId: "child-session",
        ownerPrincipalId: "test",
      },
    });
    await store.append("r", {
      type: "task.started",
      taskId: "root/prerequisite",
      delegationId: "child-delegation",
    });
    await store.append("r", {
      type: "task.added",
      task: {
        taskId: "root/dependent",
        parentTaskId: "root",
        role: "worker",
        objective: "Use baseline",
        scope: "repo",
        dependencyTaskIds: ["root/prerequisite"],
      },
    });
    const drives = (executor as any).driveInFlight as Map<string, Promise<any>>;
    let active!: Promise<any>;
    active = activeGate.finally(() => {
      if (drives.get("r") === active) drives.delete("r");
    });
    drives.set("r", active);
    const child = {
      principal: { id: "test" },
      scope: { sessionId: "child-session" },
      metadata: { delegationId: "child-delegation" },
    } as InvocationContext;
    await executor.nodeOperation("complete", { runId: "r", taskId: "root/prerequisite" }, child);
    releaseActive(await executor.get({ runId: "r" }));
    await expect(
      Promise.race([
        dispatched,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("completion wake-up was lost")), 200),
        ),
      ]),
    ).resolves.toBeUndefined();
    await executor.cancel({ runId: "r", reason: "Test complete" }, owner);
  });
  it("registers durable execution identity before dispatch and never parses final narration", async () => {
    const { executor, calls } = await setup();
    const dispatchedPrompt = calls.find((c) => c.target === "runtime.delegation.spawn").input
      .prompt;
    expect(dispatchedPrompt).toContain(
      'export default async (input, context) => context.runtime.invoke("swarm.nodes.<operation>", input)',
    );
    expect(dispatchedPrompt).toContain("capability output directly");
    expect(dispatchedPrompt).toContain(
      "Required artifact kinds: planner uses plan, decision, or report; reviewer uses review; reconciler uses reconciliation",
    );
    expect(dispatchedPrompt).toContain(
      "Before completing, publish an artifact reference through swarm.nodes.publishArtifact",
    );
    expect(dispatchedPrompt).toContain(
      "An inline artifact passed to swarm.nodes.complete does not publish a reference",
    );
    const run = await executor.get({ runId: "r" });
    expect(run.state).toBe("running");
    expect(run.tasks).toHaveLength(1);
    expect(run.tasks[0].state).toBe("running");
    expect(run.tasks[0].executions[0].usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cachedInputTokens: 4,
    });
    expect(calls.filter((c) => c.target === "runtime.delegation.continue")).toHaveLength(2);
  });
  it("allows same-identity outsider reads while requiring ownership for writes", async () => {
    const { executor } = await setup();
    expect(await executor.nodeOperation("list", { runId: "r" }, foreign)).toEqual(
      (await executor.get({ runId: "r" })).tasks,
    );
    await expect(executor.nodeOperation("launch", launch, foreign)).rejects.toThrow("own");
    expect(await executor.listAuthorized(foreign)).toHaveLength(1);
  });
  it("restores only participating runs in chat evidence while preserving outside-agent discovery", async () => {
    const { executor, store } = await setup();
    await store.append("r", {
      type: "task.added",
      task: {
        taskId: "root/worker",
        parentTaskId: "root",
        role: "worker",
        objective: "Implement",
        scope: "repo",
      },
    });
    await store.append("r", {
      type: "task.started",
      taskId: "root/worker",
      delegationId: "worker-delegation",
    });
    await store.append("r", {
      type: "task.execution",
      taskId: "root/worker",
      execution: {
        executionId: "worker-execution",
        sessionId: "worker-session",
      },
    });
    await executor.create({ runId: "other", objective: "Other chat work", scope: "repo" }, foreign);
    // A fresh executor must derive participation from durable history after restart.
    const restored = new SwarmExecutor({ execute: vi.fn() } as any, { eventStore: store });
    const provider = createSwarmProvider(restored);
    const evidence = (invocation: InvocationContext) =>
      provider.invoke("swarm.runs.evidence-list", {}, invocation);
    expect(await evidence(owner)).toMatchObject({ output: { entries: [{ id: "r" }] } });
    expect(await evidence(foreign)).toMatchObject({ output: { entries: [{ id: "other" }] } });
    const worker = { ...owner, scope: { sessionId: "worker-session" } } as InvocationContext;
    expect(await evidence(worker)).toMatchObject({ output: { entries: [{ id: "r" }] } });
    const outside = { ...owner, scope: { sessionId: "unrelated-chat" } } as InvocationContext;
    expect(await evidence(outside)).toEqual({ output: { entries: [] } });
    expect((await restored.listAuthorized(outside)).map((run) => run.runId)).toEqual([
      "other",
      "r",
    ]);
    expect(await restored.nodeOperation("list", { runId: "r" }, outside)).toHaveLength(2);
    expect(
      await evidence({ ...owner, principal: { id: "other-account" } } as InvocationContext),
    ).toEqual({ output: { entries: [] } });
  });
  it.each(["running", "paused", "blocked", "failed"])(
    "same-identity outsiders read complete %s history without gaining mutation authority",
    async (state) => {
      const { executor, store } = await setup();
      if (state === "paused")
        await store.append("r", {
          type: "run.paused",
          reason: { kind: "manual", message: "paused" },
        });
      if (state === "blocked")
        await store.append("r", { type: "task.blocked", taskId: "root", reason: "blocked" });
      if (state === "failed") {
        await store.append("r", {
          type: "task.failed",
          taskId: "root",
          error: "historical failure",
        });
        await store.append("r", { type: "run.failed", error: "historical failure" });
      }
      const run = await executor.get({ runId: "r" });
      const before = await store.read("r");
      expect(await executor.getAuthorized({ runId: "r" }, foreign)).toEqual(run);
      expect(await executor.listAuthorized(foreign)).toEqual([run]);
      expect(await executor.nodeOperation("get", { runId: "r", taskId: "root" }, foreign)).toEqual(
        run.tasks[0],
      );
      const stranger = { ...foreign, principal: { id: "different-identity" } } as InvocationContext;
      expect(await executor.listAuthorized(stranger)).toEqual([]);
      await expect(executor.getAuthorized({ runId: "r" }, stranger)).rejects.toThrow("identity");
      await expect(
        executor.nodeOperation("get", { runId: "r", taskId: "root" }, stranger),
      ).rejects.toThrow("identity");
      await expect(
        executor.getAuthorized({ runId: "r" }, { ...foreign, scope: {} } as InvocationContext),
      ).rejects.toThrow("identity");
      const provider = createSwarmProvider(executor);
      for (const [name, input] of [
        ["swarm.runs.drive", {}],
        ["swarm.runs.pause", { reason: "pause" }],
        ["swarm.runs.resume", {}],
        ["swarm.runs.cancel", { reason: "cancel" }],
        [
          "swarm.runs.setRoleModels",
          { roleModels: { worker: { model: "test" } }, reason: "change" },
        ],
        [
          "swarm.runs.recoverSystemFailure",
          {
            classification: "owner-session-busy-transport",
            expectedTaskFailureIndex: 1,
            expectedRunFailureIndex: 2,
            reason: "recover",
          },
        ],
      ] as const)
        await expect(provider.invoke(name, { runId: "r", ...input }, foreign)).rejects.toThrow(
          "owner",
        );
      for (const name of [
        "launch",
        "publishArtifact",
        "complete",
        "continue",
        "block",
        "fail",
        "resume",
      ])
        await expect(
          executor.nodeOperation(name, { runId: "r", taskId: "root" }, foreign),
        ).rejects.toThrow("own");
      expect(await store.read("r")).toEqual(before);
    },
  );

  it("routes outsider transcript reads through the bound reader with persisted execution identity", async () => {
    const { executor, store, services } = await setup();
    const run = await executor.get({ runId: "r" });
    const execution = run.tasks[0].executions[0];
    await store.append("r", {
      type: "task.execution",
      taskId: "root",
      execution: {
        ...execution,
        sessionId: "recorded-session",
        transcriptRef: "/encrypted/native-session.json",
      },
    });
    const read = vi
      .fn()
      .mockResolvedValue({
        uri: "/encrypted/native-session.json",
        text: "decoded transcript",
        truncated: true,
        nextOffset: 98,
      });
    services.bind(SwarmServiceSymbols.transcriptReader, { read });
    expect(
      await createSwarmProvider(executor).invoke(
        "swarm.runs.read-file",
        { runId: "r", taskId: "root", uri: "/encrypted/native-session.json", offset: 42 },
        foreign,
      ),
    ).toEqual({
      output: {
        uri: "/encrypted/native-session.json",
        text: "decoded transcript",
        truncated: true,
        nextOffset: 98,
      },
    });
    expect(read).toHaveBeenCalledExactlyOnceWith(
      { sessionId: "recorded-session", uri: "/encrypted/native-session.json", offset: 42 },
      foreign,
    );
  });

  it("launch retries are idempotent and mismatched retries fail", async () => {
    const { executor } = await setup();
    const a: any = await executor.nodeOperation("launch", launch, owner);
    const b: any = await executor.nodeOperation("launch", launch, owner);
    expect(a.taskId).toBe(b.taskId);
    await expect(
      executor.nodeOperation("launch", { ...launch, objective: "Different" }, owner),
    ).rejects.toThrow("Idempotency");
    expect(
      (await executor.get({ runId: "r" })).tasks.filter((t) => t.parentTaskId === "root"),
    ).toHaveLength(1);
  });
  it("blocked nodes require a reason and explicit resume, and cannot complete or get idle reminders", async () => {
    const { executor } = await setup();
    await expect(
      executor.nodeOperation("block", { runId: "r", taskId: "root", reason: "" }, owner),
    ).rejects.toThrow("reason");
    await executor.nodeOperation(
      "block",
      { runId: "r", taskId: "root", reason: "Needs dependency" },
      owner,
    );
    await executor.drive({ runId: "r" }, owner);
    const blocked = (await executor.get({ runId: "r" })).tasks[0];
    expect(blocked.state).toBe("blocked");
    expect(blocked.reason).toBe("Needs dependency");
    expect(blocked.idleReminders).toBe(0);
    await expect(
      executor.nodeOperation("complete", { runId: "r", taskId: "root" }, owner),
    ).rejects.toThrow("running");
    await executor.nodeOperation(
      "resume",
      { runId: "r", taskId: "root", reason: "Dependency resolved" },
      owner,
    );
  });
  it("requires planner artifact and protects completed tasks from late messages", async () => {
    const { executor } = await setup();
    await expect(
      executor.nodeOperation("complete", { runId: "r", taskId: "root" }, owner),
    ).rejects.toThrow("artifact");
    await executor.nodeOperation(
      "publishArtifact",
      {
        runId: "r",
        taskId: "root",
        artifact: {
          uri: "/tmp/plan.md",
          kind: "plan",
          summary: "Decision, action, rationale",
        },
      },
      owner,
    );
    await executor.nodeOperation(
      "complete",
      { runId: "r", taskId: "root", commits: ["abc123"] },
      owner,
    );
    expect((await executor.get({ runId: "r" })).state).toBe("completed");
    await expect(executor.nodeOperation("launch", launch, owner)).rejects.toThrow("not running");
    await expect(
      executor.nodeOperation("block", { runId: "r", taskId: "root", reason: "late" }, owner),
    ).rejects.toThrow("not running");
  });
  it("validates dependency references and prevents owner dependency deadlocks", async () => {
    const { executor } = await setup();
    await expect(
      executor.nodeOperation("launch", { ...launch, dependencyTaskIds: ["missing"] }, owner),
    ).rejects.toThrow("Unknown dependency");
    await expect(
      executor.nodeOperation("launch", { ...launch, dependencyTaskIds: ["root"] }, owner),
    ).rejects.toThrow("ancestor");
  });
  it("exposes explicit operations through capability provider", async () => {
    const { executor } = await setup();
    const provider = createSwarmProvider(executor);
    const names = (await provider.list()).map((d) => d.name);
    expect(names).toContain("swarm.nodes.complete");
    expect(names).toContain("swarm.nodes.continue");
    expect(names).toContain("swarm.nodes.launch");
    await expect(provider.invoke("swarm.runs.get", { runId: "r" }, foreign)).resolves.toMatchObject(
      { output: { run: { runId: "r" } } },
    );
  });
  it("registers all descriptors with the actual RuntimeKernel", async () => {
    const { executor } = await setup();
    const kernel = new RuntimeKernel({
      permissionBroker: createAllowAllPermissionBroker(),
    });
    kernel.register(createSwarmProvider(executor));
    await expect(kernel.list(owner)).resolves.toHaveLength(21);
  });
});
