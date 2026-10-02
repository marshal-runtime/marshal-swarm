# `@marshal/swarm`

A recursive task executor installed as an optional Marshal Runtime extension.

Each run starts with one planner and one repository scope. Planners only plan
and may recursively delegate more planners or atomic workers. The root planner
owns `field-guide/index.md`; child planners may own only an explicitly assigned
topic file. Workers implement one leaf, neutral reconcilers integrate sibling
change references, and read-only reviewers inspect integrated work through
deliberately different lenses. Non-planners never edit the guide. Only planners
may launch children, and every child explicitly declares its role, objective,
stable task ID, and one repository scope.
Child task IDs are parent-local and are namespaced only in the persisted event
projection, so independent planners may safely choose the same local ID.

After children finish, their parent continues automatically with plain results
or errors and each immediate child's own change references. A planner can then
delegate reconciliation, decorrelated review, or focused repairs using explicit
`swarm.nodes.*` lifecycle calls. Conversational output is evidence, not a task
completion signal. This repeats until the root completes; topology has no fixed
fan-out, depth, or stages. A root failure fails the run without an executor retry
or requeue.

Every launch receives the current content and absolute path of one shared Field
Guide. Role prompts use it only for concise durable decisions, blockers, and
surprising facts, including megafile signals and intentional-break rationale.
The package adds no parallel ledger or event type for that context.

Runtime owns the event stream and its replay. The executor has one transition
path for all roles and settles in-flight tasks independently: each outcome is
projected immediately, and newly ready descendants launch without waiting for
unrelated siblings.

Hosts bind `SwarmSharedContextService` and may bind
`SwarmRoleModelService` through `SwarmServiceSymbols`. The lazy process
singleton exposes `bind`, `get`, `tryGet`, and `update`; a host can instead pass
the same `SwarmServiceContainer` in `SwarmSourceOptions` to avoid module-copy
singleton ambiguity. Role-model selections are forwarded only on initial agent
launches. Per-run launch values override role-model settings; workers otherwise
default to `gpt-5.6-luna` with `medium` reasoning effort.

Planner delegations use the shared workspace. Worker, reviewer, and reconciler
delegations use isolated workspaces.

Run-control operations include:

| Operation | Behavior |
| --- | --- |
| `swarm.runs.create` | Create a run and root task with its canonical target ref and head. |
| `swarm.runs.get` | Read a full same-identity run and task tree. |
| `swarm.runs.list` | List all same-identity runs, including paused and historical runs. |
| `swarm.runs.cancel` | Cancel a running delegation tree. |
| `swarm.runs.pause` | Durably pause scheduling and cooperatively signal persisted running delegations. |
| `swarm.runs.resume` | Resume a paused run idempotently and drive it. |
| `swarm.runs.drive` | Drive a running run; return a paused or terminal run unchanged. |
| `swarm.runs.setRoles` | Add or replace run-defined roles for later prompts and launches. |

## Run-defined roles

The agent that creates a run can define extra roles in `swarm.runs.create`
`roles`. Each definition has a `name`, a built-in `base` (`worker` or
`reviewer`), a `model`, an optional `reasoningEffort`, `whenToUse`,
`instructions`, optional `plannerGuidance`, and an optional `resultSchema`.
A definition can also shape its sessions: `systemPrompt`, `tools` and
`workspaceMode`.

- Planners see a "Run-defined roles" section and launch a defined role by
  name in `swarm.nodes.launch` `role`. The task keeps the base role in `role`
  and stores the defined name in `definedRole`.
- The definition model and effort override the base role model for that task.
- The task prompt adds the definition instructions to the base role contract.
  A `reviewer` base stays read-only and inspects a named change ref with
  `git checkout --detach <ref>` in its own worktree.
- `systemPrompt` replaces the host system prompt for the role's sessions. The
  task message then becomes lean: the role header, identity, objective,
  instructions, result contract and completion call. It has no run objective,
  Field Guide, sibling roster or launch interface, so the planner puts every
  input in the objective or in attachments.
- `tools` is the host tool allowlist for the role's sessions. It must include
  `runtimeInvoke` or `runtimeExecuteTypeScript`, the tools that reach
  `swarm.nodes.complete`. Without `tools` the session keeps the default tools.
- `workspaceMode` `shared` runs the role in the shared checkout instead of an
  isolated worktree. A shared role must not change the checkout and cannot
  complete with `commits`.
- `swarm.nodes.launch` accepts `attachments`: absolute paths of local files,
  such as images, that the host attaches to the child's first message. They
  are part of the launch identity for idempotent relaunches.
- A defined role completes with `swarm.nodes.complete` `result`. The executor
  validates the result against `resultSchema` before host finalization and
  rejects an invalid result with the problems to fix. The result must stay
  under 16,384 characters. Built-in roles cannot pass `result`.
- The parent planner reads the result in its child outcomes and decides what
  the result means. The package defines no verdict vocabulary.
- `swarm.runs.setRoles` merges definitions by name for the root owner. It
  replaces a same-name definition, appends a new one, and never removes one.
  A definition cannot change its base. Updates apply to later prompts,
  launches, dispatches, and completions.

