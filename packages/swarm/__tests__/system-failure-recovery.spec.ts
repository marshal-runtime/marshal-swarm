import { describe, it, expect } from "vitest";
import type { InvocationContext } from "@marshal/runtime";
import { DelegationManager, InMemoryDelegationStore, createRuntimeDelegationProvider } from "@marshal/runtime/delegation";
import { InMemorySwarmRunEventStore, SwarmExecutor, replaySwarmRun, SWARM_OWNER_SESSION_BUSY_ERROR, createSwarmProvider, swarmRunApplication, type SwarmRunRecoverSystemFailureInput } from "../src/index.js";
const owner = { principal: { id: "operator" }, scope: { sessionId: "owner-session" } } as InvocationContext;
async function fixture(error = SWARM_OWNER_SESSION_BUSY_ERROR, origin?: "runtime" | "agent", ending: "failed" | "cancelled" | "completed" = "failed") {
  const store = new InMemorySwarmRunEventStore();
  await store.create("recovery", "Build product", "repo");
  await store.append("recovery", { type: "task.added", task: { taskId: "root", role: "planner", objective: "Coordinate", scope: "repo", ownerSessionId: "owner-session", ownerPrincipalId: "operator" } });
  await store.append("recovery", { type: "task.started", taskId: "root", delegationId: "root-delegation" });
  await store.append("recovery", { type: "task.execution", taskId: "root", execution: { executionId: "root-turn", sessionId: "owner-session", delegationId: "root-delegation" } });
  await store.append("recovery", { type: "task.added", task: { taskId: "root/child", parentTaskId: "root", role: "worker", objective: "Implement", scope: "repo" } });
  await store.append("recovery", { type: "task.started", taskId: "root/child", delegationId: "child-delegation" });
  await store.append("recovery", { type: "task.execution", taskId: "root/child", execution: { executionId: "child-turn", sessionId: "child-session", usage: { inputTokens: 100 }, transcriptRef: "file:///child.jsonl" } });
  await store.append("recovery", { type: "task.artifact", taskId: "root/child", artifact: { kind: "report", uri: "file:///output.md", summary: "Implementation report" } });
  await store.append("recovery", { type: "task.failed", taskId: "root", error, ...(origin ? { failureOrigin: origin } : {}), ...(origin === "runtime" ? { failureCode: "SESSION_BUSY" } : {}) });
  if (ending === "completed") await store.append("recovery", { type: "run.completed" });
  else await store.append("recovery", { type: ending === "cancelled" ? "run.cancelled" : "run.failed", error });
  const calls: unknown[] = [];
  const executor = new SwarmExecutor({ execute: async (request) => {
    calls.push(request);
    if (request.target === "runtime.delegation.recover") return { status: "success", result: { output: { delegationId: "root-delegation", sessionId: "owner-session", state: "running" } } } as any;
    throw new Error("Recovery must not dispatch");
  } }, { eventStore: store });
  const input: SwarmRunRecoverSystemFailureInput = { runId: "recovery", reason: "Operator verified busy owner transport rejection; host continuation fixed", classification: "owner-session-busy-transport", expectedTaskFailureIndex: 9, expectedRunFailureIndex: 10 };
  return { store, executor, calls, input };
}
describe("explicit system failure recovery", () => {
  it("appends one audited event, preserves children/history, and remains paused without dispatch", async () => {
    const { store, executor, calls, input } = await fixture();
    // Busy children can emit final usage after the run failure; it is observational.
    await store.append("recovery", { type: "task.execution", taskId: "root/child", execution: { executionId: "child-final", sessionId: "child-session", usage: { outputTokens: 321 } } });
    await store.append("recovery", { type: "task.continued", taskId: "root/child" });
    const before = await store.read("recovery");
    const oldChild = replaySwarmRun(before).tasks[1];
    const recovered = await executor.recoverSystemFailure(input, owner);
    const after = await store.read("recovery");
    expect(after.slice(0, -1)).toEqual(before);
    expect(after.at(-1)).toMatchObject({ type: "run.systemFailureRecovered", classification: input.classification, expectedTaskFailureIndex: 9, expectedRunFailureIndex: 10, ownerSessionId: "owner-session", reason: input.reason });
    expect(recovered.state).toBe("paused");
    expect(recovered.tasks[0]).toMatchObject({ state: "running", resumeCount: 1, resumeReason: input.reason, delegationId: "root-delegation" });
    expect(recovered.tasks[1]).toEqual(oldChild);
    expect(calls).toEqual([expect.objectContaining({ target: "runtime.delegation.recover" })]);
    expect(await executor.recoverSystemFailure(input, owner)).toEqual(recovered);
    expect(await store.read("recovery")).toHaveLength(after.length);
    await expect(executor.recoverSystemFailure({ ...input, reason: "Different reason" }, owner)).rejects.toThrow("different input");
  });
  it("accepts typed runtime busy failures", async () => {
    const { executor, input } = await fixture(SWARM_OWNER_SESSION_BUSY_ERROR, "runtime");
    expect((await executor.recoverSystemFailure(input, owner)).state).toBe("paused");
  });
  it.each(["generic failure", "Agent requested failure"])("rejects non-busy failure %s", async (error) => {
    const { executor, input } = await fixture(error);
    await expect(executor.recoverSystemFailure(input, owner)).rejects.toThrow("exact failed owner-session");
  });
  it("rejects agent-explicit failure even when its message mimics the transport", async () => {
    const { executor, input } = await fixture(SWARM_OWNER_SESSION_BUSY_ERROR, "agent");
    await expect(executor.recoverSystemFailure(input, owner)).rejects.toThrow("exact failed owner-session");
  });
  it.each(["completed", "cancelled"] as const)("never recovers a %s run", async (ending) => {
    const { executor, input } = await fixture(SWARM_OWNER_SESSION_BUSY_ERROR, undefined, ending);
    await expect(executor.recoverSystemFailure(input, owner)).rejects.toThrow("exact failed owner-session");
  });
  it("requires original root identity and exact failure references", async () => {
    const { executor, input, store } = await fixture();
    const count = (await store.read("recovery")).length;
    for (const invocation of [{ ...owner, scope: { sessionId: "child-session" } }, { ...owner, principal: { id: "intruder" } }, { ...owner, scope: { sessionId: "stranger" } }])
      await expect(executor.recoverSystemFailure(input, invocation as InvocationContext)).rejects.toThrow();
    await expect(executor.recoverSystemFailure({ ...input, expectedTaskFailureIndex: 8 }, owner)).rejects.toThrow();
    expect(await store.read("recovery")).toHaveLength(count);
  });
  it("rejects lifecycle changes after the referenced failure pair", async () => {
    const { executor, input, store } = await fixture();
    await store.append("recovery", { type: "task.failed", taskId: "root/child", error: "Child explicitly failed", failureOrigin: "agent" });
    await expect(executor.recoverSystemFailure(input, owner)).rejects.toThrow("exact failed owner-session");
  });
  it("declares matching provider and UI operation inputs", async () => {
    const { executor } = await fixture();
    const provider = createSwarmProvider(executor);
    expect((await provider.get("swarm.runs.recoverSystemFailure"))?.inputSchema).toMatchObject({ required: ["runId", "reason", "classification", "expectedTaskFailureIndex", "expectedRunFailureIndex"] });
    expect(swarmRunApplication().actions?.find((action) => action.id === "swarm-runs-recover-system-failure")?.inputSchema).toMatchObject({ required: ["runId", "reason", "classification", "expectedTaskFailureIndex", "expectedRunFailureIndex"] });
  });
  it("recovers the actual failed native delegation before Swarm recovery and preserves native child lineage", async () => {
    const { store, input } = await fixture(SWARM_OWNER_SESSION_BUSY_ERROR, "runtime");
    const nativeStore = new InMemoryDelegationStore();
    await nativeStore.create({ delegationId: "root-delegation", adapterHandle: "owner-session", sessionId: "owner-session", ownerSessionId: "owner-session", ownerPrincipalId: "operator", state: "failed", error: SWARM_OWNER_SESSION_BUSY_ERROR });
    await nativeStore.create({ delegationId: "child-delegation", parentDelegationId: "root-delegation", adapterHandle: "child-session", sessionId: "child-session", state: "running", changeRefs: ["child-commit"] });
    const childBefore = await nativeStore.get("child-delegation");
    let continues = 0;
    let reconciliations = 0;
    const manager = new DelegationManager({ store: nativeStore, adapter: {
      spawn: async () => { throw new Error("Must not create a replacement delegation"); },
      continue: async (adapterHandle) => { continues++; return { adapterHandle, sessionId: "owner-session", state: "running" }; },
      recover: async (adapterHandle) => { reconciliations++; return { adapterHandle, sessionId: "owner-session", state: "running" }; },
      wait: async (adapterHandle) => ({ adapterHandle, state: "running" }),
      cancel: async () => { throw new Error("Must not cancel children"); },
    } });
    const context = { invocation: owner, scope: owner.scope };
    expect((await manager.continue({ delegationId: "root-delegation", prompt: "Continue" }, context)).state).toBe("failed");
    expect(continues).toBe(0); // The exact bug: native terminal short-circuit.
    const provider = createRuntimeDelegationProvider({ manager });
    const executor = new SwarmExecutor({ execute: async (request, invocation) => ({ status: "success", result: await provider.invoke(request.target, request.input, invocation) }) as any }, { eventStore: store });
    const append = store.append.bind(store);
    let failOnce = true;
    store.append = async (runId, event) => {
      if (event.type === "run.systemFailureRecovered" && failOnce) {
        failOnce = false;
        throw new Error("Simulated journal write interruption after native recovery");
      }
      await append(runId, event);
    };
    await expect(executor.recoverSystemFailure(input, owner)).rejects.toThrow("journal write interruption");
    expect(replaySwarmRun(await store.read("recovery")).state).toBe("failed");
    expect((await nativeStore.get("root-delegation"))!.state).toBe("running");
    const recovered = await executor.recoverSystemFailure(input, owner);
    expect(recovered.state).toBe("paused");
    expect(reconciliations).toBe(1);
    expect(continues).toBe(0);
    expect(recovered.tasks[0]!.delegationId).toBe("root-delegation");
    expect(await nativeStore.get("child-delegation")).toEqual(childBefore);
    expect((await manager.continue({ delegationId: "root-delegation", prompt: "Explicitly continue after recovery" }, context)).state).toBe("running");
    expect(continues).toBe(1);
    expect((await nativeStore.get("root-delegation"))!.error).toBeUndefined();
  });
  it("leaves the Swarm journal failed if native recovery cannot confirm the same session", async () => {
    const { store, input } = await fixture();
    const before = await store.read("recovery");
    const executor = new SwarmExecutor({ execute: async () => ({ status: "success", result: { output: { delegationId: "root-delegation", sessionId: "different-session", state: "running" } } }) as any }, { eventStore: store });
    await expect(executor.recoverSystemFailure(input, owner)).rejects.toThrow("same live owner session");
    expect(await store.read("recovery")).toEqual(before);
  });
});

 it("recovers only the exact superseded-before-send transport error with explicit classification", async () => {
   const { executor, input } = await fixture("Session send was superseded before it started", "runtime");
   await expect(executor.recoverSystemFailure(input, owner)).rejects.toThrow("exact failed owner-session transport tail");
   await expect(executor.recoverSystemFailure({ ...input, classification: "owner-session-superseded-transport" }, owner)).resolves.toMatchObject({ state: "paused" });
   const agentFailure = await fixture("Session send was superseded before it started", "agent");
   await expect(agentFailure.executor.recoverSystemFailure({ ...agentFailure.input, classification: "owner-session-superseded-transport" }, owner)).rejects.toThrow("exact failed owner-session transport tail");
 });
