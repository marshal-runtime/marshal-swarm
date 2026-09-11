import type { SwarmJsonValue, SwarmRun } from "./contracts.js";

const PURPOSE_LIMIT = 160;
const TEXT_LIMIT = 1024;

function boundedText(text: string, limit = TEXT_LIMIT): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function purpose(text: string): string {
  const line = text.slice(0, 512).trim().split(/[\r\n]/, 1)[0] ?? "";
  return boundedText(line.replace(/^\s*[#>*\-]+\s*/, "").replace(/\s+/g, " ").trim(), PURPOSE_LIMIT);
}

/** Diagnostics are previews, not a second copy of arbitrary result payloads. */
function diagnostic(value: SwarmJsonValue | undefined): SwarmJsonValue | undefined {
  if (value === undefined || value === null || typeof value !== "object") {
    return typeof value === "string" ? boundedText(value) : value;
  }
  let budget = TEXT_LIMIT;
  const preview = (item: SwarmJsonValue, depth: number): SwarmJsonValue => {
    if (budget <= 0 || depth > 4) return "…";
    budget -= 8;
    if (typeof item === "string") {
      const text = boundedText(item, Math.max(1, Math.min(256, budget)));
      budget -= text.length;
      return text;
    }
    if (item === null || typeof item !== "object") return item;
    if (Array.isArray(item)) {
      const result: SwarmJsonValue[] = [];
      for (const child of item) {
        if (budget <= 0 || result.length >= 12) { result.push("…"); break; }
        result.push(preview(child, depth + 1));
      }
      return result;
    }
    const result: Record<string, SwarmJsonValue> = Object.create(null);
    let count = 0;
    for (const key in item) {
      if (!Object.prototype.hasOwnProperty.call(item, key)) continue;
      if (budget <= 0 || count++ >= 12) { result["…"] = "Preview truncated"; break; }
      const label = boundedText(key, 80);
      budget -= label.length;
      result[label] = preview((item as Readonly<Record<string, SwarmJsonValue>>)[key]!, depth + 1);
    }
    return result;
  };
  return boundedText(JSON.stringify(preview(value, 0)));
}

/**
 * A transport projection only. Never persist this over the canonical run: dispatch
 * launch inputs belong in durable execution history, not UI application state.
 * Identifiers and navigation references retain their exact values.
 */
export function projectSwarmRunView(run: SwarmRun): SwarmRun {
  const projected: SwarmRun = {
    ...run,
    objective: purpose(run.objective),
    ...(run.pauseReason && { pauseReason: { ...run.pauseReason, message: boundedText(run.pauseReason.message) } }),
    ...(run.result !== undefined && { result: diagnostic(run.result) }),
    ...(run.error !== undefined && { error: diagnostic(run.error) }),
    tasks: run.tasks.map((task) => ({
      ...task,
      objective: purpose(task.objective),
      ...(task.reason !== undefined && { reason: boundedText(task.reason) }),
      ...(task.resumeReason !== undefined && { resumeReason: boundedText(task.resumeReason) }),
      ...(task.result !== undefined && { result: diagnostic(task.result) }),
      ...(task.error !== undefined && { error: diagnostic(task.error) }),
      artifactRefs: (task.artifactRefs ?? []).map((artifact) => ({ ...artifact, summary: boundedText(artifact.summary) })),
      executions: (task.executions ?? []).map(({ launchInput: _launchInput, ...execution }) => execution),
    })),
  };
  // Detach retained arrays/usage records as well, without serializing launchInput.
  return JSON.parse(JSON.stringify(projected)) as SwarmRun;
}