`resultSchema` supports this JSON Schema subset: `type`, `enum`, `const`,
`properties`, `required`, `additionalProperties`, `items`, `minItems`,
`maxItems`, `minLength`, `maxLength`, `minimum`, `maximum`, `description`, and
`title`. The executor rejects any other keyword when it creates or updates the
role.

Normal installation uses `runtime-extension.json` from this package directory
through the generic `RuntimeExtensionManager`. The manager discovers, installs,
and activates the bundled extension without Swarm-specific Runtime, Codex, or
host source changes. The extension requires a configured absolute
`runsDirectory` and uses Runtime operation execution for delegation and
lifecycle control.

`createSwarmSource` and `createSwarmProvider` remain public APIs for hosts that
intentionally embed Swarm in an in-process composition. They are optional
alternatives, not a prerequisite for installation or activation.

The package exports both ESM and CommonJS entrypoints for the library API, while
the installed extension is always the bundled CommonJS
`dist/extension.cjs`. The manifest is included in the package so discovery and
activation work from a packed install.

## Read access and paginated evidence

A caller with a nonempty session ID and the root owner's principal identity may
read a run even when its session owns no task in that run. This includes full
running, paused, blocked, and terminal history. Different principal identities
are denied. Legacy runs without stored owner identity retain their original
owner-only read access.

| Read operation | Result |
| --- | --- |
| `swarm.runs.list` | All runs belonging to the caller's identity. |
| `swarm.runs.get` with `{runId}` | Complete run, task tree, execution records, and evidence references. |
| `swarm.nodes.list` / `swarm.nodes.get` | Complete task records for the run or selected `taskId`. |
| `swarm.runs.evidence-list` / `swarm.runs.evidence-open` | Discover and display same-identity run evidence. |
| `swarm.runs.read-file` with `{runId,taskId,uri,offset?}` | One bounded text page from a reference persisted on that task. |

For evidence pagination, append each returned `text`; if `truncated` is true,
pass the returned `nextOffset` unchanged as `offset` with the same run, task,
and URI. Stop when `truncated` is false. Artifact offsets refer to file UTF-8
bytes; transcript offsets refer to the host's decoded public transcript
projection, never encrypted storage bytes.

Hosts bind `SwarmTranscriptReaderService` at
`SwarmServiceSymbols.transcriptReader` (`@marshal/swarm:transcript-reader`). Its
`read({sessionId,uri,offset?}, invocation)` returns
`{uri,text,truncated,nextOffset?}`. The extension obtains `sessionId` from the
matching persisted execution. A transcript reference always uses this reader,
even if the URI also appears as an artifact. Missing readers or execution
session IDs fail explicitly; there is no raw encrypted-file fallback.
Artifact-only references retain bounded local-file reads.

Read access never promotes an outsider to run or task ownership. Pause,
resume, cancel, drive, role-model updates, and recovery require the original
root owner; task lifecycle writes retain their owning-task authorization.
Completion requires an explicit `swarm.nodes.complete` call, after any required
artifact publication; conversational output does not complete a task. A parent
may also call `swarm.nodes.fail` on a live direct child: the child gets
`task.cancelled` with the parent's reason, and its delegation is cancelled.

A failed or cancelled task leaves no live work beneath it: the executor appends
`task.cancelled` for every pending, running, or blocked descendant in the same
write and cancels their running delegations. The one exception is the root's
owner-session transport failure (busy/superseded), whose children are kept for
`swarm.runs.recoverSystemFailure`. The journal refuses `task.dispatched`,
`task.redispatched` and `task.started` under a failed or completed parent, and
refuses `run.resumed` after `run.failed`/`run.cancelled`; a failed run re-enters
only through audited recovery, which leaves it paused.

A launch that the runtime refuses for the environment (for example a full disk)
is recorded as `refused`, so a resume launches under a fresh key instead of
replaying the refusal. That fresh launch, and the replacement of a planner whose
completion the runtime rejected, is journaled as `task.redispatched`. Idle
reminders and runtime failures apply only to the task attempt they observed; a
task that moved on in the meantime skips them.

A wait for an agent's turn can stay pending while the agent is idle, for
example when a host restart cut the turn off before any reply. Every
`stallProbeMs` (default ten minutes) the executor sends such a task a
continuation. A busy agent does not receive it, so a live turn is never disturbed. An
accepted continuation counts as an idle reminder; after two reminders the task
blocks. A continuation that fails ends the attempt as a runtime failure.

## Local development

From the canonical repository root
`Q:\src\marshal-runtime\marshal-agent-runtime\extensions\marshal-swarm`,
`pnpm` resolves the exact published `@marshal/runtime@0.1.0` dependency to
`Q:\src\marshal-runtime\marshal-agent-runtime\packages\runtime` through the
root workspace override. This relative link is intentionally valid only for
that canonical nesting; a differently nested staging worktree needs its own
local dependency setup. The override is workspace-only and cannot leak into
the published package, whose dependency remains exactly `0.1.0`.

Run:

```powershell
corepack pnpm@10.32.1 install
corepack pnpm@10.32.1 build
corepack pnpm@10.32.1 typecheck
corepack pnpm@10.32.1 test
```

The test suite includes a loader smoke test that copies the packed extension
payload, verifies its integrity, activates it through the Runtime package
loader, and disposes it without Swarm-specific host wiring.
