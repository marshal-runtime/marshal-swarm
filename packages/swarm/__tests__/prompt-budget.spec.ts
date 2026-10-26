import { expect, it } from "vitest";
import type { InvocationContext } from "@marshal/runtime";
import { InMemorySwarmRunEventStore, SwarmExecutor, SwarmServiceContainer,
  SwarmServiceSymbols, replaySwarmRun, type SwarmRun, type SwarmTask } from "../src/index.js";
import { executableSwarmTasks, type ExecutableTask } from "../src/executor-tasks.js";
import { promptFor } from "../src/executor-prompts.js";
import { promptReceiptFor } from "../src/prompt-context.js";

const guide = { path: "/tmp/field-guide/index.md", content: "Binding decisions" };
const owner = { principal: { id: "owner" }, scope: { sessionId: "owner" } } as InvocationContext;
function fixture() {
  const root: SwarmTask = { taskId: "root", role: "planner", objective: "Unique complete objective",
    scope: "repo", state: "running", delegationId: "root-d", childTaskIds: [], artifactRefs: [], executions: [] };
  const run: SwarmRun = { runId: "budget", objective: root.objective, scope: "repo", state: "running",
    tasks: [root], targets: [{ scope: "repo", ref: "main", head: "original-sha" }] };
  const ready: ExecutableTask = { task: root, childResults: [], outstanding: [] };
  return { root, run, ready };
}

it("resends neither old outcomes nor static context, while changes and replacement agents retain context", () => {
  const { root, run, ready } = fixture();
  const old = { taskId: "done", role: "worker", state: "completed" as const, resumeCount: 0,
    result: "Old outcome" };
  const before = { ...ready, childResults: [old] };
  const acknowledged = { ...root, promptReceipt: promptReceiptFor(before, guide, run) };
  const after = { ...before, task: acknowledged, childResults: [old,
    { ...old, taskId: "new", result: "New outcome" }] };
  const prompt = promptFor(after, guide, run);
  expect(prompt).toContain("New outcome");
  expect(prompt).toContain('"taskId":"root/new"');
  for (const text of ["Old outcome", root.objective, guide.content, "## Role contract", "## Response interface"])
    expect(prompt).not.toContain(text);
  expect(prompt.length).toBeLessThan(2_000);
  const changed = promptFor(after, { ...guide, content: "Updated binding decision" }, run,
    { ref: "integration", head: "advanced-sha" });
  expect(changed).toContain("Updated binding decision");
  expect(changed).toContain("advanced-sha");
  expect(changed).not.toContain(guide.content);
  const fresh = promptFor(after, guide, run, undefined, true);
  expect(fresh).toContain(root.objective);
  expect(fresh).toContain("Old outcome");
  expect(fresh).toContain("## Role contract");
  const updatedObjective = promptFor({ ...after, task: { ...acknowledged, objective: "Changed objective" } }, guide, run);
  expect(updatedObjective).toContain("Changed objective");
});

it("bounds giant results and guides without mutating authoritative evidence", () => {
  const { run, ready } = fixture();
  const huge = "Unique evidence ".repeat(20_000);
  const childResults = Array.from({ length: 60 }, (_, index) => ({ taskId: `child-${index}`, role: "worker",
    state: "completed" as const, resumeCount: 0, result: { commands: huge, coverage: huge } }));
  const context = { ...guide, content: huge, topics: [{ path: "/tmp/other.md", content: huge }] };
  const prompt = promptFor({ ...ready, childResults }, context, run);
  expect(prompt.length).toBeLessThan(15_000);
  expect(prompt).toContain('"truncated":true');
  expect(prompt).toContain("additional changed outcomes omitted");
  expect(prompt).toContain('swarm.nodes.get({runId,taskId,view:"result"})');
  expect(prompt).toContain("Read this file in full before acting");
  expect(prompt).toContain("/tmp/other.md");
  expect(childResults[0].result.coverage).toBe(huge);
});

it("notifies an identical blocker again after child resume and detects removed topics", () => {
  const { root, run, ready } = fixture();
  const child = { taskId: "worker", role: "worker", state: "blocked" as const, resumeCount: 0, reason: "Access missing" };
  const before = { ...ready, childResults: [child] };
  const previousGuide = { ...guide, topics: [{ path: "/tmp/topic.md", content: "Topic" }] };
  const task = { ...root, promptReceipt: promptReceiptFor(before, previousGuide, run) };
  const prompt = promptFor({ ...before, task, childResults: [{ ...child, resumeCount: 1 }] }, guide, run);
  expect(prompt).toContain("Access missing");
  expect(prompt).toContain("Removed Field Guide topic: /tmp/topic.md");
});

it("custom system-prompt roles receive changed outcomes without shared run context", () => {
  const { root, run, ready } = fixture();
  const task = { ...root, role: "worker" as const, definedRole: "custom" };
  const definedRun = { ...run, roles: [{ name: "custom", base: "worker" as const, model: "model",
    whenToUse: "Bounded work", instructions: "Do the work", systemPrompt: "Private system rules" }] };
  const prompt = promptFor({ ...ready, task, childResults: [{ taskId: "new", role: "worker",
    state: "completed", resumeCount: 0, result: "New evidence" }] }, guide, definedRun);
  expect(prompt).toContain("New evidence");
  expect(prompt).not.toContain(guide.content);
});

