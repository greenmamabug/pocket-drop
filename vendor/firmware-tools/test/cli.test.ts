// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Ashworth Digital Ltd
// This file is part of Studio Pocket. It is licensed under GPL-3.0-only, or under a
// commercial licence from Ashworth Digital Ltd (see COPYING.commercial).

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { formatUnits, parseArgs } from '../src/cli.js';
import type { UnitInfo } from '../src/units.js';

const unit = (over: Partial<UnitInfo>): UnitInfo => ({
    unitId: 'a'.repeat(32), emmcCid: 'a'.repeat(32), fsUuid: 'u', firmwareVersion: '3.2.1',
    firstSeen: '2026-10-01T08:00:00.000Z', lastSeen: '2026-11-02T09:30:00.000Z', installed: false, ...over,
});

describe('parseArgs', () => {
    it('reads --verify full and --unit as values', () => {
        const { command, flags } = parseArgs(['write', '--firmware-dir', 'd', '--action', 'install', '--verify', 'full', '--unit', 'abc']);
        expect(command).toBe('write');
        expect(flags).toMatchObject({ 'firmware-dir': 'd', action: 'install', verify: 'full', unit: 'abc' });
    });
    it('reads a bare --allow-new-signer as true, even before another flag or at the end', () => {
        expect(parseArgs(['prepare-device', '--allow-new-signer', '--apk', 'x.apk']).flags).toMatchObject({ 'allow-new-signer': 'true', apk: 'x.apk' });
        expect(parseArgs(['prepare-device', '--apk', 'x.apk', '--allow-new-signer']).flags['allow-new-signer']).toBe('true');
    });
});

describe('formatUnits', () => {
    it('prints one line per unit with dates cut to the day and the current one marked', () => {
        const a = unit({});
        const b = unit({ unitId: 'b'.repeat(32), emmcCid: 'b'.repeat(32), installed: true });
        const lines = formatUnits([a, b], b.unitId);
        expect(lines).toEqual([
            `${a.unitId}  3.2.1  first 2026-10-01  last 2026-11-02  stock`,
            `${b.unitId}  3.2.1  first 2026-10-01  last 2026-11-02  runs Studio Pocket  (current)`,
        ]);
    });
    it('prints a legacy unit as legacy with its identity unverified', () => {
        const [line] = formatUnits([unit({ unitId: 'legacy', emmcCid: null, installed: true })], null);
        expect(line).toBe('legacy  3.2.1  first 2026-10-01  last 2026-11-02  runs Studio Pocket  (identity unverified)');
    });
    it('returns no lines for no units', () => {
        expect(formatUnits([], null)).toEqual([]);
    });
});

describe('the studio-pocket-firmware bin', () => {
    const dist = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
    const built = existsSync(dist);
    if (!built) console.warn(`skipping the bin symlink test: ${dist} is absent (run pnpm --filter @studio-pocket/firmware-tools build)`);
    it.skipIf(!built)('runs when node is pointed at a symlink to dist/cli.js, as pnpm\'s .bin shim does', () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'studio-pocket-firmware-bin-'));
        try {
            const link = path.join(dir, 'studio-pocket-firmware');
            symlinkSync(dist, link);
            const run = spawnSync(process.execPath, [link], { encoding: 'utf8' });
            expect(run.stderr).toContain('usage:');
            expect(run.status).not.toBe(0);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
    it.skipIf(!built)('mtk-check --firmware-dir finds mtkclient and the download agent, and says where it is', () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'studio-pocket-firmware-mtk-check-'));
        try {
            const da = path.join(dir, 'da.bin');
            writeFileSync(da, 'stand-in');
            const fakeMtk = fileURLToPath(new URL('./fixtures/fake-mtk.sh', import.meta.url));
            const env = { ...process.env, STUDIO_POCKET_MTK_BIN: fakeMtk, STUDIO_POCKET_DA_FILE: da, STUDIO_POCKET_DA_FILE_UNCHECKED: '1' };
            const run = spawnSync(process.execPath, [dist, 'mtk-check', '--firmware-dir', path.join(dir, 'fw')], { encoding: 'utf8', env });
            expect(run.status, run.stderr).toBe(0);
            expect(run.stdout).toContain(`mtkclient: ${fakeMtk}`);
            expect(run.stdout).toContain(`download agent: ${da}`);
            // Without the override's permission the stand-in's hash is refused, naming the expected one.
            const refused = spawnSync(process.execPath, [dist, 'mtk-check', '--firmware-dir', path.join(dir, 'fw')], { encoding: 'utf8', env: { ...env, STUDIO_POCKET_DA_FILE_UNCHECKED: '' } });
            expect(refused.status).toBe(1);
            expect(refused.stderr).toMatch(/not the expected [0-9a-f]{64}/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
