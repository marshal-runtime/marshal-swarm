import * as crypto from 'node:crypto';
import * as url from 'node:url';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  computeRuntimeExtensionIntegrity,
  LocalRuntimeExtensionPackageLoader,
} from '@marshal/runtime/extensions';
import {
  SWARM_RUN_APPLICATION_ID,
  SWARM_RUN_NAVIGATION_PLACEMENT_ID,
  SWARM_RUN_VIEW_RESOURCE_URI,
  SWARM_SLASH_COMMAND_RESOURCE_URI,
} from '../src/presentation.js';

describe('packed Runtime extension', () => {
  it.each(['native', 'headless'])('loads and disposes through normal activation on a %s host', async (presentation) => {
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
      modules: { 'node:path': path, 'node:fs/promises': fsPromises, 'node:crypto': crypto, 'node:url': url },
    }).load(request);
    const activation = await loaded.module.activate({
      manifest: loaded.metadata.manifest,
      configuration: { runsDirectory: path.join(root, 'runs'), presentation },
      services: { tryGet: () => undefined, get: () => { throw new Error('not used'); }, getAll: () => [] },
      search: async () => ({ matches: [] }),
      execute: async () => { throw new Error('not used'); },
    });
    expect(activation.capabilityProviders).toHaveLength(1);
    expect(activation.uiApplications?.map((application) => application.resource.uri)).toEqual([
      SWARM_RUN_VIEW_RESOURCE_URI,
      SWARM_SLASH_COMMAND_RESOURCE_URI,
    ]);
    expect(activation.uiApplications?.every((application) => application.resource.text)).toBe(true);
    expect(
      activation.uiApplications?.every(
        (application) =>
          JSON.stringify(application.metadata?.['marshal.ui.viewports']) ===
          JSON.stringify(['mobile', 'desktop']),
      ),
    ).toBe(true);
    if (presentation === 'headless') expect(activation.uiPlacements).toEqual([]);
    else expect(activation.uiPlacements).toContainEqual({
      placementId: SWARM_RUN_NAVIGATION_PLACEMENT_ID,
      applicationId: SWARM_RUN_APPLICATION_ID,
      action: 'augment',
    });
    await activation.dispose?.();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
