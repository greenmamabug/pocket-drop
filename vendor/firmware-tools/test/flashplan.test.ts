// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Ashworth Digital Ltd
// This file is part of Studio Pocket. It is licensed under GPL-3.0-only, or under a
// commercial licence from Ashworth Digital Ltd (see COPYING.commercial).

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { buildFlashPlan, checkCompatibility, FlashPlanError } from '../src/flashplan.js';
import { loadManifest } from '../src/node.js';
import { parseScatter } from '../src/scatter.js';

const manifestPath = new URL('../src/manifests/y2-stock-3.2.1.json', import.meta.url).pathname;
const fixture = new URL('./fixtures/y2-3.2.1-layout.scatter.txt', import.meta.url);

describe('flash plan', () => {
    it('accepts the stock 3.2.1 layout', async () => {
        const manifest = await loadManifest(manifestPath);
        const scatter = parseScatter(await readFile(fixture, 'utf8'));
        expect(checkCompatibility(manifest, scatter)).toEqual([]);
    });

    it('rejects a Y1-style index or a moved partition', async () => {
        const manifest = await loadManifest(manifestPath);
        const scatter = parseScatter(await readFile(fixture, 'utf8'));
        const android = scatter.partitions.find((p) => p.name === 'ANDROID')!;
        android.index = 15;
        android.physicalStart += 0x80000;
        const problems = checkCompatibility(manifest, scatter);
        expect(problems.some((p) => /index 15/.test(p))).toBe(true);
        expect(problems.some((p) => /start/.test(p))).toBe(true);
    });

    it('writes a Download-Only XML that names only SYS16', async () => {
        const manifest = await loadManifest(manifestPath);
        const scatter = parseScatter(await readFile(fixture, 'utf8'));
        const plan = buildFlashPlan({ manifest, scatter, imagePath: 'C:\\myo\\system.studiopocket.img', scatterPath: 'C:\\myo\\MT6582_Android_scatter.txt', downloadAgentPath: 'C:\\spft\\MTK_AllInOne_DA.bin' });
        expect(plan.scatterIndex).toBe(16);
        expect(plan.spFlashToolXml).toContain('<download-only>');
        expect(plan.spFlashToolXml).not.toContain('format');
        expect(plan.spFlashToolXml.match(/<rom /g)).toHaveLength(1);
        expect(plan.spFlashToolXml).toContain('<rom index="16" enable="true">C:\\myo\\system.studiopocket.img</rom>');
        // never an offset (see flashplan.ts): mtkclient must resolve the partition on the device
        expect(plan.mtkclientScript).toBe('w ANDROID C:\\myo\\system.studiopocket.img\n');
        expect(plan.mtkclientScript).not.toMatch(/0x/);
    });

    it('refuses to plan any other partition', async () => {
        const manifest = await loadManifest(manifestPath);
        const scatter = parseScatter(await readFile(fixture, 'utf8'));
        expect(() => buildFlashPlan({ manifest, scatter, imagePath: 'x', scatterPath: 's', downloadAgentPath: 'd', partitionName: 'BOOTIMG' })).toThrow(FlashPlanError);
    });
});
