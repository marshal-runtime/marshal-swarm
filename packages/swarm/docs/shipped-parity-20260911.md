# Shipped-archive parity evidence — snapshot 27cc80d vs marshal-swarm host-7 + overlay (2026-09-11)

Method: `packages/swarm` was built (`pnpm build`) in a clean temp worktree at snapshot commit
`27cc80d` (the verbatim preservation of the `codex/swarm-task-protocol` worktree dirty state at
base `3434209`), then byte-compared file-by-file (`cmp`) against the extracted shipped archive
`marshal-swarm-0.1.0-marshal-host-7-guidance-4176111.tgz`
(sha256 `c2449f8bc44ebb65…`, the archive pinned by the host-10/host-11 pack manifests).

Result — every shipped file byte-identical to the snapshot build, with exactly two exceptions:

| File | Difference | Explanation |
|---|---|---|
| `runtime-extension.json` | shipped copy adds the `agentGuidance` block | the documented pack-time guidance overlay from `4176111` (`overlaySwarmGuidance`), applied to the retained base archive |
| `package.json` | key ordering only (scripts block position) | npm pack rewrite; content identical |

All bundles (`index.mjs`, `index.cjs`, `extension.cjs`, `presentation.mjs`, `presentation.cjs`,
`dist/ui/*`) and every `.d.ts`/`.d.ts.map` matched byte-for-byte.

Implications:
1. The shipped `@marshal/swarm` source state IS snapshot `27cc80d`; the earlier
   `dirtyDiffSha256` mismatch (`ecbeb016…` recorded vs `e2a6c102…`/`5f135527…`/`42a43675…`
   recomputed) was a diff-serialization artifact — the 14 files now untracked were tracked at
   pack time — not content drift.
2. A swarm package rebuilt from this branch differs from shipped behavior ONLY by the commits
   on top of `27cc80d` (the outcome-summary feature).
3. The guidance overlay must be re-applied at pack time from the `4176111` source
   (`--swarm-guidance-from /Users/omer/marshal/worktrees/promptpiece-marshal-swarm`) for the
   packaged manifest to match the shipped guidance contract.

This report is evidence of source provenance, not a claim that any rebuilt archive is
byte-identical to the shipped one (the rebuilt archive intentionally adds the feature).
