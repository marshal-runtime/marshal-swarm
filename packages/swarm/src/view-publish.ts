import { randomUUID } from "node:crypto";

import type { InvocationContext, RuntimeExecResponse } from "@marshal/runtime";
import type { RuntimeOperationExecuteRequest } from "@marshal/runtime/core";

import type { SwarmRun } from "./contracts.js";
import { SWARM_EXTENSION_IDENTITY, SWARM_RUN_APPLICATION_ID } from "./presentation.js";
import { projectSwarmRunView } from "./view-projection.js";

export const UI_APPLICATION_OPEN = "ui.application.open";
export const UI_APPLICATION_UPDATE = "ui.application.update";
export const UI_APPLICATION_LIST = "ui.application.list";
export const UI_SURFACE_PANEL = "panel";
export const UI_SURFACE_INLINE_CARD = "inline-card";
const UI_PROTOCOL_VERSION = "1.0.0";
const WORKSPACE_METADATA_KEY = "marshalWorkspaceName";

export type SwarmViewExecute = (
  request: RuntimeOperationExecuteRequest,
  context: InvocationContext,
) => Promise<RuntimeExecResponse>;

export interface SwarmViewSurfaces {
  readonly panel: typeof UI_SURFACE_PANEL;
  readonly card: typeof UI_SURFACE_INLINE_CARD;
}

const pendingPublishes = new Map<string, Promise<void>>();

/** Opens or refreshes the swarm card and panel through Runtime UI. */
export async function publishSwarmRunView(
  run: SwarmRun,
  invocation: InvocationContext,
  execute: SwarmViewExecute,
  options?: { readonly focus?: boolean; readonly openIfMissing?: boolean },
): Promise<void> {
  if (!viewScope(invocation)) return;
  const key = JSON.stringify([invocation.scope?.sessionId, invocation.metadata?.[WORKSPACE_METADATA_KEY], run.runId]);
  const previous = pendingPublishes.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(async () => {
    const state = { run: projectSwarmRunView(run) };
    const surfaces = [UI_SURFACE_PANEL, UI_SURFACE_INLINE_CARD] as const;
    await Promise.all(surfaces.map(surface => upsertSurface(
      run.runId,
      surface,
      state,
      invocation,
      execute,
      options?.focus === true,
      options?.openIfMissing !== false,
    )));
  });
  pendingPublishes.set(key, next);
  try { await next; } finally { if (pendingPublishes.get(key) === next) pendingPublishes.delete(key); }
}

function viewScope(invocation: InvocationContext): boolean {
  const sessionId = invocation.scope?.sessionId?.trim();
  const workspaceName = invocation.metadata?.[WORKSPACE_METADATA_KEY];
  return Boolean(sessionId && typeof workspaceName === "string" && workspaceName.trim());
}

async function upsertSurface(
  runId: string,
  surface: typeof UI_SURFACE_PANEL | typeof UI_SURFACE_INLINE_CARD,
  state: { readonly run: SwarmRun },
  invocation: InvocationContext,
  execute: SwarmViewExecute,
  focus: boolean,
  openIfMissing: boolean,
): Promise<void> {
  const listed = await uiCall(execute, invocation, UI_APPLICATION_LIST, {
    extensionId: SWARM_EXTENSION_IDENTITY,
    applicationId: SWARM_RUN_APPLICATION_ID,
    surface,
  });
  const instanceId = instanceIdFrom(listed, surface, runId);
  if (instanceId) {
    await uiCall(execute, invocation, UI_APPLICATION_UPDATE, {
      extensionId: SWARM_EXTENSION_IDENTITY,
      applicationId: SWARM_RUN_APPLICATION_ID,
      instanceId,
      state,
      idempotencyKey: `swarm-view-update:${runId}:${surface}:${revisionOf(listed, instanceId)}`,
    });
    if (focus)
      await uiCall(execute, invocation, "ui.application.focus", {
        extensionId: SWARM_EXTENSION_IDENTITY,
        applicationId: SWARM_RUN_APPLICATION_ID,
        instanceId,
        idempotencyKey: `swarm-view-focus:${runId}:${surface}:${randomUUID()}`,
      });
    return;
  }
  if (!openIfMissing) return;
  await uiCall(execute, invocation, UI_APPLICATION_OPEN, {
    extensionId: SWARM_EXTENSION_IDENTITY,
    applicationId: SWARM_RUN_APPLICATION_ID,
    surface,
    state,
    idempotencyKey: `swarm-view:${runId}:${surface}:${randomUUID()}`,
  });
}

async function uiCall(
  execute: SwarmViewExecute,
  invocation: InvocationContext,
  target: string,
  input: unknown,
): Promise<unknown> {
  const response = await execute(
    {
      protocolVersion: UI_PROTOCOL_VERSION,
      targetType: "operation",
      target,
      input,
      approval: invocation.approval,
    },
    invocation,
  );
  const output = response.result?.output;
  if (output && typeof output === "object" && "ok" in output && output.ok === false) {
    const error = "error" in output ? output.error : undefined;
    throw new Error(error && typeof error === "object" && "message" in error ? String(error.message) : "Runtime UI publication failed.");
  }
  return output;
}

function instanceIdFrom(output: unknown, surface: string, runId: string): string | undefined {
  const instances = instancesOf(output);
  const match = instances.find(
    (instance) => instance.surface === surface && instance.runId === runId,
  );
  return match?.instanceId;
}

function revisionOf(output: unknown, instanceId: string): number | string {
  const match = instancesOf(output).find((instance) => instance.instanceId === instanceId);
  return match?.revision ?? 0;
}

function instancesOf(output: unknown): readonly {
  readonly instanceId: string;
  readonly surface?: string;
  readonly revision?: number;
  readonly runId?: string;
}[] {
  if (!output || typeof output !== "object" || Array.isArray(output)) return [];
  const value = (output as { value?: unknown }).value;
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : output;
  const instances = (source as { instances?: unknown }).instances;
  if (!Array.isArray(instances)) return [];
  return instances.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const instanceId = (item as { instanceId?: unknown }).instanceId;
    if (typeof instanceId !== "string" || !instanceId.trim()) return [];
    const surface = (item as { surface?: unknown }).surface;
    const revision = (item as { revision?: unknown }).revision;
    const content = (item as { content?: { state?: { run?: { runId?: unknown } } } }).content;
    const runId = content?.state?.run?.runId;
    return [
      {
        instanceId,
        ...(typeof runId === "string" ? { runId } : {}),
        ...(typeof surface === "string" ? { surface } : {}),
        ...(typeof revision === "number" ? { revision } : {}),
      },
    ];
  });
}
