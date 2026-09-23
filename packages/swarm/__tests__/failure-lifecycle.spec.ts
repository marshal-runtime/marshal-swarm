import { describe, it, expect } from "vitest";
import type { InvocationContext } from "@marshal/runtime";
import {
  SwarmExecutor,
  InMemorySwarmRunEventStore,
  SwarmServiceContainer,
  replaySwarmRun,
  SWARM_OWNER_SESSION_BUSY_ERROR,
  type SwarmTaskRole,
} from "../src/index.js";
import { withFailureCascade } from "../src/failure-cascade.js";

/**
 * Regressions for the formal model (marshal formal/tla/SwarmRun.tla):
 * TerminalRunIsQuiescent, NoDispatchUnderDeadParent, and the reducer's
 * run.resumed guard (Lean resume_after_failure_rejected).
 */

const owner = { principal: { id: "owner" }, scope: { sessionId: "s" } } as InvocationContext;
const member = (id: string) =>
  ({ principal: { id: "owner" }, scope: { sessionId: id } }) as InvocationContext;

async function fixture() {
  const store = new InMemorySwarmRunEventStore();
  const calls: any[] = [];
  const factory = {
    execute: async (request: any) => {
      calls.push(request);
      return {
        result: {
          output: {
            delegationId: request.input.delegationId,
            sessionId: request.input.delegationId,
            state: "running",
          },
        },
      };
    },
  };
  const executor = new SwarmExecutor(factory as any, {
    eventStore: store,
    serviceContainer: new SwarmServiceContainer(),
  });
  await executor.create({ runId: "r", objective: "Build", scope: "a" }, owner);
  await store.append("r", { type: "task.started", taskId: "root", delegationId: "root-d" });
  const add = (taskId: string, parentTaskId: string, role: SwarmTaskRole = "worker") =>
    store.append("r", {
      type: "task.added",
      task: { taskId, parentTaskId, role, objective: taskId, scope: "a" },
    });
  const start = (taskId: string) =>
    store.append("r", {
      type: "task.dispatched",
      taskId,
      execution: { executionId: taskId, delegationId: taskId, sessionId: taskId },
    });
  const read = async () => replaySwarmRun(await store.read("r"));
  const stateOf = async (taskId: string) =>
    (await read()).tasks.find((task) => task.taskId === taskId)?.state;
  return { executor, store, calls, add, start, read, stateOf };
}

describe("reducer: run.resumed after a failed run", () => {
  it.each(["run.failed", "run.cancelled"] as const)("rejects run.resumed after %s", async (type) => {
    const { store } = await fixture();
    await store.append("r", { type, error: "x" });
    await expect(store.append("r", { type: "run.resumed" })).rejects.toThrow(/terminal/);
  });

  it("still rejects run.resumed after run.completed", async () => {
    const { store } = await fixture();
    await store.append("r", { type: "run.completed" });
    await expect(store.append("r", { type: "run.resumed" })).rejects.toThrow(/terminal/);
  });
});

describe("reducer: dispatch under a dead parent", () => {
  it("rejects dispatching a child whose planner failed", async () => {
    const { store, add, start } = await fixture();
    await add("root/p", "root", "planner");
    await start("root/p");
    await add("root/p/c", "root/p");
    await store.append("r", { type: "task.failed", taskId: "root/p", error: "plan invalid" });
    await expect(start("root/p/c")).rejects.toThrow(/no longer live/);
  });

  it("dispatches a child under a blocked parent", async () => {
    const { store, add, start, stateOf } = await fixture();
    await add("root/p", "root", "planner");
    await start("root/p");
    await add("root/p/c", "root/p");
    await store.append("r", { type: "task.blocked", taskId: "root/p", reason: "ask" });
    await start("root/p/c");
    expect(await stateOf("root/p/c")).toBe("running");
  });
});

describe("executor: a failure leaves no live work beneath it", () => {
  it("cancels the live subtree of a failed planner and its running delegations", async () => {
    const { executor, add, start, stateOf, calls } = await fixture();
    await add("root/p", "root", "planner");
    await start("root/p");
    await add("root/p/w", "root/p");
    await start("root/p/w");
    await add("root/p/q", "root/p");
    await add("root/a", "root");
    await executor.nodeOperation(
      "fail",
      { runId: "r", taskId: "root/p", reason: "plan invalid" },
      member("root/p"),
    );
    expect(await stateOf("root/p")).toBe("failed");
    expect(await stateOf("root/p/w")).toBe("failed");
    expect(await stateOf("root/p/q")).toBe("failed");
    expect(await stateOf("root/a")).not.toBe("failed");
    await expect
      .poll(() =>
        calls.some(
          (call) =>
            call.target === "runtime.delegation.cancel" && call.input.delegationId === "root/p/w",
        ),
      )
      .toBe(true);
  });

  it("a failed run is quiescent", async () => {
    const { executor, add, start, read, store } = await fixture();
    await store.append("r", {
      type: "task.execution",
      taskId: "root",
      execution: { executionId: "root-x", delegationId: "root-d", sessionId: "root" },
    });
    await add("root/a", "root");
    await start("root/a");
    await add("root/b", "root");
    await executor.nodeOperation(
      "fail",
      { runId: "r", taskId: "root", reason: "gave up" },
      member("root"),
    );
    const run = await read();
    expect(run.state).toBe("failed");
    expect(run.tasks.filter((task) => task.state !== "completed" && task.state !== "failed")).toEqual(
      [],
    );
  });

  it("keeps children of a recoverable owner-session root failure for recovery", async () => {
    const { read, add, start } = await fixture();
    await add("root/a", "root");
    await start("root/a");
    const { events } = withFailureCascade(await read(), [
      {
        type: "task.failed",
        taskId: "root",
        error: SWARM_OWNER_SESSION_BUSY_ERROR,
        failureOrigin: "runtime",
        failureCode: "SESSION_BUSY",
      },
    ]);
    expect(events).toHaveLength(1);
  });

  it("cancels live work once a root transport failure is no longer recoverable", async () => {
    const { executor, store, add, start, read } = await fixture();
    await add("root/a", "root");
    await start("root/a");
    await add("root/b", "root");
    await store.append("r", {
      type: "task.failed",
      taskId: "root",
      error: SWARM_OWNER_SESSION_BUSY_ERROR,
      failureOrigin: "runtime",
      failureCode: "SESSION_BUSY",
    });
    // Any event between the root failure and run.failed rules out recovery.
    await executor.nodeOperation(
      "block",
      { runId: "r", taskId: "root/a", reason: "needs input" },
      member("root/a"),
    );
    const run = await read();
    expect(run.state).toBe("failed");
    expect(run.tasks.filter((task) => task.state !== "completed" && task.state !== "failed")).toEqual(
      [],
    );
  });

  it("drops a stale failure for a task a cascade already cancelled", async () => {
    const { read, add, start, store } = await fixture();
    await add("root/p", "root", "planner");
    await start("root/p");
    await add("root/p/w", "root/p");
    await store.append("r", { type: "task.cancelled", taskId: "root/p/w", error: "x" });
    const { events } = withFailureCascade(await read(), [
      { type: "task.failed", taskId: "root/p/w", error: "late outcome", failureOrigin: "runtime" },
    ]);
    expect(events).toEqual([]);
  });
});
