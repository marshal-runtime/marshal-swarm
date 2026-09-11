import type { UiApplicationManifest } from "@marshal/runtime/ui";

export const SWARM_EXTENSION_IDENTITY = "@marshal/swarm";
export const SWARM_RUN_VIEW_EXTENSION_ID = SWARM_EXTENSION_IDENTITY;
export const SWARM_RUN_VIEW_RENDER_ID = "swarm.run.view";
export const SWARM_RUN_VIEW_RESOURCE_URI = "ui://marshal/swarm/run";
export const SWARM_RUN_APPLICATION_ID = "swarm-run";
export const SWARM_SLASH_COMMAND_NAME = "swarm";
export const SWARM_SLASH_COMMAND_PLACEMENT_ID = "marshal.chat.slash-command";
export const SWARM_SLASH_COMMAND_APPLICATION_ID = SWARM_SLASH_COMMAND_NAME;
export const SWARM_SLASH_COMMAND_RESOURCE_URI = "ui://marshal/swarm/slash-command";
export const SWARM_SLASH_ARGUMENT_KEY = "argument";
export const SWARM_SLASH_FRESH_KEY = "fresh";
export const SWARM_RUNS_CREATE_CAPABILITY = "swarm.runs.create";
export const SWARM_RUNS_PAUSE_CAPABILITY = "swarm.runs.pause";
export const SWARM_RUNS_RESUME_CAPABILITY = "swarm.runs.resume";
export const SWARM_RUNS_RECOVER_SYSTEM_FAILURE_CAPABILITY = "swarm.runs.recoverSystemFailure";
export const SWARM_RUNS_SET_ROLE_MODELS_CAPABILITY = "swarm.runs.setRoleModels";
export const SWARM_OPEN_SESSION_CAPABILITY = "marshal.swarm.open-session";

const APPLICATION_VERSION = "1.0.0";

export function swarmRunApplication(): UiApplicationManifest {
  return {
    version: APPLICATION_VERSION,
    presentationModes: ["inline", "pip"],
    authoritativeState: {
      capability: "swarm.runs.get",
      resourceId: SWARM_RUN_VIEW_RESOURCE_URI,
      version: APPLICATION_VERSION,
    },
    tools: [],
    actions: [
      action("marshal-evidence-list", "swarm.runs.evidence-list", "List Swarm runs", "write"),
      action("marshal-evidence-open", "swarm.runs.evidence-open", "Open Swarm run", "write"),
      action("swarm-read-file", "swarm.runs.read-file", "Read evidence file", "write"),
      action("swarm-runs-create", SWARM_RUNS_CREATE_CAPABILITY, "Start swarm", "write"),
      action("swarm-runs-pause", SWARM_RUNS_PAUSE_CAPABILITY, "Pause run", "write", [
        "runId",
        "reason",
      ]),
      action("swarm-runs-resume", SWARM_RUNS_RESUME_CAPABILITY, "Resume run", "write"),
      action("swarm-runs-set-role-models", SWARM_RUNS_SET_ROLE_MODELS_CAPABILITY, "Set run role models", "write", ["runId", "roleModels", "reason"]),
      action("swarm-runs-recover-system-failure", SWARM_RUNS_RECOVER_SYSTEM_FAILURE_CAPABILITY, "Recover owner-session transport failure", "write", [
        "runId", "reason", "classification", "expectedTaskFailureIndex", "expectedRunFailureIndex",
      ]),
      action(
        "marshal-swarm-open-session",
        SWARM_OPEN_SESSION_CAPABILITY,
        "Open agent session",
        "external-effect",
      ),
    ],
  };
}

export function swarmSlashApplication(): UiApplicationManifest {
  return {
    version: APPLICATION_VERSION,
    presentationModes: ["inline"],
    tools: [],
    actions: [action("swarm-runs-create", SWARM_RUNS_CREATE_CAPABILITY, "Start swarm", "write")],
  };
}

function action(
  id: string,
  capability: string,
  title: string,
  risk: "write" | "external-effect",
  required?: readonly string[],
) {
  return {
    id,
    version: APPLICATION_VERSION,
    title,
    target: { kind: "capability" as const, capability },
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", minLength: 1 },
        uri: { type: "string", minLength: 1 },
        offset: { type: "integer", minimum: 0 },
        runId: { type: "string", minLength: 1 },
        reason: { type: "string", minLength: 1 },
        objective: { type: "string", minLength: 1 },
        argument: { type: "string", minLength: 1 },
        fresh: { type: "boolean" },
        sessionId: { type: "string", minLength: 1 },
        taskId: { type: "string" },
        agentSessionId: { type: "string" },
        classification: { type: "string", enum: ["owner-session-busy-transport", "owner-session-superseded-transport"] },
        expectedTaskFailureIndex: { type: "integer", minimum: 1 },
        expectedRunFailureIndex: { type: "integer", minimum: 1 },
        roleModels: {
          type: "object", minProperties: 1, additionalProperties: false,
          properties: Object.fromEntries(["planner", "worker", "reconciler", "reviewer"].map((role) => [role, {
            type: "object", required: ["model"], additionalProperties: false,
            properties: { model: { type: "string", minLength: 1 }, reasoningEffort: { type: "string", minLength: 1 } },
          }])),
        },
      },
      additionalProperties: false,
      ...(required ? { required } : {}),
    },
    outputSchema: { type: "object", additionalProperties: true },
    allowedScopes: ["session", "project", "workspace"] as const,
    requiredPermissions: [],
    risk,
    idempotency: risk === "write" ? ("supported" as const) : ("none" as const),
  };
}
