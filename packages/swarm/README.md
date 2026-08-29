# `@marshal/swarm`

A small Cursor-aligned recursive executor for explicit Marshal host composition.

Each run starts with one planner and one repository scope. Planners only plan
and may recursively delegate more planners or atomic workers. The root planner
owns `field-guide/index.md`; child planners may own only an explicitly assigned
topic file. Workers implement one leaf, neutral reconcilers integrate sibling
change references, and read-only reviewers inspect integrated work through
deliberately different lenses. Non-planners never edit the guide. Only planners
may return children, and every child explicitly declares its role, objective,
stable task ID, and one repository scope.
Child task IDs are parent-local and are namespaced only in the persisted event
projection, so independent planners may safely choose the same local ID.

After children finish, their parent continues automatically with plain results
or errors and each immediate child's own change references. A planner can then
delegate reconciliation, decorrelated review, or focused repairs. Agents need
JSON only to delegate. Any other JSON-safe output completes the task. This
repeats until the root completes; topology has no fixed fan-out, depth, or
stages. A root failure fails the run without an executor retry or requeue.

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

The provider exposes seven operations:

| Operation | Behavior |
| --- | --- |
| `swarm.runs.create` | Create a run and root task with its canonical target ref and head. |
| `swarm.runs.get` | Read one run. |
| `swarm.runs.list` | List runs. |
| `swarm.runs.cancel` | Cancel a running delegation tree. |
| `swarm.runs.pause` | Durably pause scheduling and cooperatively signal persisted running delegations. |
| `swarm.runs.resume` | Resume a paused run idempotently and drive it. |
| `swarm.runs.drive` | Drive a running run; return a paused or terminal run unchanged. |

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
