export type SwarmJsonPrimitive = null | boolean | number | string;
export type SwarmJsonValue =
  | SwarmJsonPrimitive
  | readonly SwarmJsonValue[]
  | {
      readonly [key: string]: SwarmJsonValue;
    };
export type SwarmTaskState = "pending" | "running" | "blocked" | "completed" | "failed";
export type SwarmRunState = Exclude<SwarmTaskState, "pending"> | "paused";
export type SwarmTaskRole = "planner" | "worker" | "reconciler" | "reviewer";
export const SWARM_TASK_ROLES: readonly SwarmTaskRole[] = ["planner", "worker", "reconciler", "reviewer"];
export type SwarmDefinedRoleBase = Extract<SwarmTaskRole, "worker" | "reviewer">;
export const SWARM_DEFINED_ROLE_BASES: readonly SwarmDefinedRoleBase[] = ["worker", "reviewer"];
/** A run-scoped role that the launching agent defines on top of a built-in base role. */
export interface SwarmRoleDefinition {
  readonly name: string;
  readonly base: SwarmDefinedRoleBase;
  readonly model: string;
  readonly reasoningEffort?: string;
  readonly whenToUse: string;
  readonly instructions: string;
  readonly plannerGuidance?: string;
  readonly resultSchema?: SwarmJsonValue;
}
export type SwarmRoleModels = Readonly<
  Partial<
    Record<
      SwarmTaskRole,
      {
        readonly model: string;
        readonly reasoningEffort?: string;
      }
    >
  >
>;
export const SWARM_OWNER_SESSION_SUPERSEDED_ERROR = "Session send was superseded before it started";
export const SWARM_OWNER_SESSION_BUSY_ERROR =
  "Another message or turn is already active for this session";
export type SwarmPauseReason =
  | {
      readonly kind: "manual";
      readonly message: string;
    }
  | {
      readonly kind: "environmental";
      readonly operation: "worktree.create";
      readonly taskId: string;
      readonly attempts: 3;
      readonly message: string;
      readonly code?: string;
      readonly category?: string;
    };
