import type {
  CapabilityDescriptor,
  CapabilityProvider,
  InvocationContext,
  RuntimeHostProviderSource,
} from "@marshal/runtime";
const RUNTIME_PROTOCOL_VERSION = "1.0.0";
import {
  validateSwarmRoleDefinitions,
  validateSwarmRoleModels,
  type SwarmRunTarget,
} from "./contracts.js";
import { SwarmExecutor } from "./executor.js";
import type {
  SwarmRunCancelInput,
  SwarmRunCreateInput,
  SwarmRunInput,
  SwarmRunPauseInput,
  SwarmSourceOptions,
} from "./types.js";
import type { SwarmExecutionContext } from "./types.js";
export const SWARM_RUNS_CREATE = "swarm.runs.create";
export const SWARM_RUNS_GET = "swarm.runs.get";
export const SWARM_RUNS_LIST = "swarm.runs.list";
export const SWARM_RUNS_CANCEL = "swarm.runs.cancel";
export const SWARM_RUNS_PAUSE = "swarm.runs.pause";
export const SWARM_RUNS_RESUME = "swarm.runs.resume";
export const SWARM_RUNS_RECOVER_SYSTEM_FAILURE = "swarm.runs.recoverSystemFailure";
export const SWARM_RUNS_SET_ROLE_MODELS = "swarm.runs.setRoleModels";
export const SWARM_RUNS_SET_ROLES = "swarm.runs.setRoles";
export const SWARM_RUNS_DRIVE = "swarm.runs.drive";
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
  providerId = "marshal.swarm",
): SwarmProvider {
  return {
    id: providerId,
    version: "0.1.0",
    executor,
    list: () => DESCRIPTORS,
    get: (name) => DESCRIPTORS.find((descriptor) => descriptor.name === name),
    async invoke(name: string, rawInput: unknown, invocation: InvocationContext) {
      const input = requiredRecord(rawInput);
      if (name.startsWith("swarm.nodes."))
        return {
          output: {
            node: await executor.nodeOperation(
              name.slice("swarm.nodes.".length),
              input,
              invocation,
            ),
          },
        };
      if (name === "swarm.runs.read-file") {
        return {
          output: await executor.readEvidence(
            {
              ...parseRunInput(input),
              taskId: requiredString(input.taskId, "taskId"),
              uri: requiredString(input.uri, "uri"),
              ...(input.offset === undefined ? {} : { offset: requiredOffset(input.offset) }),
            },
            invocation,
          ),
        };
      }
      if (name === "swarm.runs.evidence-list")
        return {
          output: {
            entries: (await executor.listEvidence(invocation)).map((run) => ({
              id: run.runId,
              title: run.objective,
              status: run.state,
            })),
          },
        };
      if (name === "swarm.runs.evidence-open") {
        const run = await executor.openEvidence(requiredString(input.id, "id"), invocation);
        return { output: { run } };
      }
      switch (name) {
        case SWARM_RUNS_CREATE:
          return {
            output: {
              run: await executor.create(parseCreateInput(input), invocation),
            },
          };
        case SWARM_RUNS_GET:
          return {
            output: {
              run: await executor.getAuthorized(parseRunInput(input), invocation),
            },
          };
        case SWARM_RUNS_LIST:
          return {
            output: { runs: await executor.listAuthorized(invocation) },
          };
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
        case SWARM_RUNS_RECOVER_SYSTEM_FAILURE:
          if (
            input.classification !== "owner-session-busy-transport" &&
            input.classification !== "owner-session-superseded-transport"
          )
            throw new Error("Explicit owner-session-busy-transport classification is required.");
          for (const field of ["expectedTaskFailureIndex", "expectedRunFailureIndex"])
            if (!Number.isSafeInteger(input[field]) || Number(input[field]) < 1)
              throw new Error(`${field} must be a positive event index.`);
          return {
            output: {
              run: await executor.recoverSystemFailure(
                {
                  ...parseRunInput(input),
                  reason: requiredString(input.reason, "reason"),
                  classification: input.classification,
                  expectedTaskFailureIndex: input.expectedTaskFailureIndex as number,
                  expectedRunFailureIndex: input.expectedRunFailureIndex as number,
                },
                invocation,
              ),
            },
          };
        case SWARM_RUNS_SET_ROLE_MODELS:
          validateSwarmRoleModels(input.roleModels);
          return {
            output: {
              run: await executor.setRoleModels(
                {
                  ...parseRunInput(input),
                  roleModels: input.roleModels,
                  reason: requiredString(input.reason, "reason"),
                },
                invocation,
              ),
            },
          };
        case SWARM_RUNS_SET_ROLES:
          validateSwarmRoleDefinitions(input.roles);
          return {
            output: {
              run: await executor.setRoles(
                {
                  ...parseRunInput(input),
                  roles: input.roles,
                  reason: requiredString(input.reason, "reason"),
                },
                invocation,
              ),
            },
          };
        case SWARM_RUNS_DRIVE:
          await executor.getRootAuthorized(parseRunInput(input), invocation);
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
  type: "string",
  minLength: 1,
} as const;
const RUN_INPUT = objectSchema({ runId: IDENTIFIER }, ["runId"]);
const RUN_OUTPUT = objectSchema({ run: { type: "object" } }, ["run"]);
const NODE_ACK_SCHEMA = objectSchema(
  {
    taskId: IDENTIFIER,
    state: {
      type: "string",
      enum: ["pending", "running", "blocked", "completed", "failed"],
    },
    resumeCount: { type: "integer", minimum: 0 },
  },
  ["taskId", "state", "resumeCount"],
);
const NODE_ACK_OPERATIONS = new Set(["block", "resume", "continue"]);
const ROLE_MODELS = {
  type: "object",
  minProperties: 1,
  additionalProperties: false,
  properties: Object.fromEntries(
    ["planner", "worker", "reconciler", "reviewer"].map((role) => [
      role,
      objectSchema({ model: IDENTIFIER, reasoningEffort: IDENTIFIER }, ["model"]),
    ]),
  ),
} as const;
const ROLE_DEFINITIONS = {
  type: "array",
  minItems: 1,
  description:
    "Run-defined roles. Planners launch one by name; it runs on its own model, follows its instructions, and completes with a result checked against resultSchema.",
  items: objectSchema(
    {
      name: IDENTIFIER,
      base: { type: "string", enum: ["worker", "reviewer"] },
      model: IDENTIFIER,
      reasoningEffort: IDENTIFIER,
      whenToUse: IDENTIFIER,
      instructions: IDENTIFIER,
      plannerGuidance: IDENTIFIER,
      resultSchema: { type: "object" },
      systemPrompt: { ...IDENTIFIER, description: "Replaces Marshal's system prompt; the task message is lean" },
      tools: { type: "array", minItems: 1, items: IDENTIFIER, description: "Host tool allowlist" },
      workspaceMode: { type: "string", enum: ["shared", "isolated"] },
    },
    ["name", "base", "model", "whenToUse", "instructions"],
  ),
} as const;
const DESCRIPTORS: readonly CapabilityDescriptor[] = [
  ...[
    "list",
    "get",
    "launch",
    "publishArtifact",
    "block",
    "fail",
    "complete",
    "continue",
    "resume",
  ].map((name) =>
    descriptor(
      `swarm.nodes.${name}`,
      name === "list" || name === "get"
        ? `Read same-identity swarm nodes (${name})`
        : `Explicitly ${name} owned swarm nodes`,
      {
        type: "object",
        properties: {
          runId: IDENTIFIER,
          taskId: IDENTIFIER,
          parentTaskId: IDENTIFIER,
          role: {
            ...IDENTIFIER,
            description: "planner, worker, reconciler, reviewer, or a run-defined role name",
          },
          objective: IDENTIFIER,
          scope: IDENTIFIER,
          idempotencyKey: IDENTIFIER,
          reason: IDENTIFIER,
          dependencyTaskIds: { type: "array", items: IDENTIFIER },
          attachments: { type: "array", items: IDENTIFIER, description: "Launch: absolute file paths" },
          commits: { type: "array", items: IDENTIFIER },
          artifact: { type: "object" },
          result: {
            description: "A run-defined role's completion result, checked against its resultSchema",
          },
        },
        required: ["runId"],
        additionalProperties: false,
      },
      objectSchema(
        {
          node:
            name === "list"
              ? { type: "array", items: { type: "object" } }
              : NODE_ACK_OPERATIONS.has(name)
                ? NODE_ACK_SCHEMA
                : { type: "object" },
        },
        ["node"],
      ),
      name === "list" || name === "get",
    ),
  ),
  descriptor(
    "swarm.runs.read-file",
    "Read a same-identity run artifact or decoded native transcript reference. Pass nextOffset as offset to retrieve each subsequent page until truncated is false.",
    objectSchema(
      {
        runId: IDENTIFIER,
        taskId: IDENTIFIER,
        uri: IDENTIFIER,
        offset: { type: "integer", minimum: 0 },
      },
      ["runId", "taskId", "uri"],
    ),
    objectSchema(
      {
        uri: IDENTIFIER,
        text: { type: "string" },
        truncated: { type: "boolean" },
        nextOffset: { type: "integer", minimum: 0 },
      },
      ["uri", "text", "truncated"],
    ),
    true,
  ),
  descriptor(
    "swarm.runs.evidence-list",
    "List persistent Swarm evidence for this identity, including paused and historical runs",
    objectSchema({}, []),
    objectSchema(
      {
        entries: {
          type: "array",
          items: objectSchema({ id: IDENTIFIER, title: IDENTIFIER, status: IDENTIFIER }, [
            "id",
            "title",
            "status",
          ]),
        },
      },
      ["entries"],
    ),
    true,
  ),
  descriptor(
    "swarm.runs.evidence-open",
    "Open persistent Swarm evidence",
    objectSchema({ id: IDENTIFIER }, ["id"]),
    RUN_OUTPUT,
    true,
  ),
  descriptor(
    SWARM_RUNS_CREATE,
    "Create a recursive swarm run",
    objectSchema(
      {
        runId: IDENTIFIER,
        objective: { type: "string", minLength: 1 },
        argument: { type: "string", minLength: 1 },
        fresh: { type: "boolean" },
        sessionId: IDENTIFIER,
        scope: { type: "string", minLength: 1 },
        targetRef: { type: "string", minLength: 1 },
        targetHead: { type: "string", minLength: 1 },
        targets: {
          type: "array",
          minItems: 1,
          items: objectSchema(
            {
              scope: { type: "string", minLength: 1 },
              ref: { type: "string", minLength: 1 },
              head: { type: "string", minLength: 1 },
            },
            ["scope", "ref", "head"],
          ),
        },
        workerModel: { type: "string", minLength: 1 },
        workerReasoningEffort: { type: "string", minLength: 1 },
        roleModels: ROLE_MODELS,
        roles: ROLE_DEFINITIONS,
      },
      [],
    ),
    RUN_OUTPUT,
  ),
  descriptor(
    SWARM_RUNS_GET,
    "Read a complete same-identity swarm tree, including paused and historical runs",
    RUN_INPUT,
    RUN_OUTPUT,
    true,
  ),
  descriptor(
    SWARM_RUNS_LIST,
    "List all swarm runs for this identity, including paused and historical runs",
    objectSchema({}, []),
    objectSchema(
      {
        runs: { type: "array", items: { type: "object" } },
      },
      ["runs"],
    ),
    true,
  ),
  descriptor(
    SWARM_RUNS_CANCEL,
    "Cancel a swarm run",
    objectSchema(
      {
        runId: IDENTIFIER,
        reason: { type: "string", minLength: 1 },
      },
      ["runId", "reason"],
    ),
    RUN_OUTPUT,
  ),
  descriptor(
    SWARM_RUNS_PAUSE,
    "Pause a swarm run",
    objectSchema(
      {
        runId: IDENTIFIER,
        reason: { type: "string", minLength: 1 },
      },
      ["runId", "reason"],
    ),
    RUN_OUTPUT,
  ),
  descriptor(SWARM_RUNS_RESUME, "Resume a swarm run", RUN_INPUT, RUN_OUTPUT),
  descriptor(
    SWARM_RUNS_SET_ROLE_MODELS,
    "Update durable role model selections for future Swarm launches without resuming",
    objectSchema({ runId: IDENTIFIER, roleModels: ROLE_MODELS, reason: IDENTIFIER }, [
      "runId",
      "roleModels",
      "reason",
    ]),
    RUN_OUTPUT,
  ),
  descriptor(
    SWARM_RUNS_SET_ROLES,
    "Add or replace run-defined roles for later Swarm prompts and launches without resuming",
    objectSchema({ runId: IDENTIFIER, roles: ROLE_DEFINITIONS, reason: IDENTIFIER }, [
      "runId",
      "roles",
      "reason",
    ]),
    RUN_OUTPUT,
  ),
  descriptor(
    SWARM_RUNS_RECOVER_SYSTEM_FAILURE,
    "Explicitly recover an owner-session busy transport failure into a paused run",
    objectSchema(
      {
        runId: IDENTIFIER,
        reason: IDENTIFIER,
        classification: {
          type: "string",
          enum: ["owner-session-busy-transport", "owner-session-superseded-transport"],
        },
        expectedTaskFailureIndex: { type: "integer", minimum: 1 },
        expectedRunFailureIndex: { type: "integer", minimum: 1 },
      },
      ["runId", "reason", "classification", "expectedTaskFailureIndex", "expectedRunFailureIndex"],
    ),
    RUN_OUTPUT,
  ),
  descriptor(SWARM_RUNS_DRIVE, "Drive a swarm run to completion", RUN_INPUT, RUN_OUTPUT),
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
    version: "0.1.0",
    description,
    tags: ["swarm", "recursive"],
    inputSchema,
    outputSchema,
    permissions: [
      {
        permission: readOnly ? "swarm.read" : "swarm.execute",
        risk: readOnly ? "low" : "high",
      },
    ],
  };
}
function parseCreateInput(input: Readonly<Record<string, unknown>>): SwarmRunCreateInput {
  if (input.roleModels !== undefined) validateSwarmRoleModels(input.roleModels);
  if (input.roles !== undefined) validateSwarmRoleDefinitions(input.roles);
  const objective =
    input.objective === undefined
      ? requiredString(input.argument, "objective")
      : requiredString(input.objective, "objective");
  return {
    objective,
    ...(input.roleModels === undefined ? {} : { roleModels: input.roleModels }),
    ...(input.roles === undefined ? {} : { roles: input.roles }),
    ...(input.runId === undefined ? {} : { runId: requiredString(input.runId, "runId") }),
    ...(input.scope === undefined ? {} : { scope: requiredString(input.scope, "scope") }),
    ...(input.fresh === undefined ? {} : { fresh: requiredBoolean(input.fresh, "fresh") }),
    ...(input.targetRef === undefined
      ? {}
      : { targetRef: requiredString(input.targetRef, "targetRef") }),
    ...(input.targetHead === undefined
      ? {}
      : { targetHead: requiredString(input.targetHead, "targetHead") }),
    ...(input.targets === undefined ? {} : { targets: parseTargets(input.targets) }),
    ...(input.workerModel === undefined
      ? {}
      : { workerModel: requiredString(input.workerModel, "workerModel") }),
    ...(input.workerReasoningEffort === undefined
      ? {}
      : {
          workerReasoningEffort: requiredString(
            input.workerReasoningEffort,
            "workerReasoningEffort",
          ),
        }),
  };
}
function parseTargets(value: unknown): readonly SwarmRunTarget[] {
  if (!Array.isArray(value)) {
    throw new TypeError("targets must be an array.");
  }
  return value.map((entry, index): SwarmRunTarget => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
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
function parseRunInput(input: Readonly<Record<string, unknown>>): SwarmRunInput {
  return { runId: requiredString(input.runId, "runId") };
}
function parsePauseInput(input: Readonly<Record<string, unknown>>): SwarmRunPauseInput {
  return {
    runId: requiredString(input.runId, "runId"),
    reason: requiredString(input.reason, "reason"),
  };
}
function parseCancelInput(input: Readonly<Record<string, unknown>>): SwarmRunCancelInput {
  return {
    runId: requiredString(input.runId, "runId"),
    reason: requiredString(input.reason, "reason"),
  };
}
function requiredRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Swarm input must be an object.");
  }
  return value as Readonly<Record<string, unknown>>;
}
function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value.trim();
}
function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new TypeError(`${label} must be a boolean.`);
  }
  return value;
}
function objectSchema(
  properties: Readonly<Record<string, unknown>>,
  required: readonly string[],
): Readonly<Record<string, unknown>> {
  return {
    type: "object",
    additionalProperties: false,
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

function requiredOffset(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new TypeError("offset must be a nonnegative integer.");
  return value;
}
