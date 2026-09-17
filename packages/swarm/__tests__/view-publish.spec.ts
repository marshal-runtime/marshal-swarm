import type { InvocationContext, RuntimeExecResponse } from "@marshal/runtime";
import { describe, expect, it } from "vitest";

import type { SwarmRun } from "../src/contracts.js";
import { SWARM_EXTENSION_IDENTITY, SWARM_RUN_APPLICATION_ID } from "../src/presentation.js";
import { projectSwarmRunView } from "../src/view-projection.js";
import {
  publishSwarmRunView,
  UI_APPLICATION_LIST,
  UI_APPLICATION_OPEN,
  UI_SURFACE_INLINE_CARD,
  UI_SURFACE_PANEL,
} from "../src/view-publish.js";

const RUN_ID = "owner.session.abc";
const SESSION_ID = "session-1";
const WORKSPACE_NAME = "zyg";
const RUN: SwarmRun = {
  runId: RUN_ID,
  objective: "Ship the view",
  scope: WORKSPACE_NAME,
  state: "running",
  tasks: [
    {
      taskId: "root",
      role: "planner",
      objective: "Ship the view",
      scope: WORKSPACE_NAME,
      state: "running",
      childTaskIds: [],
      artifactRefs: [],
      executions: [],
    },
  ],
};

describe("publishSwarmRunView", () => {
  describe("Sanity", () => {
    it("opens a panel and a chat card for a scoped create", async () => {
      const calls: { readonly target: string; readonly input: Record<string, unknown> }[] = [];
      await publishSwarmRunView(RUN, scopedInvocation(), async (request) => {
        calls.push({
          target: request.target,
          input: request.input as Record<string, unknown>,
        });
        return success({ instances: [] });
      });
      const opens = calls.filter((call) => call.target === UI_APPLICATION_OPEN);
      expect(opens.map((call) => call.input.surface)).toEqual([
        UI_SURFACE_PANEL,
        UI_SURFACE_INLINE_CARD,
      ]);
      expect(opens[0]?.input).toMatchObject({
        extensionId: SWARM_EXTENSION_IDENTITY,
        applicationId: SWARM_RUN_APPLICATION_ID,
        state: { run: RUN },
      });
    });

    it("updates an existing surface instead of opening another", async () => {
      const calls: { readonly target: string; readonly input: Record<string, unknown> }[] = [];
      await publishSwarmRunView(RUN, scopedInvocation(), async (request) => {
        calls.push({
          target: request.target,
          input: request.input as Record<string, unknown>,
        });
        if (request.target === UI_APPLICATION_LIST) {
          return success({
            instances: [
              {
                instanceId: "panel-1",
                surface: UI_SURFACE_PANEL,
                revision: 4,
                content: { state: { run: { runId: RUN_ID } } },
              },
            ],
          });
        }
        return success({});
      });
      expect(
        calls.some(
          (call) => call.target === UI_APPLICATION_OPEN && call.input.surface === UI_SURFACE_PANEL,
        ),
      ).toBe(false);
      expect(
        calls.some(
          (call) => call.target === "ui.application.update" && call.input.instanceId === "panel-1",
        ),
      ).toBe(true);
    });

    it("does not reopen closed surfaces during a background refresh", async () => {
      const calls: string[] = [];
      await publishSwarmRunView(
        RUN,
        scopedInvocation(),
        async (request) => {
          calls.push(request.target);
          return success({ instances: [] });
        },
        { openIfMissing: false },
      );
      expect(calls).toEqual([UI_APPLICATION_LIST, UI_APPLICATION_LIST]);
    });
  });

  describe("Error Handling", () => {
    it("propagates a Runtime UI execute failure", async () => {
      await expect(
        publishSwarmRunView(RUN, scopedInvocation(), async () => {
          throw new Error("ui denied");
        }),
      ).rejects.toThrow("ui denied");
    });
  });

  describe("Edge Cases", () => {
    it("skips injection when the invocation has no session", async () => {
      const calls: string[] = [];
      await publishSwarmRunView(
        RUN,
        { principal: { id: "test" } } as InvocationContext,
        async (request) => {
          calls.push(request.target);
          return success({});
        },
      );
      expect(calls).toEqual([]);
    });
  });
});

function scopedInvocation(): InvocationContext {
  return {
    principal: { id: "test" },
    scope: { sessionId: SESSION_ID },
    metadata: { marshalWorkspaceName: WORKSPACE_NAME },
  } as InvocationContext;
}

function success(value: unknown): RuntimeExecResponse {
  return {
    status: "success",
    result: { output: { ok: true, value } },
  } as RuntimeExecResponse;
}

it("keeps separate runs distinct and allows reopening after a close", async () => {
  const opens: Record<string, unknown>[] = [];
  const execute = async (request: any) => {
    if (request.target === UI_APPLICATION_LIST)
      return success({
        instances: [
          {
            instanceId: "other-run-panel",
            surface: UI_SURFACE_PANEL,
            content: { state: { run: { runId: "other" } } },
          },
        ],
      });
    if (request.target === UI_APPLICATION_OPEN) opens.push(request.input);
    return success({});
  };
  await publishSwarmRunView(RUN, scopedInvocation(), execute);
  await publishSwarmRunView(RUN, scopedInvocation(), execute);
  const panels = opens.filter((input) => input.surface === UI_SURFACE_PANEL);
  expect(panels).toHaveLength(2);
  expect(panels[0]?.idempotencyKey).not.toBe(panels[1]?.idempotencyKey);
});

