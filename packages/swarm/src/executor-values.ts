import type { InvocationContext } from "@marshal/runtime";
import type { SwarmPauseReason, SwarmTaskRole } from "./contracts.js";
export const RUNTIME_PROTOCOL_VERSION = "1.0.0";
export const REVIEWER_CONTRACT_MESSAGE =
  'Reviewer results must be structured as {"reviewed":true,"findings":[...]}. ' +
  "Narration without that structure is a failed review.";
export const REVIEW_RECURRENCE_MESSAGE =
  "Refused: this integrated change ref was already reviewed and no worker or " +
  "reconciler change ref has advanced since the previous review.";
export const DESCENDANT_INTEGRATION_REJECTION =
  "All descendant tasks must be terminal before integration.";
export const ROOT_COMPLETION_RECONCILIATION_REJECTION =
  "Root completion requires reconciliation after the latest implementation.";
export const DEFAULT_WORKER_MODEL = "gpt-5.6-luna";
export const DEFAULT_WORKER_REASONING_EFFORT = "medium";
export function optionalTrimmed(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : requiredString(value, label);
}
export function recordOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}
export function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value.trim();
}
export function callerSessionId(invocation: InvocationContext): string {
  const sessionId = optionalCallerSessionId(invocation);
  if (!sessionId) throw new TypeError("Swarm create requires a session scope.");
  return sessionId;
}
export function optionalCallerSessionId(invocation: InvocationContext): string | undefined {
  const sessionId = invocation.scope?.sessionId?.trim();
  return sessionId || undefined;
}
export function callerWorkspace(invocation: InvocationContext): string | undefined {
  const metadata = invocation.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const name = (
    metadata as {
      marshalWorkspaceName?: unknown;
    }
  ).marshalWorkspaceName;
  return typeof name === "string" && name.trim() ? name.trim() : undefined;
}
export function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, label);
}
export function requiredRole(value: unknown, label: string): SwarmTaskRole {
  switch (value) {
    case "planner":
    case "worker":
    case "reconciler":
    case "reviewer":
      return value;
    default:
      throw new TypeError(`${label} must be planner, worker, reconciler, or reviewer.`);
  }
}
export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
export function optionalChangeRefs(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new TypeError("Delegation changeRefs must be an array.");
  }
  return value.map((entry, index) => requiredString(entry, `Delegation changeRefs[${index}]`));
}
export function plainError(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  return String(value);
}
export function errorText(value: unknown, fallback: string): string {
  if (value === undefined || value === null) return fallback;
  const error = recordOf(value);
  return plainError(error?.message ?? error?.code ?? value);
}
export function completionRejectedForLiveDescendant(value: unknown): boolean {
  const error = errorText(value, "");
  return (
    error === DESCENDANT_INTEGRATION_REJECTION || error === ROOT_COMPLETION_RECONCILIATION_REJECTION
  );
}
export function environmentalWorktreePauseReason(
  value: unknown,
  taskId: string,
): SwarmPauseReason | undefined {
  const error = recordOf(value);
  if (
    error?.kind !== "environmental" ||
    error.operation !== "worktree.create" ||
    error.attempts !== 3
  ) {
    return undefined;
  }
  const code = stringValue(error.code);
  const category = stringValue(error.category);
  return {
    kind: "environmental",
    operation: "worktree.create",
    taskId,
    attempts: 3,
    message: requiredString(error.message, "Environmental error message"),
    ...(code === undefined ? {} : { code }),
    ...(category === undefined ? {} : { category }),
  };
}
export function pauseReasonForError(value: unknown, taskId: string): SwarmPauseReason | undefined {
  return diskFullPauseReason(value, taskId) ?? environmentalWorktreePauseReason(value, taskId);
}
export function diskFullPauseReason(value: unknown, taskId: string): SwarmPauseReason | undefined {
  if (!isDiskFullError(value)) return undefined;
  const error = recordOf(value);
  const message = errorText(
    error?.message ?? value,
    `Disk full while provisioning task "${taskId}".`,
  );
  const code = error?.code ?? error?.errno;
  return {
    kind: "environmental",
    operation: "worktree.create",
    taskId,
    attempts: 3,
    message,
    ...(code === undefined ? {} : { code: typeof code === "string" ? code : String(code) }),
    category: "disk-full",
  } as SwarmPauseReason;
}
export function isDiskFullError(
  value: unknown,
  seen = new WeakSet<object>(),
  contextual = false,
): boolean {
  if (typeof value === "string") {
    if (
      /^-?(28|39)$|enospc|no space left on device|not enough space on (?:the )?disk|not enough disk space|disk(?:\s+is)?\s+full|error_handle_disk_full|error[_ -]?disk[_ -]?full/i.test(
        value,
      )
    )
      return true;
    return contextual && /^(?:error\s*)?112$/i.test(value.trim());
  }
  if (typeof value === "number") {
    return value === 28 || value === -28 || value === 39 || (value === 112 && contextual);
  }
  if (value === null || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (value instanceof Error && isDiskFullError(value.message, seen, contextual)) {
    return true;
  }
  const record = recordOf(value);
  if (!record) return false;
  const context =
    contextual ||
    Object.entries(record).some(
      ([key, entry]) =>
        (key === "platform" ||
          key === "os" ||
          key === "system" ||
          key === "operatingSystem" ||
          key === "category" ||
          key === "operation") &&
        typeof entry === "string" &&
        /windows|win32|disk[- ]?full/i.test(entry),
    );
  for (const [key, entry] of Object.entries(record)) {
    if (
      key === "message" ||
      key === "code" ||
      key === "errno" ||
      key === "error" ||
      key === "cause" ||
      key === "details" ||
      key === "innerError" ||
      key === "originalError"
    ) {
      if (isDiskFullError(entry, seen, context)) return true;
    }
  }
  return false;
}
