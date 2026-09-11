import { describe, expect, it } from "vitest";

import { summarizeUsage } from "../src/ui/usage-summary.js";

describe("execution usage summaries", () => {
  it("replaces duplicate execution receipts and sums by model without adding cache to input", () => {
    const summary = summarizeUsage([
      {
        executionId: "one",
        model: "model-a",
        usage: { inputTokens: 5, outputTokens: 2, cachedInputTokens: 3, reportedCost: 0.1 },
      },
      {
        executionId: "one",
        model: "model-a",
        usage: { inputTokens: 10, outputTokens: 4, cachedInputTokens: 6, reportedCost: 0.2 },
      },
      {
        executionId: "two",
        model: "model-b",
        usage: { inputTokens: 20, outputTokens: 8, cachedInputTokens: 5, reportedCost: 0.3 },
      },
    ]);
    expect(summary.executions).toBe(2);
    expect(summary.inputTokens).toEqual({ recorded: 30, complete: true });
    expect(summary.cachedInputTokens).toEqual({ recorded: 11, complete: true });
    expect(summary.reportedCost).toEqual({ recorded: 0.5, complete: true });
    expect(summary.byModel.map((row) => [row.model, row.inputTokens.recorded])).toEqual([
      ["model-a", 10],
      ["model-b", 20],
    ]);
  });
  it("excludes dispatch reservations and uses measured model rows without adding them twice", () => {
    const summary = summarizeUsage([
      { executionId: "reserved", kind: "dispatch" },
      {
        executionId: "turn",
        kind: "turn",
        model: "requested-model",
        usage: { inputTokens: 15, outputTokens: 6, cachedInputTokens: 4, reportedCost: 0.3 },
        usageByModel: [
          {
            model: "actual-a",
            usage: { inputTokens: 10, outputTokens: 4, cachedInputTokens: 3, reportedCost: 0.2 },
          },
          {
            model: "actual-b",
            usage: { inputTokens: 5, outputTokens: 2, cachedInputTokens: 1, reportedCost: 0.1 },
          },
        ],
      },
    ]);
    expect(summary.executions).toBe(1);
    expect(summary.inputTokens.recorded).toBe(15);
    expect(summary.reportedCost.complete).toBe(true);
    expect(summary.byModel.map((row) => row.model)).toEqual(["actual-a", "actual-b"]);
  });
  it("keeps incomplete totals unknown and does not infer cost from a model name", () => {
    const summary = summarizeUsage([
      {
        executionId: "one",
        model: "model-a",
        usage: { inputTokens: 10, outputTokens: 0, reportedCost: 0 },
      },
      { executionId: "two", usage: { outputTokens: 4 } },
    ]);
    expect(summary.inputTokens).toEqual({ recorded: 10, complete: false });
    expect(summary.outputTokens).toEqual({ recorded: 4, complete: true });
    expect(summary.cachedInputTokens).toEqual({ recorded: 0, complete: false });
    expect(summary.reportedCost).toEqual({ recorded: 0, complete: false });
    expect(summary.byModel[1]?.model).toBe("Model not recorded");
  });
});
