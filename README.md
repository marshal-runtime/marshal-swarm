# Marshal Swarm

Standalone source repository for `@marshal/swarm@0.1.0`.

Swarm is an optional Runtime extension, not part of portable Runtime or the
Codex adapter. All Swarm identity, recursive execution, persistence, provider
operations, and UI live in this repository. Runtime supplies only the generic
extension activation, operation execution, services, and UI contracts.

The package is a small recursive executor installed dynamically into a Marshal
host. One root objective may delegate child tasks at any depth. Every task can
work or plan according to its explicit role, every child declares one repository
scope, and parents resume with plain child outcomes and each immediate child's
own change references. Runtime owns the generic extension lifecycle while Swarm
owns its run event store and replay model.

The provider exposes run controls, explicit `swarm.nodes.*` task lifecycle
operations, and paginated evidence reads. Agents with the same owner identity
and a valid session may inspect other agents' full Swarm trees, including
paused, blocked, and historical work. This read access does not grant mutation
rights: run controls remain root-owner-only and task writes remain scoped to
the owning task. See the package's [read-access API](packages/swarm/README.md#read-access-and-paginated-evidence).

The published package contains `runtime-extension.json` and a bundled
`dist\extension.cjs` entrypoint. A generic `RuntimeExtensionManager` discovers,
installs, and activates it; no Runtime or Codex registration is required.

## Local install, enable, and configure

Place this checkout at `<marshal-agent-runtime>\extensions\marshal-swarm`, then:

```powershell
Set-Location <marshal-agent-runtime>\extensions\marshal-swarm
corepack pnpm@10.32.1 install
corepack pnpm@10.32.1 build
```

Refresh the Runtime extension catalog, explicitly install
`@marshal/swarm`, and enable it. Configure `runsDirectory` to an absolute
directory writable by the host, for example
`C:\Users\me\AppData\Local\Marshal\swarm`. Discovery does not install, enable,
activate, or execute the extension.

When enabled, Swarm contributes `swarm.runs.*` and `swarm.nodes.*` capabilities and the
`swarm-run` UI application. The UI presents run/task state and pause/resume
controls; opening agent sessions remains a host action.

See [`packages/swarm/README.md`](packages/swarm/README.md) for the package API,
architecture details, and optional in-process provider/source composition.

## Verification

The root workspace override resolves `@marshal/runtime` from
`<marshal-agent-runtime>\packages\runtime` only for the canonical checkout at
`<marshal-agent-runtime>\extensions\marshal-swarm`. It is development-only
metadata; the published package dependency remains exactly `0.1.0` and does not
carry the local link.

```powershell
corepack pnpm@10.32.1 install
corepack pnpm@10.32.1 build
corepack pnpm@10.32.1 verify
```