it("persists delivery receipts across executor restarts and does not acknowledge held or rejected continuations", async () => {
  const store = new InMemorySwarmRunEventStore();
  const services = new SwarmServiceContainer();
  services.bind(SwarmServiceSymbols.sharedContext, { read: async () => guide });
  let delivery = "accepted";
  const prompts: string[] = [];
  const factory = { execute: async (request: any) => {
    if (request.target === "runtime.delegation.continue") {
      prompts.push(request.input.prompt);
      if (delivery === "rejected") return { result: { output: { delegationId: request.input.delegationId, error: "Delivery failed" } } };
    }
    return { result: { output: { delegationId: request.input.delegationId, state: "running", continuationDelivery: delivery } } };
  } };
  const makeExecutor = () => new SwarmExecutor(factory as any, { eventStore: store, serviceContainer: services });
  const executor = makeExecutor();
  await executor.create({ runId: "budget", objective: "Objective survives", scope: "repo" }, owner);
  const launch = async (instance = executor) => {
    const run = replaySwarmRun(await store.read("budget"));
    const ready = executableSwarmTasks(run).find((task) => task.task.taskId === "root")!;
    return (instance as any).launch("budget", run, ready, owner);
  };
  await launch();
  expect(replaySwarmRun(await store.read("budget")).tasks[0].promptReceipt).toBeDefined();
  const completeChild = async (id: string) => {
    await store.append("budget", { type: "task.added", task: { taskId: `root/${id}`, parentTaskId: "root",
      role: "worker", objective: id, scope: "repo" } });
    await store.append("budget", { type: "task.started", taskId: `root/${id}`, delegationId: id });
    await store.append("budget", { type: "task.completed", taskId: `root/${id}`, result: `Result ${id}` });
  };
  await completeChild("first");
  await launch();
  await completeChild("second");
  const receipt = replaySwarmRun(await store.read("budget")).tasks[0].promptReceipt;
  delivery = "held";
  await launch(makeExecutor());
  expect(replaySwarmRun(await store.read("budget")).tasks[0].promptReceipt).toEqual(receipt);
  delivery = "rejected";
  await launch(makeExecutor());
  expect(replaySwarmRun(await store.read("budget")).tasks[0].promptReceipt).toEqual(receipt);
  delivery = "accepted";
  await launch(makeExecutor());
  expect(prompts.at(-1)).toContain("Result second");
  expect(prompts.at(-1)).not.toContain("Result first");
  expect(prompts.at(-1)).not.toContain("Objective survives");
  expect(replaySwarmRun(await store.read("budget")).tasks[0].promptReceipt?.children.second).toBeDefined();
  const full = await executor.nodeOperation("get", { runId: "budget", taskId: "root/first" }, owner);
  expect(full).toMatchObject({ result: "Result first" });
  const result = await executor.nodeOperation("get", { runId: "budget", taskId: "root", view: "result" }, owner) as any;
  expect(result.objective).toBe("Objective survives");
  expect(result.roleContract).toContain("You are the only owner of field-guide/index.md. Keep it small: curate only durable global decisions, surprising facts, and links to explicitly assigned topic files.");
  expect(result.executions).toBeUndefined();
  expect(result.promptReceipt).toBeUndefined();
  const page = await executor.nodeOperation("list", { runId: "budget", parentTaskId: "root", view: "summary", limit: 1, offset: 1 }, owner);
  expect(page).toEqual([expect.objectContaining({ taskId: "root/second", hasResult: true })]);
  expect(JSON.stringify(page)).not.toContain("Result second");
});

it.each([false, true])("registered dispatch recovery only acknowledges the reserved child snapshot (legacy receipt: %s)", async (legacy) => {
  const store = new InMemorySwarmRunEventStore();
  const services = new SwarmServiceContainer();
  services.bind(SwarmServiceSymbols.sharedContext, { read: async () => guide });
  const calls: any[] = [];
  const executor = new SwarmExecutor({ execute: async (request: any) => {
    calls.push(request);
    return { result: { output: { delegationId: request.input.delegationId, state: "done", continuationDelivery: "accepted" } } };
  } } as any, { eventStore: store, serviceContainer: services });
  await executor.create({ runId: "budget", objective: "Recovered objective", scope: "repo" }, owner);
  const initialRun = replaySwarmRun(await store.read("budget"));
  const initialReady = executableSwarmTasks(initialRun)[0];
  const receipt = promptReceiptFor(initialReady, guide, initialRun);
  await store.append("budget", { type: "task.dispatched", taskId: "root", execution: {
    executionId: "reserved", delegationId: "root-d", dispatchState: "registered", ...(legacy ? {} : { promptReceipt: receipt }),
    launchInput: { prompt: promptFor(initialReady, guide, initialRun), delegationId: "root-d", scope: "repo", role: "planner", idempotencyKey: "reserved" },
  } });
  await store.append("budget", { type: "task.added", task: { taskId: "root/new", parentTaskId: "root", role: "worker", objective: "new", scope: "repo" } });
  await store.append("budget", { type: "task.started", taskId: "root/new", delegationId: "child-d" });
  await store.append("budget", { type: "task.completed", taskId: "root/new", result: "Outcome arrived after reservation" });
  await executor.drive({ runId: "budget" }, owner);
  expect(calls.find((call) => call.target === "runtime.delegation.spawn").input.prompt).not.toContain("Outcome arrived after reservation");
  expect(calls.find((call) => call.target === "runtime.delegation.continue").input.prompt).toContain("Outcome arrived after reservation");
  const notifications = (await store.read("budget")).filter((event) => event.type === "task.childrenNotified");
  if (legacy) {
    expect(notifications[0]).not.toMatchObject({ signature: receipt.attention });
  } else {
    expect(notifications[0]).toMatchObject({ signature: receipt.attention });
    expect(notifications[1]).not.toMatchObject({ signature: receipt.attention });
  }
});
