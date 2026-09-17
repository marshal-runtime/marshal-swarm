import { describe, it, expect } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { InvocationContext } from "@marshal/runtime";
import {
  activate,
  SwarmExecutor,
  InMemorySwarmRunEventStore,
  FileSwarmRunEventStore,
  SwarmServiceContainer,
  SwarmServiceSymbols,
  replaySwarmRun,
  type SwarmTaskRole,
} from "../src/index.js";
const owner = {
  principal: { id: "owner" },
  scope: { sessionId: "s" },
} as InvocationContext;
const member = (id: string) =>
  ({
    principal: { id: "owner" },
    scope: { sessionId: id },
  }) as InvocationContext;
async function fixture(reply?: (request: any) => any) {
  const store = new InMemorySwarmRunEventStore();
  const services = new SwarmServiceContainer();
  services.bind(SwarmServiceSymbols.sharedContext, {
    read: async () => ({ path: "guide.md", content: "Decisions" }),
  });
  const calls: any[] = [];
  const factory = {
    execute: async (r: any) => {
      calls.push(r);
      const answer = reply?.(r);
      if (answer) return answer;
      return {
        result: {
          output: {
            delegationId: r.input.delegationId,
            sessionId: r.input.delegationId,
            state: "done",
            finalized: true,
            changeRefs: ["real-commit"],
          },
        },
      };
    },
  };
  const executor = new SwarmExecutor(factory as any, {
    eventStore: store,
    serviceContainer: services,
  });
  await executor.create(
    {
      runId: "r",
      objective: "Build",
      scope: "a",
      targets: [
        { scope: "a", ref: "main", head: "a1" },
        { scope: "b", ref: "main", head: "b1" },
      ],
    },
    owner,
  );
  await store.append("r", {
    type: "task.started",
    taskId: "root",
    delegationId: "root-d",
  });
  return { executor, store, calls };
}
async function child(
  store: InMemorySwarmRunEventStore,
  id: string,
  role: SwarmTaskRole = "worker",
  deps: string[] = [],
) {
  await store.append("r", {
    type: "task.added",
    task: {
      taskId: `root/${id}`,
      parentTaskId: "root",
      role,
      objective: id,
      scope: "a",
      dependencyTaskIds: deps,
    },
  });
}
async function start(store: InMemorySwarmRunEventStore, id: string) {
  await store.append("r", {
    type: "task.dispatched",
    taskId: id,
    execution: {
      executionId: id,
      delegationId: id,
      sessionId: id,
      dispatchState: "dispatched",
    },
  });
}
const launch = {
  runId: "r",
  parentTaskId: "root",
  taskId: "new",
  role: "worker",
  scope: "a",
  objective: "Work",
  idempotencyKey: "key",
};
describe("security and recovery regressions", () => {
  it.each(["worker", "reviewer", "reconciler"] as const)(
    "rejects launching by %s role",
    async (role) => {
      const { executor, store } = await fixture();
      await child(store, "c", role);
      await start(store, "root/c");
      await expect(
        executor.nodeOperation("launch", { ...launch, parentTaskId: "root/c" }, member("root/c")),
      ).rejects.toThrow("Role");
    },
  );
  it("rejects sibling mutation and principal spoof despite matching session", async () => {
    const { executor, store } = await fixture();
    await child(store, "a");
    await child(store, "b");
    await start(store, "root/a");
    await start(store, "root/b");
    await expect(
      executor.nodeOperation(
        "block",
        { runId: "r", taskId: "root/b", reason: "spoof" },
        member("root/a"),
      ),
    ).rejects.toThrow("owning");
    await expect(
      executor.nodeOperation("get", { runId: "r", taskId: "root" }, {
        ...owner,
        principal: { id: "evil" },
      } as InvocationContext),
    ).rejects.toThrow("own");
  });
  it("allows declared multi-repository children and rejects undeclared scopes", async () => {
    const { executor } = await fixture();
    await expect(
      executor.nodeOperation("launch", { ...launch, scope: "unknown" }, owner),
    ).rejects.toThrow("declared");
    const node: any = await executor.nodeOperation("launch", { ...launch, scope: "b" }, owner);
    expect(node.scope).toBe("b");
  });
  it("does not release blocked dependencies", async () => {
    const { executor, store, calls } = await fixture();
    await child(store, "dep");
    await start(store, "root/dep");
    await store.append("r", {
      type: "task.blocked",
      taskId: "root/dep",
      reason: "external",
    });
    await child(store, "waiting", "worker", ["root/dep"]);
    await executor.drive({ runId: "r" }, owner);
    expect(
      (await executor.get({ runId: "r" })).tasks.find((t) => t.taskId === "root/waiting")?.state,
    ).toBe("pending");
    expect(calls.some((c) => c.target === "runtime.delegation.spawn")).toBe(false);
  });
  it("releases pending dependency after explicit completion", async () => {
    const { executor, store, calls } = await fixture();
    await child(store, "dep");
    await start(store, "root/dep");
    await child(store, "waiting", "worker", ["root/dep"]);
    await store.append("r", { type: "task.completed", taskId: "root/dep" });
    await executor.drive({ runId: "r" }, owner);
    expect(
      calls.some(
        (c) =>
          c.target === "runtime.delegation.spawn" &&
          c.input.idempotencyKey.includes(":root/waiting:"),
      ),
    ).toBe(true);
  });
  it("keeps nested tree identities out of delegation filenames", async () => {
    const { executor, store, calls } = await fixture();
    await child(store, "nested/worker");
    await child(store, "nested%2Fworker");
    await executor.drive({ runId: "r" }, owner);
    const inputs = calls
      .filter((call) => call.target === "runtime.delegation.spawn")
      .map((call) => call.input);
    expect(inputs).toHaveLength(2);
    expect(new Set(inputs.map((input) => input.delegationId)).size).toBe(2);
    for (const input of inputs) {
      expect(input.delegationId).toMatch(/^swarm-[a-f0-9]{64}$/);
      expect(input.parentDelegationId).toBe("root-d");
      expect(input.idempotencyKey).toContain(":root/nested");
    }
  });
  it("rejects parent completion while blocked child remains", async () => {
    const { executor, store } = await fixture();
    await child(store, "c");
    await start(store, "root/c");
    await store.append("r", {
      type: "task.blocked",
      taskId: "root/c",
      reason: "external",
    });
    await expect(
      executor.nodeOperation("complete", { runId: "r", taskId: "root" }, owner),
    ).rejects.toThrow("Children");
  });
  it.each(["planner", "reconciler", "reviewer"] as const)(
    "%s completion requires artifact",
    async (role) => {
      const { executor, store } = await fixture();
      await child(store, "c", role);
      await start(store, "root/c");
      await expect(
        executor.nodeOperation("complete", { runId: "r", taskId: "root/c" }, member("root/c")),
      ).rejects.toThrow("artifact");
    },
  );
  it("integration rejection leaves task running", async () => {
    const { executor, store } = await fixture((r) =>
      r.target === "runtime.delegation.complete"
        ? { error: { message: "Integration rejected" } }
        : undefined,
    );
    await child(store, "c");
    await start(store, "root/c");
    await expect(
      executor.nodeOperation("complete", { runId: "r", taskId: "root/c" }, member("root/c")),
    ).rejects.toThrow("Integration rejected");
    expect(
      (await executor.get({ runId: "r" })).tasks.find((t) => t.taskId === "root/c")?.state,
    ).toBe("running");
  });
  it("explains a reconciler report-kind mismatch and completes after republishing the same file as reconciliation", async () => {
    const { executor, store, calls } = await fixture();
    await child(store, "oracle-subsystem", "planner");
    await start(store, "root/oracle-subsystem");
    const taskId = "root/oracle-subsystem/oracle-recon";
    await store.append("r", {
      type: "task.added",
      task: {
        taskId,
        parentTaskId: "root/oracle-subsystem",
        role: "reconciler",
        scope: "a",
        objective: "Reconcile six completed branches without redoing work",
      },
    });
    await start(store, taskId);
    const artifact = {
      uri: "/workspace/artifacts/oracle-recon-checkpoint.md",
      kind: "report",
      summary: "All six branches integrated; tests green; existing commit preserved.",
    };
    const caller = member(taskId);
    await executor.nodeOperation("publishArtifact", { runId: "r", taskId, artifact }, caller);
    const before = await store.read("r");
    expect(
      replaySwarmRun(before).tasks.find((task) => task.taskId === taskId)?.artifactRefs,
    ).toEqual([artifact]);
    await expect(
      executor.nodeOperation(
        "complete",
        { runId: "r", taskId, commits: ["integrated-commit"] },
        caller,
      ),
    ).rejects.toThrow(
      'reconciler requires an artifact of kind "reconciliation"; recorded kinds: report',
    );
    expect(await store.read("r")).toEqual(before);
    expect(calls.filter((call) => call.target === "runtime.delegation.complete")).toHaveLength(0);
    await executor.nodeOperation(
      "publishArtifact",
      { runId: "r", taskId, artifact: { ...artifact, kind: "reconciliation" } },
      caller,
    );
    const completed: any = await executor.nodeOperation(
      "complete",
      { runId: "r", taskId, commits: ["integrated-commit"] },
      caller,
    );
    expect(completed.state).toBe("completed");
    expect(completed.artifactRefs).toEqual([{ ...artifact, kind: "reconciliation" }]);
    expect(completed.delegationId).toBe(taskId);
    expect(calls.filter((call) => call.target === "runtime.delegation.complete")).toHaveLength(1);
    expect((await store.read("r")).slice(0, before.length)).toEqual(before);
  });
  it("rejects non-finalized completion response", async () => {
    const { executor, store } = await fixture((r) =>
      r.target === "runtime.delegation.complete"
        ? { result: { output: { state: "running" } } }
        : undefined,
    );
    await child(store, "c");
    await start(store, "root/c");
    await expect(
      executor.nodeOperation("complete", { runId: "r", taskId: "root/c" }, member("root/c")),
    ).rejects.toThrow("finalize");
  });
  it.each([
    {
      label: "explicit commit",
      commits: ["d6a7054fd3413f9d129e6621e81024b49ac7e5be"],
      expected: ["d6a7054fd3413f9d129e6621e81024b49ac7e5be"],
    },
    { label: "explicit empty list", commits: [], expected: [] },
    {
      label: "omitted commits",
      commits: undefined,
      expected: ["refs/heads/marshal/subagent/native-checkout"],
    },
  ])("preserves $label separately from native checkout refs", async ({ commits, expected }) => {
    const nativeRefs = ["refs/heads/marshal/subagent/native-checkout"];
    const { executor, store, calls } = await fixture((request) =>
      request.target === "runtime.delegation.complete"
        ? { result: { output: { state: "done", finalized: true, changeRefs: nativeRefs } } }
        : undefined,
    );
    await child(store, "outputs");
    await start(store, "root/outputs");
    const completed: any = await executor.nodeOperation(
      "complete",
      {
        runId: "r",
        taskId: "root/outputs",
        ...(commits === undefined ? {} : { commits }),
      },
      member("root/outputs"),
    );
    expect(completed.changeRefs).toEqual(expected);
    expect(
      (await store.read("r")).find(
        (event) => event.type === "task.completed" && event.taskId === "root/outputs",
      ),
    ).toMatchObject({ changeRefs: expected });
    expect(calls.find((call) => call.target === "runtime.delegation.complete")?.input).toEqual({
      delegationId: "root/outputs",
    });
    expect(nativeRefs).toEqual(["refs/heads/marshal/subagent/native-checkout"]);
  });
  it("does not accept declared commits when native ownership/finalization rejects completion", async () => {
    const { executor, store } = await fixture((request) =>
      request.target === "runtime.delegation.complete"
        ? {
            result: {
              output: { state: "failed", error: "Native ownership validation rejected completion" },
            },
          }
        : undefined,
    );
    await child(store, "outputs");
    await start(store, "root/outputs");
    const before = await store.read("r");
    await expect(
      executor.nodeOperation(
        "complete",
        {
          runId: "r",
          taskId: "root/outputs",
          commits: ["d6a7054fd3413f9d129e6621e81024b49ac7e5be"],
        },
        member("root/outputs"),
      ),
    ).rejects.toThrow("Native ownership validation rejected completion");
    expect(await store.read("r")).toEqual(before);
    expect(replaySwarmRun(before).tasks.find((task) => task.taskId === "root/outputs")?.state).toBe(
      "running",
    );
  });
  it("cancellation records reason on every unfinished node", async () => {
    const { executor, store } = await fixture();
    await child(store, "c");
    await executor.cancel({ runId: "r", reason: "User cancelled" }, owner);
    expect(
      replaySwarmRun(await store.read("r")).tasks.every(
        (t) => t.state === "failed" && t.reason === "User cancelled",
      ),
    ).toBe(true);
  });
  it("pauses environmental provisioning failure", async () => {
    const { executor, store } = await fixture((r) =>
      r.target === "runtime.delegation.spawn"
        ? { error: { code: "ENOSPC", message: "disk full" } }
        : undefined,
    );
    await child(store, "c");
    await executor.drive({ runId: "r" }, owner);
    expect((await executor.get({ runId: "r" })).pauseReason?.kind).toBe("environmental");
  });
  it("restart uses exact persisted launch inputs", async () => {
    const { executor, store, calls } = await fixture();
    await child(store, "c");
    await executor.setRoleModels(
      {
        runId: "r",
        roleModels: { worker: { model: "original-model" } },
        reason: "Approved original dispatch policy",
      },
      owner,
    );
    const launchInput = {
      prompt: "original input",
      role: "worker",
      scope: "a",
      delegationId: "reserved",
      idempotencyKey: "reserved",
      model: "original-model",
    };
    await store.append("r", {
      type: "task.dispatched",
      taskId: "root/c",
      execution: {
        executionId: "reserved",
        delegationId: "reserved",
        dispatchState: "registered",
        launchInput,
      },
    });
    await executor.drive({ runId: "r" }, owner);
    expect(calls.find((c) => c.target === "runtime.delegation.spawn")?.input).toEqual(launchInput);
  });
  it("allows a running task to request any number of additional turns", async () => {
    const { executor, store } = await fixture();
    for (let turn = 1; turn <= 100; turn += 1) {
      await store.append("r", {
        type: "task.continuationRequested",
        taskId: "root",
        reason: `Continue with turn ${String(turn)}`,
      });
    }
    const root = (await executor.get({ runId: "r" })).tasks[0];
    expect(root.resumeCount).toBe(100);
    expect(root.idleReminders).toBe(0);
    expect(root.state).toBe("running");
    expect(root.resumeReason).toBe("Continue with turn 100");
  });
  it("atomic append rejects invalid event without corrupting file", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "swarm-"));
    try {
      const store = new FileSwarmRunEventStore(dir);
      await store.create("r", "Build", "a");
      await store.append("r", {
        type: "task.added",
        task: {
          taskId: "root",
          role: "planner",
          objective: "Build",
          scope: "a",
        },
      });
      await expect(store.append("r", { type: "task.completed", taskId: "root" })).rejects.toThrow(
        "running",
      );
      expect(replaySwarmRun(await new FileSwarmRunEventStore(dir).read("r")).tasks[0].state).toBe(
        "pending",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("explicit blocked resume preserves session and checkout identity", async () => {
    const { executor, store, calls } = await fixture();
    await child(store, "c");
    await start(store, "root/c");
    await executor.nodeOperation(
      "block",
      { runId: "r", taskId: "root/c", reason: "External wait" },
      member("root/c"),
    );
    await executor.nodeOperation(
      "resume",
      { runId: "r", taskId: "root/c", reason: "Resolved" },
      member("root/c"),
    );
    await executor.drive({ runId: "r" }, owner);
    const task = (await executor.get({ runId: "r" })).tasks.find((t) => t.taskId === "root/c")!;
    expect(task.delegationId).toBe("root/c");
    expect(calls.filter((c) => c.target === "runtime.delegation.spawn")).toHaveLength(0);
    expect(
      calls.some(
        (c) => c.target === "runtime.delegation.continue" && c.input.prompt.includes("Resolved"),
      ),
    ).toBe(true);
  });
  it("recovers a journal lock left by a dead process", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "swarm-lock-"));
    try {
      const store = new FileSwarmRunEventStore(dir);
      await store.create("r", "Build", "a");
      await writeFile(
        path.join(dir, "run-r.jsonl.lock"),
        JSON.stringify({ pid: 2147483647, token: "crashed-owner" }),
      );
      await store.append("r", {
        type: "task.added",
        task: {
          taskId: "root",
          role: "planner",
          objective: "Build",
          scope: "a",
        },
      });
      expect(await store.read("r")).toHaveLength(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("preserves unknown token counts and provider reported cost", async () => {
    const { executor, store } = await fixture((r) =>
      r.target === "runtime.delegation.complete"
        ? {
            result: {
              output: {
                state: "done",
                finalized: true,
                executionId: "turn-a",
                model: "actual-model",
                usageByModel: [
                  {
                    model: "actual-model",
                    usage: {
                      inputTokens: 100,
                      cachedInputTokens: 30,
                      costUsd: 0.02,
                    },
                  },
                ],
                usage: {
                  inputTokens: 100,
                  cachedInputTokens: 30,
                  costUsd: 0.02,
                },
                changeRefs: ["actual"],
              },
            },
          }
        : undefined,
    );
    await child(store, "c");
    await start(store, "root/c");
    await executor.nodeOperation("complete", { runId: "r", taskId: "root/c" }, member("root/c"));
    const task = (await executor.get({ runId: "r" })).tasks.find((t) => t.taskId === "root/c")!;
    const receipt = task.executions.find((e) => e.executionId === "turn-a")!;
    expect(receipt.model).toBe("actual-model");
    expect(receipt.kind).toBe("turn");
    expect(receipt.usageByModel).toEqual([
      {
        model: "actual-model",
        usage: { inputTokens: 100, cachedInputTokens: 30, reportedCost: 0.02 },
      },
    ]);
    expect(receipt.usage).toEqual({
      inputTokens: 100,
      cachedInputTokens: 30,
      reportedCost: 0.02,
    });
    expect(task.changeRefs).toEqual(["actual"]);
  });
  it("resumes a planner even when its blocked child has no outcome", async () => {
    const { executor, store, calls } = await fixture();
    await child(store, "c");
    await start(store, "root/c");
    await store.append("r", {
      type: "task.blocked",
      taskId: "root/c",
      reason: "waiting",
    });
    await executor.nodeOperation(
      "block",
      { runId: "r", taskId: "root", reason: "decision" },
      owner,
    );
    await executor.nodeOperation(
      "resume",
      { runId: "r", taskId: "root", reason: "Decision resolved" },
      owner,
    );
    await executor.drive({ runId: "r" }, owner);
    expect(
      calls.some(
        (c) =>
          c.target === "runtime.delegation.continue" &&
          c.input.prompt.includes("Decision resolved"),
      ),
    ).toBe(true);
  });

  it("activation forwards the host transcript reader without granting an outsider write authority", async () => {
    const { store } = await fixture();
    await store.append("r", {
      type: "task.execution",
      taskId: "root",
      execution: {
        executionId: "native-turn",
        sessionId: "persisted-native",
        transcriptRef: "/encrypted/session.json",
      },
    });
    const outside = member("outside");
    const readerCalls: unknown[] = [];
    const reader = {
      read: async (input: unknown, invocation: unknown) => {
        readerCalls.push({ input, invocation });
        return { uri: "/encrypted/session.json", text: "decoded transcript", truncated: false };
      },
    };
    const activation = await activate({
      configuration: { runsDirectory: "/tmp/unused-swarmed-test" },
      services: {
        tryGet: (key: unknown) =>
          key === SwarmServiceSymbols.eventStore
            ? store
            : key === SwarmServiceSymbols.transcriptReader
              ? reader
              : undefined,
      },
      execute: async () => {
        throw new Error("Unexpected dispatch during read");
      },
    } as any);
    try {
      const provider = activation.capabilityProviders![0];
      expect(
        await provider.invoke(
          "swarm.runs.read-file",
          { runId: "r", taskId: "root", uri: "/encrypted/session.json", offset: 7 },
          outside,
        ),
      ).toEqual({
        output: { uri: "/encrypted/session.json", text: "decoded transcript", truncated: false },
      });
      expect(readerCalls).toEqual([
        {
          input: { sessionId: "persisted-native", uri: "/encrypted/session.json", offset: 7 },
          invocation: outside,
        },
      ]);
      await expect(provider.invoke("swarm.runs.drive", { runId: "r" }, outside)).rejects.toThrow(
        "owner",
      );
    } finally {
      await activation.dispose?.();
    }
  });

  it("managed extension rejects a foreign drive before starting or publishing", async () => {
    const { store } = await fixture();
    let executed = 0;
    const activation = await activate({
      configuration: { runsDirectory: "/tmp/unused-swarmed-test" },
      services: {
        tryGet: (key: unknown) => (key === SwarmServiceSymbols.eventStore ? store : undefined),
      },
      execute: async () => {
        executed++;
        throw new Error("unexpected dispatch");
      },
    } as any);
    const provider = activation.capabilityProviders![0];
    await expect(
      provider.invoke("swarm.runs.drive", { runId: "r" }, member("foreign")),
    ).rejects.toThrow("own");
    expect(executed).toBe(0);
    await activation.dispose?.();
  });

  it("run pause/resume continues a running leaf instead of waiting a paused delegation", async () => {
    const { executor, store, calls } = await fixture();
    await child(store, "c");
    await start(store, "root/c");
    await executor.pause({ runId: "r", reason: "User paused" }, owner);
    await executor.resume({ runId: "r" }, owner);
    expect(
      calls.some(
        (c) => c.target === "runtime.delegation.continue" && c.input.delegationId === "root/c",
      ),
    ).toBe(true);
    expect((await executor.get({ runId: "r" })).tasks.some((t) => t.state === "failed")).toBe(
      false,
    );
  });
  it("a stale wait error cannot fail a task after explicit block/resume", async () => {
    let release!: (value: unknown) => void;
    let entered!: () => void;
    let first = true;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const { executor } = await fixture((r) => {
      if (r.target === "runtime.delegation.wait" && first) {
        first = false;
        entered();
        return new Promise((resolve) => {
          release = resolve;
        });
      }
      return undefined;
    });
    const drive = executor.drive({ runId: "r" }, owner);
    await waiting;
    await executor.nodeOperation(
      "block",
      { runId: "r", taskId: "root", reason: "Pause work" },
      owner,
    );
    await executor.nodeOperation(
      "resume",
      { runId: "r", taskId: "root", reason: "Resolved" },
      owner,
    );
    release({
      result: { output: { state: "failed", error: "Old interrupted turn" } },
    });
    await drive;
    const root = (await executor.get({ runId: "r" })).tasks[0];
    expect(root.state).not.toBe("failed");
    expect(root.error).toBeUndefined();
  });
  it("fails an unstarted task whose dependency failed so its parent can repair and finish", async () => {
    const { executor, store } = await fixture();
    await child(store, "dep");
    await start(store, "root/dep");
    await store.append("r", {
      type: "task.failed",
      taskId: "root/dep",
      error: "Implementation failed",
    });
    await child(store, "waiting", "worker", ["root/dep"]);
    await executor.drive({ runId: "r" }, owner);
    const waiting = (await executor.get({ runId: "r" })).tasks.find(
      (t) => t.taskId === "root/waiting",
    )!;
    expect(waiting.state).toBe("failed");
    expect(waiting.reason).toContain("root/dep");
    const root = (await executor.get({ runId: "r" })).tasks[0];
    if (root.state === "blocked")
      await store.append("r", {
        type: "task.resumed",
        taskId: "root",
        reason: "Parent triaged dependency failure",
      });
    await child(store, "repair");
    await start(store, "root/repair");
    await store.append("r", {
      type: "task.completed",
      taskId: "root/repair",
      changeRefs: ["repair-commit"],
    });
    await executor.nodeOperation(
      "publishArtifact",
      {
        runId: "r",
        taskId: "root",
        artifact: {
          uri: "/tmp/plan.md",
          kind: "plan",
          summary: "Repaired failed prerequisite and dependent outcome.",
        },
      },
      owner,
    );
    await executor.nodeOperation("complete", { runId: "r", taskId: "root" }, owner);
    expect((await executor.get({ runId: "r" })).state).toBe("completed");
  });
  it("surfaces a pre-dispatch preparation error on a pending task", async () => {
    const store = new InMemorySwarmRunEventStore();
    const services = new SwarmServiceContainer();
    services.bind(SwarmServiceSymbols.sharedContext, {
      read: async () => {
        throw new Error("Guide unavailable");
      },
    });
    const executor = new SwarmExecutor(
      { execute: async () => ({ result: { output: {} } }) } as any,
      { eventStore: store, serviceContainer: services },
    );
    await executor.create({ runId: "preparation", objective: "Work", scope: "repo" }, owner);
    await executor.drive({ runId: "preparation" }, owner);
    const run = await executor.get({ runId: "preparation" });
    expect(run.state).toBe("failed");
    expect(run.tasks[0].reason).toBe("Guide unavailable");
  });
  it("managed creation needs no guide service and background dispatch outlives request cancellation", async () => {
    const store = new InMemorySwarmRunEventStore();
    const requestController = new AbortController();
    let releaseWait: (() => void) | undefined;
    let spawnContext: any;
    const activation = await activate({
      configuration: { runsDirectory: "/tmp/unused-background-test" },
      services: {
        tryGet: (key: unknown) => (key === SwarmServiceSymbols.eventStore ? store : undefined),
      },
      execute: async (request: any, context: any) => {
        if (request.target === "runtime.delegation.spawn") {
          spawnContext = context;
          return {
            result: {
              output: {
                delegationId: request.input.delegationId,
                sessionId: "background-agent",
              },
            },
          };
        }
        if (request.target === "runtime.delegation.wait") {
          await new Promise<void>((resolve) => {
            releaseWait = resolve;
          });
          return { result: { output: { state: "done" } } };
        }
        if (request.target === "runtime.delegation.cancel") {
          releaseWait?.();
          return { result: { output: { state: "failed" } } };
        }
        return { result: { output: {} } };
      },
    } as any);
    const provider = activation.capabilityProviders![0];
    await provider.invoke(
      "swarm.runs.create",
      { runId: "background", objective: "Work", scope: "repo" },
      {
        ...owner,
        signal: requestController.signal,
        metadata: { trusted: "preserved" },
      } as InvocationContext,
    );
    requestController.abort();
    await expect
      .poll(async () => replaySwarmRun(await store.read("background")).tasks[0].state)
      .toBe("running");
    expect(spawnContext.signal).toBeUndefined();
    expect(spawnContext.metadata).toEqual({ trusted: "preserved" });
    await activation.dispose?.();
    expect(replaySwarmRun(await store.read("background")).state).toBe("failed");
  });
});
