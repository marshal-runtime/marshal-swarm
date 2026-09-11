import { expect, it } from "vitest";
import type { InvocationContext } from "@marshal/runtime";
import { InMemorySwarmRunEventStore, SwarmExecutor, SwarmServiceContainer, SwarmServiceSymbols, replaySwarmRun } from "../src/index.js";

const owner = { principal: { id: "owner" }, scope: { sessionId: "owner-session" } } as InvocationContext;
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

it.each(["resolution", "child outcomes", "active sibling", "blocked child", "pause", "wait failure"])("preserves held continuation across %s without blocking the caller", async (kind) => {
  const store = new InMemorySwarmRunEventStore();
  const services = new SwarmServiceContainer();
  services.bind(SwarmServiceSymbols.sharedContext, { read: async () => ({ path: "guide.md", content: "Decisions" }) });
  const waiting = gate();
  const idle = gate();
  const accepted = gate();
  const childDone = gate();
  let rootDelegationId: string | undefined;
  let phase: "setup" | "busy" | "idle" = "setup";
  const attempts: string[] = [];
  const delivered: string[] = [];
  const factory = { execute: async (request: any) => {
    const delegationId = request.input?.delegationId;
    if (request.target === "runtime.delegation.spawn" && rootDelegationId === undefined) rootDelegationId = delegationId;
    if (kind === "active sibling" && request.target === "runtime.delegation.wait" && delegationId !== rootDelegationId) {
      await childDone.promise;
      return { result: { output: { delegationId, state: "done" } } };
    }
    if (request.target === "runtime.delegation.continue" && phase !== "setup") {
      attempts.push(request.input.prompt);
      if (phase === "busy") return { result: { output: { delegationId, state: "running", continuationDelivery: "held" } } };
      delivered.push(request.input.prompt);
      accepted.resolve();
      if (kind === "active sibling") {
        await store.append("held", { type: "task.failed", taskId: "root/live", error: "fixture child finished after parent input", failureOrigin: "runtime" });
        childDone.resolve();
      }
      if (kind === "blocked child") await store.append("held", { type: "task.cancelled", taskId: "root/child", error: "parent handled blocker" });
      // The fixture agent explicitly completes only after receiving the actual prompt.
      await store.append("held", { type: "task.artifact", taskId: "root", artifact: { uri: "file:///plan.md", kind: "plan", summary: "accepted" } });
      await store.append("held", { type: "task.completed", taskId: "root" });
      return { result: { output: { delegationId, state: "running", continuationDelivery: "accepted" } } };
    }
    if (request.target === "runtime.delegation.wait" && phase === "busy") {
      waiting.resolve();
      await idle.promise;
      if (kind === "wait failure") throw new Error("native wait unavailable");
      phase = "idle";
    }
    return { result: { output: { delegationId, state: request.target === "runtime.delegation.wait" ? "done" : "running" } } };
  } };
  const executor = new SwarmExecutor(factory as any, { eventStore: store, serviceContainer: services });
  await executor.create({ runId: "held", objective: "preserve complete task", scope: "repo" }, owner);
  await executor.drive({ runId: "held" }, owner);
  await store.append("held", { type: "task.resumed", taskId: "root", reason: "Use the corrected acceptance contract" });
  if (kind === "child outcomes" || kind === "active sibling" || kind === "blocked child") {
    await store.append("held", { type: "task.added", task: { parentTaskId: "root", taskId: "root/child", role: "worker", objective: "child work", scope: "repo", idempotencyKey: "child" } });
    if (kind === "blocked child") {
      await store.append("held", { type: "task.started", taskId: "root/child", delegationId: "child-d" });
      await store.append("held", { type: "task.blocked", taskId: "root/child", reason: "specific child blocker" });
    } else await store.append("held", { type: "task.failed", taskId: "root/child", error: "specific child blocker", failureOrigin: "runtime" });
    await store.append("held", { type: "task.continued", taskId: "root" });
    if (kind === "active sibling") await store.append("held", { type: "task.added", task: { parentTaskId: "root", taskId: "root/live", role: "worker", objective: "needs parent input", scope: "repo", idempotencyKey: "live" } });
  }
  const initialContinued = (await store.read("held")).filter((event) => event.type === "task.continued").length;
  phase = "busy";
  const driving = executor.drive({ runId: "held" }, owner);
  await waiting.promise;
  // The foreground tool must finish while the unrelated native turn is busy.
  if (kind !== "active sibling") await expect(driving).resolves.toMatchObject({ state: "running" });
  try {
    expect(attempts).toHaveLength(1);
    expect(delivered).toEqual([]);
    expect((await store.read("held")).filter((event) => event.type === "task.continued")).toHaveLength(initialContinued);
    if (kind === "resolution") expect(replaySwarmRun(await store.read("held")).tasks[0].resumeReason).toBe("Use the corrected acceptance contract");
  } finally {
    if (kind === "pause") await store.append("held", { type: "run.paused", reason: { kind: "manual", message: "operator pause" } });
    idle.resolve();
    if (kind === "pause" || kind === "wait failure") await new Promise((resolve) => setTimeout(resolve, 300));
    else await accepted.promise;
    await executor.drive({ runId: "held" }, owner);
  }
  if (kind === "pause" || kind === "wait failure") {
    if (kind === "wait failure") expect(await store.read("held")).toContainEqual({ type: "task.failed", taskId: "root", error: "native wait unavailable", failureOrigin: "runtime" });
    expect(delivered).toEqual([]);
    expect(replaySwarmRun(await store.read("held")).tasks[0].resumeReason).toBe("Use the corrected acceptance contract");
    return;
  }
  expect(delivered).toHaveLength(1);
  // Delivery refreshes live sibling state while retaining the undelivered outcome.
  expect(delivered[0].replaceAll('"state":"running"', '"state":"pending"')).toBe(attempts[0].replaceAll('"state":"running"', '"state":"pending"'));
  expect(delivered[0]).toContain(kind === "resolution" ? "Use the corrected acceptance contract" : "specific child blocker");
  expect(replaySwarmRun(await store.read("held")).state).toBe("completed");
});
