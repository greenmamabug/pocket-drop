// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Ashworth Digital Ltd
// This file is part of Studio Pocket. It is licensed under GPL-3.0-only, or under a
// commercial licence from Ashworth Digital Ltd (see COPYING.commercial).

import { describe, expect, it } from 'vitest';
import { ManifestError, targetPartition, validateManifest } from '../src/manifest.js';
import { loadManifest } from '../src/node.js';

const manifestPath = new URL('../src/manifests/y2-stock-3.2.1.json', import.meta.url).pathname;

describe('firmware manifest', () => {
    it('loads the stock 3.2.1 manifest and only ANDROID is touched', async () => {
        const manifest = await loadManifest(manifestPath);
        expect(manifest.platform.soc).toBe('MT6582');
        expect(targetPartition(manifest)).toMatchObject({ name: 'ANDROID', index: 16, physicalStart: '0x5180000', size: '0x33400000' });
        expect(manifest.partitions.filter((p) => p.studioPocketTouches)).toHaveLength(1);
    });

    it('refuses a manifest that touches a protected partition', async () => {
        const manifest = await loadManifest(manifestPath);
        manifest.partitions.find((p) => p.name === 'PRELOADER')!.studioPocketTouches = true;
        expect(() => validateManifest(manifest)).toThrow(ManifestError);
    });

    it('refuses a manifest with no target', async () => {
        const manifest = await loadManifest(manifestPath);
        for (const p of manifest.partitions) p.studioPocketTouches = false;
        expect(() => validateManifest(manifest)).toThrow(/exactly one partition/);
    });
});
