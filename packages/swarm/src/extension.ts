import path from "node:path";
import type {
  RuntimeExtensionActivation,
  RuntimeExtensionActivationContext,
  RuntimeExtensionModule,
  RuntimeExtensionUiApplication,
} from "@marshal/runtime/extensions";
import { FileSwarmRunEventStore } from "./file-store.js";
import { SwarmExecutor } from "./executor.js";
import { SwarmServiceContainer } from "./service-container.js";
import { SwarmServiceSymbols } from "./service-symbols.js";
import {
  createSwarmProvider,
  SWARM_RUNS_CREATE,
  SWARM_RUNS_DRIVE,
  SWARM_RUNS_RESUME,
  type SwarmProvider,
} from "./provider.js";
import {
  swarmRunApplication,
  swarmSlashApplication,
  SWARM_RUN_APPLICATION_ID,
  SWARM_RUN_NAVIGATION_PLACEMENT_ID,
  SWARM_RUN_VIEW_RENDER_ID,
  SWARM_RUN_VIEW_RESOURCE_URI,
  SWARM_SLASH_COMMAND_APPLICATION_ID,
  SWARM_SLASH_COMMAND_PLACEMENT_ID,
  SWARM_SLASH_COMMAND_RESOURCE_URI,
} from "./presentation.js";

const extension: RuntimeExtensionModule = {
  activate(
    context: RuntimeExtensionActivationContext,
  ): RuntimeExtensionActivation {
    const configured = context.configuration.runsDirectory;
    if (typeof configured !== "string" || !configured.trim()) {
      throw new Error("Swarm activation requires configuration.runsDirectory.");
    }
    const runsDirectory = configured.trim();
    if (!pathIsSafe(runsDirectory)) {
      throw new Error("Swarm runsDirectory must be an absolute path.");
    }
    const services = new SwarmServiceContainer();
    const transcriptReader = context.services.tryGet(SwarmServiceSymbols.transcriptReader);
    if (transcriptReader) services.bind(SwarmServiceSymbols.transcriptReader, transcriptReader);
    const shared = context.services.tryGet(SwarmServiceSymbols.sharedContext);
    if (shared) services.bind(SwarmServiceSymbols.sharedContext, shared);
    const models = context.services.tryGet(SwarmServiceSymbols.roleModel);
    if (models) services.bind(SwarmServiceSymbols.roleModel, models);
    const baseline = context.services.tryGet(SwarmServiceSymbols.baseline);
    if (baseline) services.bind(SwarmServiceSymbols.baseline, baseline);
    const eventStore =
      context.services.tryGet(SwarmServiceSymbols.eventStore) ??
      new FileSwarmRunEventStore(runsDirectory);
    const executor = new SwarmExecutor(
      {
        execute: (request, invocation) => context.execute(request, invocation),
      },
      { eventStore, serviceContainer: services },
    );
    const provider = managedProvider(createSwarmProvider(executor), executor);
    const ui: RuntimeExtensionUiApplication = {
      id: SWARM_RUN_APPLICATION_ID,
      title: "Swarm",
      description: "Inspect recursive Swarm run state and controls.",
      renderId: SWARM_RUN_VIEW_RENDER_ID,
      resource: {
        uri: SWARM_RUN_VIEW_RESOURCE_URI,
        mimeType: "text/html",
        text: "<main data-marshal-swarm-run></main>",
      },
      application: swarmRunApplication(),
      metadata: { "marshal.ui.viewports": ["mobile", "desktop"] },
      tags: ["swarm"],
    };
    const slash: RuntimeExtensionUiApplication = {
      id: SWARM_SLASH_COMMAND_APPLICATION_ID,
      title: "Swarm",
      description:
        "Turn this session into the swarm root planner, keeping the conversation so far. Use --fresh to start empty.",
      renderId: SWARM_RUN_VIEW_RENDER_ID,
      resource: {
        uri: SWARM_SLASH_COMMAND_RESOURCE_URI,
        mimeType: "text/plain",
        text: "Start a swarm from the current conversation.",
      },
      application: swarmSlashApplication(),
      metadata: { "marshal.ui.viewports": ["mobile", "desktop"] },
      tags: ["swarm", "slash-command"],
    };
    return {
      capabilityProviders: [provider],
      uiApplications: [ui, slash],
      uiPlacements: [
        {
          placementId: SWARM_RUN_NAVIGATION_PLACEMENT_ID,
          applicationId: SWARM_RUN_APPLICATION_ID,
          action: "augment",
        },
        {
          placementId: SWARM_SLASH_COMMAND_PLACEMENT_ID,
          action: "augment",
          applicationId: SWARM_SLASH_COMMAND_APPLICATION_ID,
        },
      ],
      dispose: () => provider.dispose(),
    };
  },
};

function managedProvider(
  provider: SwarmProvider,
  executor: SwarmExecutor,
): SwarmProvider & { dispose(): Promise<void> } {
  const drives = new Map<string, Promise<unknown>>();
  const invocations = new Map<string, Parameters<SwarmExecutor["drive"]>[1]>();
  let disposed = false;
  const start = (
    runId: string,
    invocation: Parameters<SwarmExecutor["drive"]>[1],
  ) => {
    const existing = drives.get(runId);
    if (existing) return existing;
    const backgroundInvocation = { ...invocation, signal: undefined };
    const drive = executor
      .drive({ runId }, backgroundInvocation)
      .finally(() => drives.delete(runId));
    drives.set(runId, drive);
    invocations.set(runId, backgroundInvocation);
    return drive;
  };
  return {
    ...provider,
    async invoke(name, input, invocation) {
      if (disposed) throw new Error("Swarm extension has been disposed.");
      if (name === SWARM_RUNS_CREATE) {
        const result = await provider.invoke(name, input, invocation);
        const created = runFrom(result.output);
        void start(created, invocation).catch(() => undefined);
        return result;
      }
      if (name === SWARM_RUNS_RESUME || name === SWARM_RUNS_DRIVE) {
        const id = runId(input);
        await executor.getRootAuthorized({ runId: id }, invocation);
        if (name === SWARM_RUNS_RESUME)
          await provider.invoke(name, input, {
            ...invocation,
            signal: undefined,
          });
        return { output: { run: await start(id, invocation) } };
      }
      return provider.invoke(name, input, invocation);
    },
    async dispose() {
      disposed = true;
      await Promise.allSettled(
        [...drives].map(async ([id]) => {
          const invocation = invocations.get(id);
          if (invocation) {
            await provider.invoke(
              "swarm.runs.cancel",
              {
                runId: id,
                reason: "Swarm extension disposed; cancelling owned work.",
              },
              invocation,
            );
          }
        }),
      );
      await Promise.allSettled([...drives.values()]);
      drives.clear();
      invocations.clear();
    },
  };
}

function pathIsSafe(value: string): boolean {
  return (
    value.length <= 4_096 && value.trim() === value && path.isAbsolute(value)
  );
}

function runFrom(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Swarm create did not return a run.");
  }
  return runId((value as { run?: unknown }).run);
}

function runId(value: unknown): string {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof (value as { runId?: unknown }).runId !== "string" ||
    !(value as { runId: string }).runId.trim()
  ) {
    throw new TypeError("runId must be a non-empty string.");
  }
  return (value as { runId: string }).runId.trim();
}

export const activate: typeof extension.activate = (context) =>
  extension.activate(context);
export default extension;
