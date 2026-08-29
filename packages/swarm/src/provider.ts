import type {
  CapabilityDescriptor,
  CapabilityProvider,
  InvocationContext,
  RuntimeHostProviderSource,
} from '@marshal/runtime';
const RUNTIME_PROTOCOL_VERSION = '1.0.0';
import type { SwarmRunTarget } from './contracts.js';
import { SwarmExecutor } from './executor.js';
import type {
  SwarmRunCancelInput,
  SwarmRunCreateInput,
  SwarmRunInput,
  SwarmRunPauseInput,
  SwarmSourceOptions,
} from './types.js';
import type { SwarmExecutionContext } from './types.js';

export const SWARM_RUNS_CREATE = 'swarm.runs.create';
export const SWARM_RUNS_GET = 'swarm.runs.get';
export const SWARM_RUNS_LIST = 'swarm.runs.list';
export const SWARM_RUNS_CANCEL = 'swarm.runs.cancel';
export const SWARM_RUNS_PAUSE = 'swarm.runs.pause';
export const SWARM_RUNS_RESUME = 'swarm.runs.resume';
export const SWARM_RUNS_DRIVE = 'swarm.runs.drive';

export type SwarmProvider = CapabilityProvider & {
  readonly executor: SwarmExecutor;
};

export type SwarmSource = RuntimeHostProviderSource & {
  getExecutor(): SwarmExecutor | undefined;
};

export function createSwarmSource(options: SwarmSourceOptions): SwarmSource {
  let executor: SwarmExecutor | undefined;
  const source: RuntimeHostProviderSource = (context) => {
    const execution: SwarmExecutionContext = {
      execute: (request, invocation) => context.operationInvoker.execute(request, invocation),
    };
    executor ??= new SwarmExecutor(execution, options);
    return createSwarmProvider(executor, options.providerId);
  };
  return Object.assign(source, {
    getExecutor: () => executor,
  });
}

export function createSwarmProvider(
  executor: SwarmExecutor,
  providerId = 'marshal.swarm',
): SwarmProvider {
  return {
    id: providerId,
    version: '0.1.0',
    executor,
    list: () => DESCRIPTORS,
    get: (name) => DESCRIPTORS.find((descriptor) => descriptor.name === name),
    async invoke(
      name: string,
      rawInput: unknown,
      invocation: InvocationContext,
    ) {
      const input = requiredRecord(rawInput);
      switch (name) {
        case SWARM_RUNS_CREATE:
          return {
            output: {
              run: await executor.create(parseCreateInput(input), invocation),
            },
          };
        case SWARM_RUNS_GET:
          return { output: { run: await executor.get(parseRunInput(input)) } };
        case SWARM_RUNS_LIST:
          return { output: { runs: await executor.list() } };
        case SWARM_RUNS_CANCEL:
          return {
            output: {
              run: await executor.cancel(parseCancelInput(input), invocation),
            },
          };
        case SWARM_RUNS_PAUSE:
          return {
            output: {
              run: await executor.pause(parsePauseInput(input), invocation),
            },
          };
        case SWARM_RUNS_RESUME:
          return {
            output: {
              run: await executor.resume(parseRunInput(input), invocation),
            },
          };
        case SWARM_RUNS_DRIVE:
          return {
            output: {
              run: await executor.drive(parseRunInput(input), invocation),
            },
          };
        default:
          throw new Error(`Unsupported swarm capability "${name}".`);
      }
    },
  };
}

const IDENTIFIER = {
  type: 'string',
  minLength: 1,
} as const;
const RUN_INPUT = objectSchema({ runId: IDENTIFIER }, ['runId']);
const RUN_OUTPUT = objectSchema({ run: { type: 'object' } }, ['run']);