export interface SwarmTaskDefinition {
  readonly taskId: string;
  readonly parentTaskId?: string;
  readonly role: SwarmTaskRole;
  readonly definedRole?: string;
  readonly objective: string;
  readonly scope: string;
  readonly dependencyTaskIds?: readonly string[];
  readonly idempotencyKey?: string;
  readonly ownerSessionId?: string;
  readonly ownerPrincipalId?: string;
  readonly createdAt?: string;
}
export interface SwarmRunTarget {
  readonly scope: string;
  readonly ref: string;
  readonly head: string;
}
export interface SwarmRunCreateConfiguration {
  readonly workerModel?: string;
  readonly workerReasoningEffort?: string;
  readonly roleModels?: SwarmRoleModels;
  readonly roles?: readonly SwarmRoleDefinition[];
}
export interface SwarmArtifactReference {
  readonly uri: string;
  readonly summary: string;
  readonly kind: "plan" | "decision" | "review" | "reconciliation" | "report";
}
export interface SwarmExecutionRecord {
  readonly executionId: string;
  readonly kind?: "dispatch" | "turn";
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly launchInput?: Readonly<Record<string, SwarmJsonValue>>;
  readonly dispatchState?: "registered" | "dispatched";
  readonly delegationId?: string;
  readonly sessionId?: string;
  readonly transcriptRef?: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly usageByModel?: readonly {
    readonly model?: string;
    readonly usage: {
      readonly inputTokens?: number;
      readonly outputTokens?: number;
      readonly cachedInputTokens?: number;
      readonly reportedCost?: number;
    };
  }[];
  readonly usage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly cachedInputTokens?: number;
    readonly reportedCost?: number;
  };
}
export interface SwarmNodeAck {
  readonly taskId: string;
  readonly state: SwarmTaskState;
  readonly resumeCount: number;
}
export interface SwarmTask extends SwarmTaskDefinition {
  readonly state: SwarmTaskState;
  readonly childTaskIds: readonly string[];
  readonly artifactRefs: readonly SwarmArtifactReference[];
  readonly executions: readonly SwarmExecutionRecord[];
  readonly reason?: string;
  readonly idleReminders?: number;
  readonly resumeReason?: string;
  readonly resumeCount?: number;
  readonly childAttentionSignature?: string;
  readonly delegationId?: string;
  readonly result?: SwarmJsonValue;
  readonly error?: SwarmJsonValue;
  readonly changeRefs?: readonly string[];
}
export type SwarmRunEvent =
  | {
      readonly type: "run.created";
      readonly protocolVersion?: 2;
      readonly runId: string;
      readonly objective: string;
      readonly scope: string;
      readonly targetRef?: string;
      readonly targetHead?: string;
      readonly targets?: readonly SwarmRunTarget[];
      readonly workerModel?: string;
      readonly workerReasoningEffort?: string;
      readonly roleModels?: SwarmRoleModels;
      readonly roles?: readonly SwarmRoleDefinition[];
    }
  | {
      readonly type: "run.roleModelsUpdated";
      readonly roleModels: SwarmRoleModels;
      readonly reason: string;
      readonly ownerSessionId: string;
      readonly ownerPrincipalId: string;
    }
  | {
      readonly type: "run.rolesUpdated";
      readonly roles: readonly SwarmRoleDefinition[];
      readonly reason: string;
      readonly ownerSessionId: string;
      readonly ownerPrincipalId: string;
    }
  | {
      readonly type: "run.paused";
      readonly reason: SwarmPauseReason;
    }
  | {
      readonly type: "run.resumed";
    }
  | {
      readonly type: "run.systemFailureRecovered";
      readonly taskId: string;
      readonly reason: string;
      readonly classification:
        | "owner-session-busy-transport"
        | "owner-session-superseded-transport";
      readonly expectedTaskFailureIndex: number;
      readonly expectedRunFailureIndex: number;
      readonly ownerSessionId: string;
      readonly ownerPrincipalId: string;
    }
  | {
      readonly type: "run.completed";
      readonly result?: SwarmJsonValue;
    }
  | {
      readonly type: "run.failed";
      readonly error: SwarmJsonValue;
    }
  | {
      readonly type: "run.cancelled";
      readonly error?: SwarmJsonValue;
    }
  | {
      readonly type: "task.added";
      readonly task: SwarmTaskDefinition;
    }
  | {
      readonly type: "task.blocked" | "task.resumed";
      readonly taskId: string;
      readonly reason: string;
    }
  | {
      readonly type: "task.continuationRequested";
      readonly taskId: string;
      readonly reason: string;
    }
  | {
      readonly type: "task.artifact";
      readonly taskId: string;
      readonly artifact: SwarmArtifactReference;
    }
  | {
      readonly type: "task.execution" | "task.dispatched";
      readonly taskId: string;
      readonly execution: SwarmExecutionRecord;
    }
  | {
      readonly type: "task.reminded" | "task.continued";
      readonly taskId: string;
    }
  | {
      readonly type: "task.childrenNotified";
      readonly taskId: string;
      readonly signature: string;
    }
  | {
      readonly type: "task.started";
      readonly taskId: string;
      readonly delegationId?: string;
    }
  | {
      readonly type: "task.completed";
      readonly taskId: string;
      readonly result?: SwarmJsonValue;
      readonly changeRefs?: readonly string[];
    }
  | {
      readonly type: "task.failed";
      readonly taskId: string;
      readonly error: SwarmJsonValue;
      readonly changeRefs?: readonly string[];
      readonly failureOrigin?: "runtime" | "agent";
      readonly failureCode?: "SESSION_BUSY";
    }
  | {
      readonly type: "task.cancelled";
      readonly taskId: string;
      readonly error?: SwarmJsonValue;
      readonly changeRefs?: readonly string[];
    };
export type SwarmRunUpdateEvent = Exclude<
  SwarmRunEvent,
  {
    readonly type: "run.created";
  }
>;
export interface SwarmRun {
  readonly protocolVersion?: 2;
  readonly legacyReadOnly?: boolean;
  readonly runId: string;
  readonly objective: string;
  readonly scope: string;
  readonly targetRef?: string;
  readonly targetHead?: string;
  readonly targets?: readonly SwarmRunTarget[];
  readonly workerModel?: string;
  readonly workerReasoningEffort?: string;
  readonly roleModels?: SwarmRoleModels;
  readonly roles?: readonly SwarmRoleDefinition[];
  readonly state: SwarmRunState;
  readonly pauseReason?: SwarmPauseReason;
  readonly tasks: readonly SwarmTask[];
  readonly result?: SwarmJsonValue;
  readonly error?: SwarmJsonValue;
}
