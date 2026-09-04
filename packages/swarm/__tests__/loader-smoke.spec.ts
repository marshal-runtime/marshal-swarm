import * as crypto from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  computeRuntimeExtensionIntegrity,
  LocalRuntimeExtensionPackageLoader,
} from '@marshal/runtime/extensions';
import { SWARM_RUN_VIEW_RESOURCE_URI, SWARM_SLASH_COMMAND_RESOURCE_URI } from '../src/presentation.js';

describe('packed Runtime extension', () => {
  it('loads and disposes without Swarm services or configuration', async () => {
    const root = mkdtempSync(path.join(process.cwd(), '.tmp-loader-'));
    try {
    const packageRoot = path.join(root, 'package');
    mkdirSync(path.join(packageRoot, 'dist'), { recursive: true });
    cpSync(path.join(process.cwd(), 'dist', 'extension.cjs'), path.join(packageRoot, 'dist', 'extension.cjs'));
    cpSync(path.join(process.cwd(), 'runtime-extension.json'), path.join(packageRoot, 'runtime-extension.json'));
    writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({
      name: '@marshal/swarm',
      version: '0.1.0',
      main: 'dist/extension.cjs',
      type: 'commonjs',
    }));
    const request = {
      packageRoot,
      integrity: computeRuntimeExtensionIntegrity(packageRoot),
    };
    const loaded = new LocalRuntimeExtensionPackageLoader({
      allowedRoots: [root],
      modules: { 'node:path': path, 'node:fs/promises': fsPromises, 'node:crypto': crypto },
    }).load(request);
    const activation = await loaded.module.activate({
      manifest: loaded.metadata.manifest,
      configuration: { runsDirectory: path.join(root, 'runs') },
      services: { tryGet: () => undefined, get: () => { throw new Error('not used'); }, getAll: () => [] },
      search: async () => ({ matches: [] }),
      execute: async () => { throw new Error('not used'); },
    });
    expect(activation.capabilityProviders).toHaveLength(1);
    expect(activation.uiApplications?.map((application) => application.resource.uri)).toEqual([
      SWARM_RUN_VIEW_RESOURCE_URI,
      SWARM_SLASH_COMMAND_RESOURCE_URI,
    ]);
    await activation.dispose?.();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
