// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Ashworth Digital Ltd
// This file is part of Studio Pocket. It is licensed under GPL-3.0-only, or under a
// commercial licence from Ashworth Digital Ltd (see COPYING.commercial).

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nodePlatform as p } from '../src/node.js';
import { readInstallRecord } from '../src/installer.js';
import { currentUnit, isCid, listUnits, migrateFlatLayout, readUnit, resolveUnit, setCurrentUnit, unitDir, writeUnit, type UnitInfo } from '../src/units.js';

async function put(file: string, text: string): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
}

const android = (uuid: string) => ({ android: { uuid, start: 0x580000, size: 0x1800000 } });

/** A flat (pre-units) device layout: stock read, its prepared image, an upgrade read. */
async function flatDeviceLayout(dir: string, upgradeUuid: string, upgradeReadAt = '2026-10-25T10:00:00.000Z'): Promise<void> {
    await put(path.join(dir, 'stock/system.img'), 'A');
    await put(path.join(dir, 'device/device-identity.json'), JSON.stringify({ readAt: '2026-10-20T09:00:00.000Z', state: 'stock', layout: android('u1'), identity: { manifest: { firmwareVersion: '3.2.0-fm' } } }));
    await put(path.join(dir, 'device/device-layout.json'), '{}');
    await put(path.join(dir, 'out/build-report.json'), '{}');
    await put(path.join(dir, 'upgrade/read-report.json'), JSON.stringify({ readAt: upgradeReadAt, state: 'studiopocket', layout: android(upgradeUuid) }));
    await put(path.join(dir, 'upgrade/system.img'), 'B');
}

const unit = (unitId: string, lastSeen: string): UnitInfo => ({ unitId, emmcCid: unitId, fsUuid: 'u', firmwareVersion: '3.2.0-fm', firstSeen: '2026-10-01T00:00:00.000Z', lastSeen, installed: false });

