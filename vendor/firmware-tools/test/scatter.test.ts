// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Ashworth Digital Ltd
// This file is part of Studio Pocket. It is licensed under GPL-3.0-only, or under a
// commercial licence from Ashworth Digital Ltd (see COPYING.commercial).

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { findPartition, parseScatter, ScatterError } from '../src/scatter.js';

const fixture = new URL('./fixtures/y2-3.2.1-layout.scatter.txt', import.meta.url);

describe('parseScatter', () => {
    it('reads the general block and all partitions', async () => {
        const scatter = parseScatter(await readFile(fixture, 'utf8'));
        expect(scatter.general).toEqual({ configVersion: 'V1.1.1', platform: 'MT6582', project: 'eastaeon82_wet_kk', storage: 'EMMC' });
        expect(scatter.partitions).toHaveLength(21);
        const android = findPartition(scatter, 'ANDROID')!;
        expect(android.index).toBe(16);
        expect(android.physicalStart).toBe(0x5180000);
        expect(android.linearStart).toBe(0x6580000);
        expect(android.size).toBe(0x33400000);
        expect(android.fileName).toBe('system.img');
        expect(android.isDownload).toBe(true);
        expect(android.operationType).toBe('UPDATE');
        expect(findPartition(scatter, 'NVRAM')!.fileName).toBeNull();
    });

    it('rejects a scatter with no partitions', () => {
        expect(() => parseScatter('- general: MTK_PLATFORM_CFG\n  info:\n    - config_version: V1\n      platform: MT6582\n      project: x\n      storage: EMMC\n')).toThrow(ScatterError);
    });

    it('rejects malformed addresses', () => {
        const text = '- general: MTK_PLATFORM_CFG\n  info:\n    - config_version: V1\n      platform: MT6582\n      project: x\n      storage: EMMC\n- partition_index: SYS0\n  partition_name: A\n  linear_start_addr: zz\n  physical_start_addr: 0x0\n  partition_size: 0x10\n';
        expect(() => parseScatter(text)).toThrow(/expected hex/);
    });
});
