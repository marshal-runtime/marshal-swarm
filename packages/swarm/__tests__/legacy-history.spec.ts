import { describe, it, expect } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { InvocationContext } from "@marshal/runtime";
import {
  FileSwarmRunEventStore,
  SwarmExecutor,
  replaySwarmRun,
} from "../src/index.js";
const owner = {
  principal: { id: "current-principal" },
  scope: { sessionId: "original-session" },
} as InvocationContext;
function history(runId: string, completed = true) {
  return [
    { type: "run.created", runId, objective: "Yesterday work", scope: "repo" },
    {
      type: "task.added",
      task: {
        taskId: "root",
        role: "planner",
        objective: "Yesterday work",
        scope: "repo",
      },
    },
    {
      type: "task.started",
      taskId: "root",
      delegationId: "original-delegation",
    },
    ...(completed
      ? [
          {
            type: "task.completed",
            taskId: "root",
            result: "Original final answer",
          },
          { type: "run.completed", result: "Original final answer" },
        ]
      : []),
  ];
}
describe("legacy Swarm history remains readable", () => {
  it.each(["owner.", "marshal-swarm."])(
    "reads completed %s history without inventing artifacts or rewriting files",
    async (prefix) => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "swarm-legacy-"));
      try {
        const runId =
          prefix +
          Buffer.from("original-session").toString("base64url") +
          ".old";
        const file = path.join(dir, `run-${encodeURIComponent(runId)}.jsonl`);
        const original =
          history(runId)
            .map((event) => JSON.stringify(event))
            .join("\n") + "\n";
        await writeFile(file, original);
        const store = new FileSwarmRunEventStore(dir);
        const executor = new SwarmExecutor(
          {
            execute: async () => {
              throw new Error("Legacy must not dispatch");
            },
          },
          { eventStore: store },
        );
        const run = await executor.getAuthorized({ runId }, owner);
        expect(run.legacyReadOnly).toBe(true);
        expect(run.state).toBe("completed");
        expect(run.tasks[0].artifactRefs).toEqual([]);
        expect(run.result).toBe("Original final answer");
        expect(await executor.listAuthorized(owner)).toHaveLength(1);
        await expect(executor.drive({ runId }, owner)).rejects.toThrow(
          "read-only",
        );
        await expect(
          store.append(runId, { type: "run.resumed" }),
        ).rejects.toThrow("read-only");
        expect(await readFile(file, "utf8")).toBe(original);
        await expect(
          executor.getAuthorized({ runId }, {
            ...owner,
            scope: { sessionId: "foreign" },
          } as InvocationContext),
        ).rejects.toThrow("own");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
  it("exposes incomplete history as paused read-only with an explicit restart reason", () => {
    const run = replaySwarmRun(
      history("owner.b3JpZ2luYWwtc2Vzc2lvbg.old", false),
    );
    expect(run.state).toBe("paused");
    expect(run.legacyReadOnly).toBe(true);
    expect(run.pauseReason?.message).toContain("Start a new");
  });
  it("retains legacy retry and structured failure events", () => {
    const events = history("owner.b3JpZ2luYWwtc2Vzc2lvbg.old", false);
    const run = replaySwarmRun([
      ...events,
      {
        type: "task.failed",
        taskId: "root",
        error: { message: "Old failure" },
      },
      { type: "task.started", taskId: "root", delegationId: "retry" },
      { type: "task.completed", taskId: "root", result: "Recovered" },
      { type: "run.completed" },
    ]);
    expect(run.state).toBe("completed");
  });
  it("keeps version2 completion strict and versions newly created journals", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "swarm-new-"));
    try {
      const store = new FileSwarmRunEventStore(dir);
      await store.create("new", "Build", "repo");
      expect((await store.read("new"))[0]).toMatchObject({
        protocolVersion: 2,
      });
      await store.append("new", {
        type: "task.added",
        task: {
          taskId: "root",
          role: "planner",
          objective: "Build",
          scope: "repo",
        },
      });
      await store.append("new", { type: "task.started", taskId: "root" });
      await expect(
        store.append("new", { type: "task.completed", taskId: "root" }),
      ).rejects.toThrow("artifact");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("does not expose custom unowned legacy identifiers", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "swarm-unowned-"));
    try {
      await writeFile(
        path.join(dir, "run-custom.jsonl"),
        history("custom")
          .map((event) => JSON.stringify(event))
          .join("\n") + "\n",
      );
      const executor = new SwarmExecutor(
        {
          execute: async () => {
            throw new Error("unused");
          },
        },
        { eventStore: new FileSwarmRunEventStore(dir) },
      );
      expect(await executor.listAuthorized(owner)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
