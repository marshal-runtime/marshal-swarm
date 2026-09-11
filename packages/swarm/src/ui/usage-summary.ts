import type { SwarmExecutionRecord } from "../contracts.js";

export interface UsageMeasurement {
  readonly recorded: number;
  readonly complete: boolean;
}
export interface UsageTotals {
  readonly executions: number;
  readonly inputTokens: UsageMeasurement;
  readonly outputTokens: UsageMeasurement;
  readonly cachedInputTokens: UsageMeasurement;
  readonly reportedCost: UsageMeasurement;
}
export interface UsageSummary extends UsageTotals {
  readonly byModel: readonly (UsageTotals & { readonly model: string })[];
}

/** A repeated execution receipt replaces its previous measurements; it is not another turn. */
type MeasuredExecution = SwarmExecutionRecord & {
  readonly kind?: "dispatch" | "turn";
  readonly usageByModel?: readonly {
    readonly model?: string;
    readonly usage: NonNullable<SwarmExecutionRecord["usage"]>;
  }[];
};
export function summarizeUsage(executions: readonly MeasuredExecution[]): UsageSummary {
  const unique = [
    ...new Map(executions.map((execution) => [execution.executionId, execution])).values(),
  ].filter((execution) => execution.kind !== "dispatch");
  const models = new Map<string, SwarmExecutionRecord[]>();
  for (const execution of unique) {
    const rows = execution.usageByModel?.length
      ? execution.usageByModel
      : [{ model: execution.model, usage: execution.usage }];
    for (const row of rows) {
      const model = row.model ?? "Model not recorded";
      models.set(model, [...(models.get(model) ?? []), { ...execution, model, usage: row.usage }]);
    }
  }
  return {
    ...totals(unique),
    byModel: [...models].map(([model, rows]) => ({ model, ...totals(rows) })),
  };
}
function totals(executions: readonly SwarmExecutionRecord[]): UsageTotals {
  const measurement = (
    field: keyof NonNullable<SwarmExecutionRecord["usage"]>,
  ): UsageMeasurement => {
    const values = executions.map((execution) => execution.usage?.[field]);
    const known = values.filter(
      (value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0,
    );
    return {
      recorded: known.reduce((sum, value) => sum + value, 0),
      complete: values.length > 0 && known.length === values.length,
    };
  };
  return {
    executions: executions.length,
    inputTokens: measurement("inputTokens"),
    outputTokens: measurement("outputTokens"),
    cachedInputTokens: measurement("cachedInputTokens"),
    reportedCost: measurement("reportedCost"),
  };
}