const DESCRIPTORS: readonly CapabilityDescriptor[] = [
  descriptor(
    SWARM_RUNS_CREATE,
    'Create a recursive swarm run',
    objectSchema({
      runId: IDENTIFIER,
      objective: { type: 'string', minLength: 1 },
      scope: { type: 'string', minLength: 1 },
      targetRef: { type: 'string', minLength: 1 },
      targetHead: { type: 'string', minLength: 1 },
      targets: {
        type: 'array',
        minItems: 1,
        items: objectSchema({
          scope: { type: 'string', minLength: 1 },
          ref: { type: 'string', minLength: 1 },
          head: { type: 'string', minLength: 1 },
        }, ['scope', 'ref', 'head']),
      },
      workerModel: { type: 'string', minLength: 1 },
      workerReasoningEffort: { type: 'string', minLength: 1 },
    }, ['runId', 'objective', 'scope']),
    RUN_OUTPUT,
  ),
  descriptor(SWARM_RUNS_GET, 'Get a swarm run', RUN_INPUT, RUN_OUTPUT, true),
  descriptor(
    SWARM_RUNS_LIST,
    'List swarm runs',
    objectSchema({}, []),
    objectSchema({
      runs: { type: 'array', items: { type: 'object' } },
    }, ['runs']),
    true,
  ),
  descriptor(
    SWARM_RUNS_CANCEL,
    'Cancel a swarm run',
    objectSchema({
      runId: IDENTIFIER,
      reason: { type: 'string', minLength: 1 },
    }, ['runId', 'reason']),
    RUN_OUTPUT,
  ),
  descriptor(
    SWARM_RUNS_PAUSE,
    'Pause a swarm run',
    objectSchema({
      runId: IDENTIFIER,
      reason: { type: 'string', minLength: 1 },
    }, ['runId', 'reason']),
    RUN_OUTPUT,
  ),
  descriptor(
    SWARM_RUNS_RESUME,
    'Resume a swarm run',
    RUN_INPUT,
    RUN_OUTPUT,
  ),
  descriptor(
    SWARM_RUNS_DRIVE,
    'Drive a swarm run to completion',
    RUN_INPUT,
    RUN_OUTPUT,
  ),
];

function descriptor(
  name: string,
  description: string,
  inputSchema: Readonly<Record<string, unknown>>,
  outputSchema: Readonly<Record<string, unknown>>,
  readOnly = false,
): CapabilityDescriptor {
  return {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    name,
    version: '0.1.0',
    description,
    tags: ['swarm', 'recursive'],
    inputSchema,
    outputSchema,
    permissions: [{
      permission: readOnly ? 'swarm.read' : 'swarm.execute',
      risk: readOnly ? 'low' : 'high',
    }],
  };
}

function parseCreateInput(
  input: Readonly<Record<string, unknown>>,
): SwarmRunCreateInput {
  return {
    runId: requiredString(input.runId, 'runId'),
    objective: requiredString(input.objective, 'objective'),
    scope: requiredString(input.scope, 'scope'),
    ...(input.targetRef === undefined
      ? {}
      : { targetRef: requiredString(input.targetRef, 'targetRef') }),
    ...(input.targetHead === undefined
      ? {}
      : { targetHead: requiredString(input.targetHead, 'targetHead') }),
    ...(input.targets === undefined
      ? {}
      : { targets: parseTargets(input.targets) }),
    ...(input.workerModel === undefined
      ? {}
      : { workerModel: requiredString(input.workerModel, 'workerModel') }),
    ...(input.workerReasoningEffort === undefined
      ? {}
      : {
          workerReasoningEffort: requiredString(
            input.workerReasoningEffort,
            'workerReasoningEffort',
          ),
        }),
  };
}

function parseTargets(value: unknown): readonly SwarmRunTarget[] {
  if (!Array.isArray(value)) {
    throw new TypeError('targets must be an array.');
  }
  return value.map((entry, index): SwarmRunTarget => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new TypeError(`targets[${index}] must be an object.`);
    }
    const target = entry as Readonly<Record<string, unknown>>;
    return {
      scope: requiredString(target.scope, `targets[${index}].scope`),
      ref: requiredString(target.ref, `targets[${index}].ref`),
      head: requiredString(target.head, `targets[${index}].head`),
    };
  });
}

function parseRunInput(
  input: Readonly<Record<string, unknown>>,
): SwarmRunInput {
  return { runId: requiredString(input.runId, 'runId') };
}

function parsePauseInput(
  input: Readonly<Record<string, unknown>>,
): SwarmRunPauseInput {
  return {
    runId: requiredString(input.runId, 'runId'),
    reason: requiredString(input.reason, 'reason'),
  };
}

function parseCancelInput(
  input: Readonly<Record<string, unknown>>,
): SwarmRunCancelInput {
  return {
    runId: requiredString(input.runId, 'runId'),
    reason: requiredString(input.reason, 'reason'),
  };
}

function requiredRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Swarm input must be an object.');
  }
  return value as Readonly<Record<string, unknown>>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function objectSchema(
  properties: Readonly<Record<string, unknown>>,
  required: readonly string[],
): Readonly<Record<string, unknown>> {
  return {
    type: 'object',
    additionalProperties: false,
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}