it("serializes simultaneous publications so each run has one instance per surface", async () => {
  const instances: any[] = [];
  let opened = 0;
  const execute = async (request: any) => {
    if (request.target === UI_APPLICATION_LIST) return success({ instances: [...instances] });
    if (request.target === UI_APPLICATION_OPEN) {
      opened++;
      instances.push({ instanceId: `instance-${opened}`, surface: request.input.surface, content: { state: request.input.state } });
    }
    return success({});
  };
  await Promise.all([publishSwarmRunView(RUN, scopedInvocation(), execute), publishSwarmRunView(RUN, scopedInvocation(), execute)]);
  expect(opened).toBe(2);
});

it("publishes giant real-world dispatch prompts through open and update without altering durable history", async () => {
  const instructions = "Inspect the repository, preserve uncommitted work, implement the assigned changes, and report test evidence.\n".repeat(3000);
  const uri = `file:///workspace/${"nested-directory/".repeat(20)}implementation-report.md`;
  const canonical: SwarmRun = {
    ...RUN,
    objective: `Build the requested product\n${instructions}`,
    pauseReason: { kind: "manual", message: instructions },
    error: { message: instructions, detail: Array.from({ length: 100 }, () => ({ nested: instructions })) },
    result: { output: instructions },
    tasks: Array.from({ length: 8 }, (_, index) => ({
      ...RUN.tasks[0]!,
      taskId: `task-${index}`,
      ...(index && { parentTaskId: "task-0", dependencyTaskIds: [`task-${index - 1}`] }),
      childTaskIds: index === 0 ? ["task-1", "task-2"] : [],
      objective: `Implement component ${index}\n${instructions}`,
      reason: instructions,
      resumeReason: instructions,
      result: { content: instructions },
      error: { message: instructions },
      artifactRefs: [{ kind: "report" as const, uri, summary: instructions }],
      executions: [{
        executionId: `execution-${index}`,
        sessionId: `agent-session-${index}`,
        transcriptRef: `${uri}.transcript.jsonl`,
        model: "gpt-5.5",
        reasoningEffort: "high",
        usage: { inputTokens: 20300, outputTokens: 1500, cachedInputTokens: 500 },
        launchInput: { prompt: instructions, metadata: { ownerInstructions: instructions } },
      }],
    })),
  };
  const before = JSON.stringify(canonical);
  const published: SwarmRun[] = [];
  await publishSwarmRunView(canonical, scopedInvocation(), async (request) => {
    if (request.target === UI_APPLICATION_LIST) return success({ instances: [{
      instanceId: "existing-panel", surface: UI_SURFACE_PANEL, revision: 1,
      content: { state: { run: { runId: RUN_ID } } },
    }] });
    const input = request.input as { state?: { run: SwarmRun } };
    if (input.state) {
      // Mirror the UI transport's per-string guard on both publication paths.
      const check = (value: unknown): void => {
        if (typeof value === "string" && value.length > 16384) throw new Error("UI string exceeds 16384 characters");
        if (value && typeof value === "object") Object.values(value).forEach(check);
      };
      check(input.state);
      expect(Buffer.byteLength(JSON.stringify(input.state))).toBeLessThan(128 * 1024);
      published.push(input.state.run);
    }
    return success({});
  });
  expect(published).toHaveLength(2);
  expect(JSON.stringify(canonical)).toBe(before);
  for (const run of published) {
    expect(run.objective).toBe("Build the requested product");
    expect(run.tasks).toHaveLength(8);
    expect(run.tasks[1]).toMatchObject({
      taskId: "task-1", parentTaskId: "task-0", dependencyTaskIds: ["task-0"],
      objective: "Implement component 1",
      artifactRefs: [{ uri }],
      executions: [{ sessionId: "agent-session-1", transcriptRef: `${uri}.transcript.jsonl`, model: "gpt-5.5", reasoningEffort: "high", usage: { inputTokens: 20300, outputTokens: 1500, cachedInputTokens: 500 } }],
    });
    expect(run.tasks.every((task) => task.executions.every((execution) => !("launchInput" in execution)))).toBe(true);
    expect(run.tasks[1]!.reason!.length).toBeLessThanOrEqual(1024);
    expect(run.tasks[1]!.artifactRefs[0]!.summary.length).toBeLessThanOrEqual(1024);
    expect(run.tasks[1]!.executions[0]).not.toBe(canonical.tasks[1]!.executions[0]);
  }
});

it("bounds single-line objectives and diagnostic keys while leaving navigation identities exact", () => {
  const id = "node-".repeat(100);
  const uri = `file:///${"directory/".repeat(100)}result.md`;
  const run = projectSwarmRunView({ ...RUN, objective: "a".repeat(50000), error: { ["key".repeat(10000)]: "error" }, tasks: [{
    ...RUN.tasks[0]!, taskId: id, parentTaskId: id, ownerSessionId: id,
    artifactRefs: [{ kind: "report", uri, summary: "details" }],
    executions: [{ executionId: id, sessionId: id, transcriptRef: uri }],
  }] });
  expect(run.objective).toHaveLength(160);
  expect(String(run.error).length).toBeLessThanOrEqual(1024);
  expect(run.tasks[0]!.taskId).toBe(id);
  expect(run.tasks[0]!.parentTaskId).toBe(id);
  expect(run.tasks[0]!.executions[0]!.sessionId).toBe(id);
  expect(run.tasks[0]!.artifactRefs[0]!.uri).toBe(uri);
});
