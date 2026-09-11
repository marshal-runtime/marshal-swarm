import { describe, expect, it } from "vitest";
import type { InvocationContext } from "@marshal/runtime";
import { SwarmExecutor, InMemorySwarmRunEventStore, SwarmServiceContainer, SwarmServiceSymbols, replaySwarmRun, createSwarmProvider, type SwarmRoleModels, type SwarmTaskRole } from "../src/index.js";
const owner = { principal: { id: "owner" }, scope: { sessionId: "owner-session" } } as InvocationContext;
const policy: SwarmRoleModels = {
  planner: { model: "claude-fable-5", reasoningEffort: "max" },
  reviewer: { model: "claude-fable-5", reasoningEffort: "max" },
  worker: { model: "claude-sonnet-5", reasoningEffort: "high" },
  reconciler: { model: "claude-opus-4-8", reasoningEffort: "max" },
};
async function fixture(roleModels?: SwarmRoleModels, unavailable?: string, hostResolve = (_role: SwarmTaskRole) => ({ model: "host-fallback", reasoningEffort: "low" }), legacyWorker = true) {
  const store = new InMemorySwarmRunEventStore();
  const services = new SwarmServiceContainer();
  services.bind(SwarmServiceSymbols.sharedContext, { read: async () => ({ path: "guide.md", content: "Guide" }) });
  services.bind(SwarmServiceSymbols.roleModel, { resolve: hostResolve });
  const calls: any[] = [];
  const executor = new SwarmExecutor({ execute: async (request: any) => {
    calls.push(request);
    if (request.target === "runtime.delegation.spawn" && request.input.model === unavailable)
      return { result: { output: { state: "failed", error: "Explicit requested model is unavailable" } } };
    return { result: { output: { delegationId: request.input.delegationId, state: "done", sessionId: `session-${request.input.delegationId}` } } };
  } } as any, { eventStore: store, serviceContainer: services });
  await executor.create({ runId: "models", objective: "Build", scope: "repo", ...(legacyWorker ? { workerModel: "legacy-worker", workerReasoningEffort: "medium" } : {}), ...(roleModels ? { roleModels } : {}) }, owner);
  return { store, executor, calls };
}
async function child(store: InMemorySwarmRunEventStore, role: SwarmTaskRole) {
  await store.append("models", { type: "task.started", taskId: "root", delegationId: "root-delegation" });
  await store.append("models", { type: "task.added", task: { taskId: `root/${role}`, parentTaskId: "root", role, scope: "repo", objective: role } });
}
describe("durable run role model policy", () => {
  it("snapshots omitted policies from host settings and retains them after settings drift", async () => {
    let selected = "approved";
    const { store, executor, calls } = await fixture(undefined, undefined,
      (role) => ({ model: `${selected}-${role}`, reasoningEffort: "high" }), false);
    expect((await executor.get({ runId: "models" })).roleModels).toEqual(Object.fromEntries(
      ["planner", "reviewer", "worker", "reconciler"].map((role) => [role, { model: `approved-${role}`, reasoningEffort: "high" }])));
    selected = "changed";
    await child(store, "worker");
    await executor.drive({ runId: "models" }, owner);
    expect(calls.find((call) => call.target === "runtime.delegation.spawn")?.input.model).toBe("approved-worker");
  });
  it("honors complete explicit policy without evaluating unavailable host defaults", async () => {
    const { store, executor, calls } = await fixture(policy, undefined,
      () => { throw new Error("host default unavailable"); });
    await child(store, "worker");
    await executor.drive({ runId: "models" }, owner);
    expect(calls.find((call) => call.target === "runtime.delegation.spawn")?.input.model).toBe(policy.worker!.model);
  });
  it("fails creation when an omitted role policy cannot be resolved", async () => {
    await expect(fixture(undefined, undefined, () => { throw new Error("host default unavailable"); }))
      .rejects.toThrow("host default unavailable");
  });

  it("persists create configuration and replays it without replacing legacy worker options", async () => {
    const { store, executor } = await fixture(policy);
    const events = await store.read("models");
    expect(events[0]).toMatchObject({ type: "run.created", roleModels: policy, workerModel: "legacy-worker" });
    expect(replaySwarmRun(events).roleModels).toEqual(policy);
    expect((await executor.get({ runId: "models" })).workerReasoningEffort).toBe("medium");
  });
  it("updates only supplied roles with owner audit, preserving active children and paused state", async () => {
    const { store, executor, calls } = await fixture({ planner: policy.planner! });
    await child(store, "reconciler");
    await store.append("models", { type: "task.started", taskId: "root/reconciler", delegationId: "existing" });
    await store.append("models", { type: "task.execution", taskId: "root/reconciler", execution: { executionId: "existing-turn", sessionId: "existing-session", model: "prior-selection" } });
    await store.append("models", { type: "run.paused", reason: { kind: "manual", message: "Review model policy" } });
    const before = await store.read("models");
    const run = await executor.setRoleModels({ runId: "models", roleModels: { reconciler: policy.reconciler! }, reason: "Reconciliation must use the selected Opus model" }, owner);
    const after = await store.read("models");
    expect(after.slice(0, -1)).toEqual(before);
    expect(after.at(-1)).toMatchObject({ type: "run.roleModelsUpdated", ownerSessionId: "owner-session", ownerPrincipalId: "owner", reason: "Reconciliation must use the selected Opus model" });
    expect(run.roleModels).toMatchObject({ planner: policy.planner, reconciler: policy.reconciler });
    expect(run.tasks).toEqual(replaySwarmRun(before).tasks);
    expect(run.state).toBe("paused");
    expect(calls).toEqual([]);
  });
  it.each(["planner", "worker", "reviewer", "reconciler"] as const)("dispatches %s with the stored role selection ahead of host/worker fallbacks", async (role) => {
    const { store, executor, calls } = await fixture();
    await child(store, role);
    await executor.setRoleModels({ runId: "models", roleModels: policy, reason: "Apply approved role plan" }, owner);
    await executor.drive({ runId: "models" }, owner);
    expect(calls.find((call) => call.target === "runtime.delegation.spawn")?.input).toMatchObject({ role, ...policy[role] });
    const reserved = (await store.read("models")).find((event) => event.type === "task.dispatched" && event.taskId === `root/${role}`);
    expect(reserved?.type === "task.dispatched" && reserved.execution.launchInput).toMatchObject(policy[role]!);
  });
  it("keeps legacy worker overrides when there is no explicit worker role policy", async () => {
    const { store, executor, calls } = await fixture({ reconciler: policy.reconciler! });
    await child(store, "worker");
    await executor.drive({ runId: "models" }, owner);
    expect(calls.find((call) => call.target === "runtime.delegation.spawn")?.input).toMatchObject({ model: "legacy-worker", reasoningEffort: "medium" });
  });
  it("blocks a reserved dispatch whose policy changed without rewriting its history", async () => {
    const { store, executor, calls } = await fixture();
    await child(store, "reconciler");
    await store.append("models", { type: "task.dispatched", taskId: "root/reconciler", execution: {
      executionId: "reserved", delegationId: "reserved-delegation", dispatchState: "registered", model: "reserved-model",
      launchInput: { prompt: "Original exact dispatch", model: "reserved-model", delegationId: "reserved-delegation", idempotencyKey: "reserved", scope: "repo", role: "reconciler" },
    } });
    await executor.setRoleModels({ runId: "models", roleModels: policy, reason: "Change subsequent launches" }, owner);
    await executor.drive({ runId: "models" }, owner);
    expect(calls.filter((call) => call.target === "runtime.delegation.spawn")).toHaveLength(0);
    expect((await executor.get({ runId: "models" })).tasks[1]?.error).toContain("conflicts with the current reconciler model policy");
    expect((await executor.get({ runId: "models" })).roleModels).toEqual(policy);
    expect((await executor.get({ runId: "models" })).tasks[1]?.executions[0]?.model).toBe("reserved-model");
  });
  it("does not substitute a fallback when the host rejects an explicit model", async () => {
    const { store, executor, calls } = await fixture({ reconciler: { model: "unavailable-opus" } }, "unavailable-opus");
    await child(store, "reconciler");
    await executor.drive({ runId: "models" }, owner);
    const spawns = calls.filter((call) => call.target === "runtime.delegation.spawn");
    expect(spawns).toHaveLength(1);
    expect(spawns[0].input.model).toBe("unavailable-opus");
    expect((await executor.get({ runId: "models" })).tasks[1]).toMatchObject({ state: "failed", error: "Explicit requested model is unavailable" });
  });
  it("rejects unknown roles/fields, empty model selections, foreign owners and terminal updates", async () => {
    const { store, executor } = await fixture();
    const provider = createSwarmProvider(executor);
    for (const roleModels of [{ supervisor: { model: "x" } }, { reconciler: { model: "" } }, { worker: { model: "x", secret: true } }, {}])
      await expect(provider.invoke("swarm.runs.setRoleModels", { runId: "models", roleModels, reason: "bad" }, owner)).rejects.toThrow();
    await expect(executor.setRoleModels({ runId: "models", roleModels: policy, reason: "foreign" }, { ...owner, scope: { sessionId: "foreign" } } as InvocationContext)).rejects.toThrow();
    await store.append("models", { type: "run.completed" });
    await expect(executor.setRoleModels({ runId: "models", roleModels: policy, reason: "late" }, owner)).rejects.toThrow("terminal");
  });
});
