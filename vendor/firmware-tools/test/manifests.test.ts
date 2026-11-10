// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Ashworth Digital Ltd
// This file is part of Studio Pocket. It is licensed under GPL-3.0-only, or under a
// commercial licence from Ashworth Digital Ltd (see COPYING.commercial).

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseManifest, targetPartition } from '../src/manifest.js';

const dir = new URL('../src/manifests/', import.meta.url).pathname;

describe('every committed firmware manifest', () => {
    it('validates, targets ANDROID at the same place, and has distinct hashes', async () => {
        const names = (await readdir(dir)).filter((n) => n.endsWith('.json'));
        expect(names.length).toBeGreaterThanOrEqual(2);
        const seen = new Set<string>();
        for (const name of names) {
            const m = parseManifest(await readFile(path.join(dir, name), 'utf8'));
            expect(name).toBe(`y2-stock-${m.firmwareVersion}.json`);
            const t = targetPartition(m);
            expect([t.name, t.index, t.physicalStart, t.size]).toEqual(['ANDROID', 16, '0x5180000', '0x33400000']);
            for (const h of [m.source.sha256, m.files['system.img']!.sha256]) { expect(seen.has(h)).toBe(false); seen.add(h); }
        }
    });
});
