import path, { join } from 'node:path';
import type {
  RuntimeExtensionActivation,
  RuntimeExtensionActivationContext,
  RuntimeExtensionModule,
  RuntimeExtensionUiApplication,
} from '@marshal/runtime/extensions';
import { FileSwarmRunEventStore } from './file-store.js';
import { SwarmExecutor } from './executor.js';
import { SwarmServiceContainer } from './service-container.js';
import { SwarmServiceSymbols } from './service-symbols.js';
import { createSwarmProvider, SWARM_RUNS_CREATE, SWARM_RUNS_DRIVE, SWARM_RUNS_RESUME, type SwarmProvider } from './provider.js';
import { projectSwarmRunPresentation, SWARM_RUN_VIEW_RENDER_ID, SWARM_RUN_VIEW_RESOURCE_URI } from './presentation.js';

const extension: RuntimeExtensionModule = {
  activate(context: RuntimeExtensionActivationContext): RuntimeExtensionActivation {
    const configured = context.configuration.runsDirectory;
    if (typeof configured !== 'string' || !configured.trim()) {
      throw new Error('Swarm activation requires configuration.runsDirectory.');
    }
    const runsDirectory = configured.trim();
    if (!pathIsSafe(runsDirectory)) {
      throw new Error('Swarm runsDirectory must be an absolute path.');
    }
    const services = new SwarmServiceContainer();
    const shared = context.services.tryGet(SwarmServiceSymbols.sharedContext);
    if (shared) services.bind(SwarmServiceSymbols.sharedContext, shared);
    const models = context.services.tryGet(SwarmServiceSymbols.roleModel);
    if (models) services.bind(SwarmServiceSymbols.roleModel, models);
    const baseline = context.services.tryGet(SwarmServiceSymbols.baseline);
    if (baseline) services.bind(SwarmServiceSymbols.baseline, baseline);
    const executor = new SwarmExecutor({
      execute: (request, invocation) => context.execute(request, invocation),
    }, { eventStore: new FileSwarmRunEventStore(join(runsDirectory, 'runs')), serviceContainer: services });
    const provider = managedProvider(createSwarmProvider(executor), executor);
    const ui: RuntimeExtensionUiApplication = {
      id: 'swarm-run',
      title: 'Swarm run',
      description: 'Inspect recursive Swarm run state and controls.',
      renderId: SWARM_RUN_VIEW_RENDER_ID,
      resource: { uri: SWARM_RUN_VIEW_RESOURCE_URI, mimeType: 'text/html', text: '<main data-marshal-swarm-run></main>' },
      application: projectSwarmRunPresentation({ runId: 'preview', objective: 'Swarm run', scope: 'runtime', state: 'done', tasks: [] }).application,
      tags: ['swarm'],
    };
    return { capabilityProviders: [provider], uiApplications: [ui], dispose: () => provider.dispose() };
  },
};

function managedProvider(provider: SwarmProvider, executor: SwarmExecutor): SwarmProvider & { dispose(): Promise<void> } {
  const drives = new Map<string, Promise<unknown>>();
  const invocations = new Map<string, Parameters<SwarmExecutor['drive']>[1]>();
  let disposed = false;
  const start = (runId: string, invocation: Parameters<SwarmExecutor['drive']>[1]) => {
    const existing = drives.get(runId);
    if (existing) return existing;
    const drive = executor.drive({ runId }, invocation).finally(() => drives.delete(runId));
    drives.set(runId, drive);
    invocations.set(runId, invocation);
    return drive;
  };
  return {
    ...provider,
    async invoke(name, input, invocation) {
      if (disposed) throw new Error('Swarm extension has been disposed.');
      if (name === SWARM_RUNS_CREATE) {
        const result = await provider.invoke(name, input, invocation);
        void start(runId(input), invocation).catch(() => undefined);
        return result;
      }
      if (name === SWARM_RUNS_RESUME || name === SWARM_RUNS_DRIVE) {
        const id = runId(input);
        if (name === SWARM_RUNS_RESUME) await provider.invoke(name, input, invocation);
        return { output: { run: await start(id, invocation) } };
      }
      return provider.invoke(name, input, invocation);
    },
    async dispose() {
      disposed = true;
      await Promise.allSettled([...drives].map(async ([id]) => {
        const invocation = invocations.get(id);
        if (invocation) {
          await provider.invoke('swarm.runs.cancel', {
            runId: id,
            reason: 'Swarm extension disposed; cancelling owned work.',
          }, invocation);
        }
      }));
      await Promise.allSettled([...drives.values()]);
      drives.clear();
      invocations.clear();
    },
  };
}

function pathIsSafe(value: string): boolean {
  return value.length <= 4_096 && value.trim() === value && path.isAbsolute(value);
}

function runId(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof (value as { runId?: unknown }).runId !== 'string' || !(value as { runId: string }).runId.trim()) {
    throw new TypeError('runId must be a non-empty string.');
  }
  return (value as { runId: string }).runId.trim();
}

export const activate: typeof extension.activate = (context) => extension.activate(context);
export default extension;