describe('per-player firmware folders', () => {
    let dir: string;
    beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'myo units-')); });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

    it('recognises a CID', () => {
        expect(isCid('1500aa0100a1b2c3d4e5f6012345abcd')).toBe(true);
        expect(isCid('1500AA0100A1B2C3D4E5F6012345ABCD')).toBe(false);
        expect(isCid('legacy')).toBe(false);
        expect(unitDir(p, dir, 'legacy')).toBe(path.join(dir, 'units', 'legacy'));
    });

    it('migrates a flat device layout into units/legacy once', async () => {
        await flatDeviceLayout(dir, 'u1');
        expect(await migrateFlatLayout(p, dir)).toBe('legacy');
        expect(await readUnit(p, dir, 'legacy')).toMatchObject({ unitId: 'legacy', emmcCid: null, fsUuid: 'u1', firmwareVersion: '3.2.0-fm', firstSeen: '2026-10-20T09:00:00.000Z', lastSeen: '2026-10-25T10:00:00.000Z', installed: true });
        expect(await readFile(path.join(dir, 'units/legacy/stock/system.img'), 'utf8')).toBe('A');
        expect(existsSync(path.join(dir, 'units/legacy/device/device-identity.json'))).toBe(true);
        expect(existsSync(path.join(dir, 'units/legacy/out/build-report.json'))).toBe(true);
        expect(existsSync(path.join(dir, 'units/legacy/upgrade/read-report.json'))).toBe(true);
        for (const flat of ['stock', 'device', 'out', 'upgrade']) expect(existsSync(path.join(dir, flat))).toBe(false);
        expect(await currentUnit(p, dir)).toBe('legacy');
        expect(await migrateFlatLayout(p, dir)).toBeNull(); // idempotent
        expect(await readFile(path.join(dir, 'units/legacy/stock/system.img'), 'utf8')).toBe('A');
    });

    it('drops a flat upgrade read that belongs to another unit', async () => {
        await flatDeviceLayout(dir, 'u2');
        expect(await migrateFlatLayout(p, dir)).toBe('legacy');
        expect(existsSync(path.join(dir, 'units/legacy/upgrade'))).toBe(false);
        expect(existsSync(path.join(dir, 'upgrade'))).toBe(false);
        expect(await readUnit(p, dir, 'legacy')).toMatchObject({ lastSeen: '2026-10-20T09:00:00.000Z', installed: false });
    });

    it('drops a flat upgrade read older than the stock read', async () => {
        await flatDeviceLayout(dir, 'u1', '2026-10-19T09:00:00.000Z');
        await migrateFlatLayout(p, dir);
        expect(existsSync(path.join(dir, 'units/legacy/upgrade'))).toBe(false);
    });

    it('finishes a migration that stopped midway', async () => {
        await flatDeviceLayout(dir, 'u1');
        // stock/ already moved, then the process died.
        await mkdir(path.join(dir, 'units/legacy'), { recursive: true });
        await p.rename(path.join(dir, 'stock'), path.join(dir, 'units/legacy/stock'));
        expect(await migrateFlatLayout(p, dir)).toBe('legacy');
        expect(existsSync(path.join(dir, 'units/legacy/stock/system.img'))).toBe(true);
        expect(existsSync(path.join(dir, 'units/legacy/device/device-identity.json'))).toBe(true);
        expect(existsSync(path.join(dir, 'device'))).toBe(false);
    });

    it('does not take over a current unit that is already set', async () => {
        await setCurrentUnit(p, dir, '1500aa0100a1b2c3d4e5f6012345abcd');
        await flatDeviceLayout(dir, 'u1');
        await migrateFlatLayout(p, dir);
        expect(await currentUnit(p, dir)).toBe('1500aa0100a1b2c3d4e5f6012345abcd');
    });

    it('moves a flat stock/ without device identity into package/', async () => {
        await put(path.join(dir, 'stock/system.img'), 'P');
        await put(path.join(dir, 'stock/MT6582_Android_scatter.txt'), 'scatter');
        await put(path.join(dir, 'out/build-report.json'), '{}');
        expect(await migrateFlatLayout(p, dir)).toBe('package');
        expect(await readFile(path.join(dir, 'package/stock/system.img'), 'utf8')).toBe('P');
        expect(existsSync(path.join(dir, 'package/stock/MT6582_Android_scatter.txt'))).toBe(true);
        expect(existsSync(path.join(dir, 'package/out/build-report.json'))).toBe(true);
        expect(existsSync(path.join(dir, 'units'))).toBe(false);
        expect(existsSync(path.join(dir, 'stock'))).toBe(false);
        expect(await currentUnit(p, dir)).toBeNull();
        expect(await migrateFlatLayout(p, dir)).toBeNull();
    });

    it('does nothing on an empty or already migrated firmware dir', async () => {
        expect(await migrateFlatLayout(p, dir)).toBeNull();
        expect(await migrateFlatLayout(p, path.join(dir, 'missing'))).toBeNull();
        expect(await listUnits(p, dir)).toEqual([]);
    });

    it('lists units newest first and resolves the current one', async () => {
        const a = '1500aa0100a1b2c3d4e5f6012345abcd';
        const b = '1500aa0100a1b2c3d4e5f6012345abce';
        await writeUnit(p, dir, unit(a, '2026-10-20T00:00:00.000Z'));
        await writeUnit(p, dir, unit(b, '2026-11-01T00:00:00.000Z'));
        await mkdir(path.join(dir, 'units', 'half-made'), { recursive: true }); // no unit.json: not listed
        expect((await listUnits(p, dir)).map((u) => u.unitId)).toEqual([b, a]);
        await expect(resolveUnit(p, dir)).rejects.toThrow('no player has been read on this computer yet');
        await setCurrentUnit(p, dir, a);
        expect(await currentUnit(p, dir)).toBe(a);
        expect(await resolveUnit(p, dir)).toBe(a);
        expect(await resolveUnit(p, dir, b)).toBe(b);
        expect(await resolveUnit(p, dir, 'legacy')).toBe('legacy');
        await expect(resolveUnit(p, dir, '../stock')).rejects.toThrow(/not a player id/);
    });

    it('trusts a CID folder name over a unit.json left saying legacy by an interrupted rename', async () => {
        const cid = '1500aa0100a1b2c3d4e5f6012345abcd';
        await put(path.join(unitDir(p, dir, cid), 'unit.json'), JSON.stringify({ ...unit('legacy', '2026-11-01T00:00:00.000Z'), emmcCid: null }));
        expect(await readUnit(p, dir, cid)).toMatchObject({ unitId: cid, emmcCid: cid, lastSeen: '2026-11-01T00:00:00.000Z' });
        expect((await listUnits(p, dir)).map((u) => u.unitId)).toEqual([cid]);
        // A non-CID folder still has to match its file.
        await put(path.join(unitDir(p, dir, 'legacy'), 'unit.json'), JSON.stringify(unit(cid, '2026-11-01T00:00:00.000Z')));
        expect(await readUnit(p, dir, 'legacy')).toBeNull();
    });

    it('listUnits and readInstallRecord migrate first', async () => {
        await flatDeviceLayout(dir, 'u1');
        expect((await listUnits(p, dir)).map((u) => u.unitId)).toEqual(['legacy']);
        await rm(dir, { recursive: true, force: true });
        await flatDeviceLayout(dir, 'u1');
        expect(await readInstallRecord(p, dir)).toEqual([]);
        expect(existsSync(path.join(dir, 'units/legacy/stock/system.img'))).toBe(true);
    });
});
