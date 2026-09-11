import { describe, expect, it } from "vitest";

import type { SwarmRun, SwarmTask } from "../src/contracts.js";
import { summarizeRunOutcome } from "../src/outcome-summary.js";
import { projectSwarmRunView } from "../src/view-projection.js";

function task(overrides: Partial<SwarmTask> & Pick<SwarmTask, "taskId" | "state">): SwarmTask {
  return {
    role: "worker",
    objective: `Objective for ${overrides.taskId}`,
    scope: "zyg",
    childTaskIds: [],
    artifactRefs: [],
    executions: [],
    ...overrides,
  } as SwarmTask;
}

function run(state: SwarmRun["state"], tasks: readonly SwarmTask[]): SwarmRun {
  return { runId: "owner.session.run", objective: "Ship the thing", scope: "zyg", state, tasks };
}

describe("summarizeRunOutcome", () => {
  it("reads a clean completed run back factually — counts only, no success language beyond task states", () => {
    const summary = summarizeRunOutcome(run("completed", [
      task({ taskId: "root", role: "planner", state: "completed" }),
      task({ taskId: "w1", state: "completed" }),
    ]));
    expect(summary).toEqual({
      taskCounts: { completed: 2 },
      totalTasks: 2,
      failedTasks: [],
      headline: "Execution completed; all 2 tasks reached completed.",
    });
  });

  it("names failed tasks on a completed run — completion still stands, the reading changes", () => {
    const summary = summarizeRunOutcome(run("completed", [
      task({ taskId: "root", role: "planner", state: "completed" }),
      task({ taskId: "w1", state: "completed" }),
      task({ taskId: "probe", role: "worker", state: "failed", objective: "Exploratory probe of flaky lane", reason: "Fixture host unreachable" }),
    ]));
    expect(summary.headline).toBe("Execution completed with 1 failed task (2 of 3 completed).");
    expect(summary.failedTasks).toEqual([
      { taskId: "probe", role: "worker", objective: "Exploratory probe of flaky lane", reason: "Fixture host unreachable" },
    ]);
    expect(summary.taskCounts).toEqual({ completed: 2, failed: 1 });
  });

  it("does NOT block or reinterpret recovery patterns — a superseded failure is listed, nothing more", () => {
    const summary = summarizeRunOutcome(run("completed", [
      task({ taskId: "root", role: "planner", state: "completed" }),
      task({ taskId: "attempt-1", state: "failed", error: { message: "worker crashed" } }),
      task({ taskId: "attempt-2", state: "completed", objective: "Replacement for attempt-1" }),
    ]));
    expect(summary.headline).toContain("Execution completed with 1 failed task");
    expect(summary.failedTasks[0]).toMatchObject({ taskId: "attempt-1", reason: "worker crashed" });
  });

  it("summarizes failed runs and stays headline-free for non-terminal states", () => {
    expect(summarizeRunOutcome(run("failed", [
      task({ taskId: "root", role: "planner", state: "failed", reason: "Root task failed." }),
    ])).headline).toBe("Execution failed (0 of 1 tasks completed, 1 failed).");
    const running = summarizeRunOutcome(run("running", [
      task({ taskId: "root", role: "planner", state: "running" }),
      task({ taskId: "w1", state: "failed", reason: "lane stalled" }),
    ]));
    expect(running.headline).toBeUndefined();
    expect(running.failedTasks).toHaveLength(1);
  });

  it("bounds objectives to their first line and reasons to a preview", () => {
    const summary = summarizeRunOutcome(run("completed", [
      task({ taskId: "root", role: "planner", state: "completed" }),
      task({ taskId: "w1", state: "failed", objective: `${"very long ".repeat(40)}\nsecond line`, reason: "x".repeat(4000) }),
    ]));
    const failed = summary.failedTasks[0]!;
    expect(failed.objective.length).toBeLessThanOrEqual(160);
    expect(failed.objective).not.toContain("second line");
    expect(failed.reason!.length).toBeLessThanOrEqual(256);
    expect(failed.reason!.endsWith("…")).toBe(true);
  });

  it("rides the view projection as a derived field and survives the JSON round trip", () => {
    const projected = projectSwarmRunView(run("completed", [
      task({ taskId: "root", role: "planner", state: "completed" }),
      task({ taskId: "w1", state: "failed", reason: "boom" }),
    ]));
    expect(projected.outcome.headline).toContain("Execution completed with 1 failed task");
    expect(projected.outcome.failedTasks[0]).toMatchObject({ taskId: "w1", role: "worker" });
    // Derived only: the input run value is untouched.
    expect("outcome" in run("completed", [])).toBe(false);
  });
});
