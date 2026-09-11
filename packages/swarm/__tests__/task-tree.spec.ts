import { describe, expect, it } from "vitest";
import type { SwarmTask } from "../src/contracts.js";
import { taskPurpose, taskSession, taskStatus, taskTree } from "../src/ui/task-tree.js";

function task(taskId: string, parentTaskId?: string): SwarmTask {
  return { taskId, parentTaskId, objective: "Review output", role: "worker", scope: "repo", state: "running", childTaskIds: [], artifactRefs: [], executions: [] };
}

describe("agent ownership tree", () => {
  it("groups out-of-order children under their owner while keeping orphans visible", () => {
    const rows = taskTree([task("child", "root"), task("orphan", "missing"), task("root"), task("grandchild", "child")]);
    expect(rows.map(({ task, depth, detached }) => [task.taskId, depth, detached])).toEqual([
      ["orphan", 0, true], ["root", 0, false], ["child", 1, false], ["grandchild", 2, false],
    ]);
  });
  it("handles deeply nested and cyclic ownership without recursion or omitted agents", () => {
    const deep = Array.from({ length: 12000 }, (_, index) => task(String(index), index ? String(index - 1) : undefined));
    const rows = taskTree(deep);
    expect(rows).toHaveLength(12000);
    expect(rows.at(-1)?.depth).toBe(11999);
    const cycles = taskTree([task("a", "b"), task("b", "a"), task("self", "self")]);
    expect(cycles.map((row) => row.task.taskId)).toEqual(["a", "b", "self"]);
    expect(cycles.filter((row) => row.detached)).toHaveLength(2);
  });
  it("bounds huge prompts and uses a single purpose line", () => {
    const prompt = "## Implement search\n" + "Private detailed instructions ".repeat(300000);
    expect(taskPurpose(prompt)).toBe("Implement search");
    expect(taskPurpose("word ".repeat(1000000)).length).toBeLessThanOrEqual(96);
    expect(taskPurpose("word ".repeat(1000000))).toMatch(/…$/);
    expect(taskPurpose("  ")).toBe("Purpose not recorded");
  });
  it("opens the latest recorded agent session, never its owner's session", () => {
    const node = { ...task("a"), ownerSessionId: "owner", executions: [{ executionId: "1", sessionId: "old" }, { executionId: "2", sessionId: "current" }, { executionId: "3" }] };
    expect(taskSession(node)).toBe("current");
    expect(taskSession({ ...task("b"), ownerSessionId: "owner" })).toBeUndefined();
  });
  it("shows paused for active agents without hiding terminal or blocked state", () => {
    expect(taskStatus(task("a"), "paused")).toBe("paused");
    expect(taskStatus({ ...task("a"), state: "completed" }, "paused")).toBe("completed");
    expect(taskStatus({ ...task("a"), state: "blocked" }, "running")).toBe("blocked");
  });
});
