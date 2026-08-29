# Repository guidance

- Keep the publishable implementation under `packages/swarm`.
- `@marshal/swarm` may depend only on exact `@marshal/runtime@0.1.0` among
  first-party packages. Tests use public runtime subpaths.
- `packages/swarm/runtime-extension.json` is the canonical dynamic activation
  manifest. The generic `RuntimeExtensionManager` discovers, installs, and
  activates the bundled `dist/extension.cjs` without Runtime or Codex source
  changes.
- Keep all Swarm identity, implementation, manifest, capabilities, and UI in
  this extension. Runtime and the Codex adapter must remain Swarm-unaware.
- `createSwarmSource` and `createSwarmProvider` remain public APIs for hosts
  that intentionally compose Swarm in-process, but they are not the normal
  installation path and must not be described as requiring host registration.
- The root `pnpm` development override may point
  `@marshal/runtime` at `link:../../packages/runtime` only because the
  canonical checkout is
  `Q:\src\marshal-runtime\marshal-agent-runtime\extensions\marshal-swarm`.
  It is workspace-only metadata and must not affect the published package,
  whose dependency remains exactly `@marshal/runtime@0.1.0`.
