import { expect, it } from "vitest";
import type { InvocationContext } from "@marshal/runtime";
import {
  InMemorySwarmRunEventStore,
  SwarmExecutor,
  SwarmServiceContainer,
  SwarmServiceSymbols,
  replaySwarmRun,
} from "../src/index.js";
const owner = { principal: { id: "owner" }, scope: { sessionId: "owner" } } as InvocationContext;

async function fixture(completedSibling = false, rejectDelivery = false) {
  const store = new InMemorySwarmRunEventStore();
  const services = new SwarmServiceContainer();
  services.bind(SwarmServiceSymbols.sharedContext, {
    read: async () => ({ path: "guide.md", content: "Guide" }),
  });
  const prompts: string[] = [];
  const factory = {
    execute: async (r: any) => {
      if (r.target === "runtime.delegation.continue" && r.input.delegationId === "root-d")
        prompts.push(r.input.prompt);
      if (rejectDelivery && r.target === "runtime.delegation.continue")
        return {
          result: {
            output: {
              delegationId: r.input.delegationId,
              state: "failed",
              error: "Delivery failed",
            },
          },
        };
      return {
        result: {
          output: {
            delegationId: r.input.delegationId,
            state: "done",
            continuationDelivery: "accepted",
          },
        },
      };
    },
  };
  const makeExecutor = () =>
    new SwarmExecutor(factory as any, { eventStore: store, serviceContainer: services });
  const executor = makeExecutor();
  await executor.create({ runId: "blocked", objective: "Build", scope: "repo" }, owner);
  await store.append("blocked", { type: "task.started", taskId: "root", delegationId: "root-d" });
  for (const id of completedSibling ? ["done", "worker"] : ["worker"]) {
    await store.append("blocked", {
      type: "task.added",
      task: {
        taskId: `root/${id}`,
        parentTaskId: "root",
        role: "worker",
        objective: id,
        scope: "repo",
      },
    });
    await store.append("blocked", {
      type: "task.dispatched",
      taskId: `root/${id}`,
      execution: { executionId: id, delegationId: id, sessionId: id, dispatchState: "dispatched" },
    });
    if (id === "done")
      await store.append("blocked", { type: "task.completed", taskId: "root/done" });
  }
  return { executor, store, prompts, makeExecutor };
}

it.each([false, true])(
  "wakes parent on a blocked child (completed sibling: %s), with reason, without releasing dependencies",
  async (sibling) => {
    const { executor, store, prompts, makeExecutor } = await fixture(sibling);
    await store.append("blocked", {
      type: "task.added",
      task: {
        taskId: "root/waiting",
        parentTaskId: "root",
        role: "worker",
        objective: "wait",
        scope: "repo",
        dependencyTaskIds: ["root/worker"],
      },
    });
    await store.append("blocked", {
      type: "task.blocked",
      taskId: "root/worker",
      reason: "Connection unavailable",
    });
    await executor.drive({ runId: "blocked" }, owner);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('"state":"blocked"');
    expect(prompts[0]).toContain("Connection unavailable");
    expect(
      replaySwarmRun(await store.read("blocked")).tasks.find((t) => t.taskId === "root/waiting")
        ?.state,
    ).toBe("pending");
    // An unchanged journal must not redeliver on a new driver or app restart.
    await makeExecutor().drive({ runId: "blocked" }, owner);
    expect(prompts).toHaveLength(1);
    // Even identical reasons after a resume represent a new block.
    await store.append("blocked", {
      type: "task.resumed",
      taskId: "root/worker",
      reason: "Connection restored",
    });
    await store.append("blocked", {
      type: "task.blocked",
      taskId: "root/worker",
      reason: "Connection unavailable",
    });
    await executor.drive({ runId: "blocked" }, owner);
    expect(prompts).toHaveLength(2);
    expect(replaySwarmRun(await store.read("blocked")).state).toBe("running");
  },
);

it("the block tool starts parent delivery even when no driver is alive", async () => {
  const { executor, prompts } = await fixture();
  await executor.nodeOperation(
    "block",
    { runId: "blocked", taskId: "root/worker", reason: "Need parent decision" },
    { ...owner, scope: { sessionId: "worker" } },
  );
  await expect.poll(() => prompts.length).toBe(1);
  expect(prompts[0]).toContain("Need parent decision");
});

it.each([false, true])(
  "surfaces watchdog blocks in the active driver (completed sibling: %s)",
  async (sibling) => {
    const { executor, store, prompts } = await fixture(sibling);
    await executor.drive({ runId: "blocked" }, owner);
    const blockerUpdates = prompts.filter((p) => p.includes('"state":"blocked"'));
    expect(blockerUpdates).toHaveLength(1);
    expect(blockerUpdates[0]).toContain(
      "without an explicit outcome or continuation request after two reminders",
    );
    expect(
      replaySwarmRun(await store.read("blocked")).tasks.find((t) => t.taskId === "root/worker")
        ?.state,
    ).toBe("blocked");
    expect(replaySwarmRun(await store.read("blocked")).tasks[0].state).toBe("running");
  },
);

it("never acknowledges a rejected delivery just because it includes the delegation ID", async () => {
  const { executor, store } = await fixture(false, true);
  await store.append("blocked", {
    type: "task.blocked",
    taskId: "root/worker",
    reason: "Need parent",
  });
  await executor.drive({ runId: "blocked" }, owner);
  expect((await store.read("blocked")).some((e) => e.type === "task.childrenNotified")).toBe(false);
});
