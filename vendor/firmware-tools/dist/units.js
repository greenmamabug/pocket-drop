// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Ashworth Digital Ltd
// This file is part of Studio Pocket. It is licensed under GPL-3.0-only, or under a
// commercial licence from Ashworth Digital Ltd (see COPYING.commercial).
import { DEVICE_DIR, IDENTITY_FILE, InstallerError, OUT_DIR, restoreAvailableFor, STOCK_DIR, STOCK_IMAGE, UPGRADE_DIR, UPGRADE_REPORT_FILE, } from './installer.js';
import { LAYOUT_FILE } from './layout.js';
/**
 * One folder per player under the firmware dir, keyed by the eMMC CID (32 lowercase hex):
 *
 *   units/<unitId>/unit.json   who the player is (the only place the full CID is stored)
 *   units/<unitId>/device/     reports, layout, write plans and read-backs
 *   units/<unitId>/stock/      the raw read kept for restore
 *   units/<unitId>/out/        the prepared install image
 *   units/<unitId>/upgrade/    a read of the player running Studio Pocket, and its prepared upgrade
 *   current-unit               the unitId of the player read last
 *   package/                   the ROM-package flow (not per player)
 *
 * Data from before per-player folders is moved once into units/legacy/ (or package/).
 */
export const UNITS_DIR = 'units';
export const LEGACY_UNIT = 'legacy';
export const PACKAGE_DIR = 'package';
export const CURRENT_UNIT_FILE = 'current-unit';
export const UNIT_FILE = 'unit.json';
export const TMP_DIR = 'tmp';
export const isCid = (s) => /^[0-9a-f]{32}$/.test(s);
export function unitDir(p, firmwareDir, unitId) {
    return p.join(firmwareDir, UNITS_DIR, unitId);
}
export function packageDir(p, firmwareDir) {
    return p.join(firmwareDir, PACKAGE_DIR);
}
const exists = async (p, file) => (await p.stat(file)).exists;
async function readJson(p, file) {
    if (!(await exists(p, file)))
        return null;
    try {
        return JSON.parse(await p.readText(file));
    }
    catch {
        return null;
    }
}
/**
 * A unit's unit.json. A CID folder name is trusted over the file: a crash between
 * renameUnit's folder rename and its unit.json rewrite leaves units/<cid>/unit.json still
 * saying "legacy", and that unit must not vanish from listUnits until the next read.
 */
export async function readUnit(p, firmwareDir, unitId) {
    const info = await readJson(p, p.join(unitDir(p, firmwareDir, unitId), UNIT_FILE));
    if (!info)
        return null;
    if (isCid(unitId))
        return { ...info, unitId, emmcCid: info.emmcCid ?? unitId };
    return info.unitId === unitId ? info : null;
}
export async function writeUnit(p, firmwareDir, info) {
    const dir = unitDir(p, firmwareDir, info.unitId);
    await p.mkdirp(dir);
    await p.writeText(p.join(dir, UNIT_FILE), JSON.stringify(info, null, 2) + '\n');
}
/** Every unit with a readable unit.json, the one seen most recently first. */
export async function listUnits(p, firmwareDir) {
    await migrateFlatLayout(p, firmwareDir);
    const root = p.join(firmwareDir, UNITS_DIR);
    if (!(await exists(p, root)))
        return [];
    const units = [];
    for (const entry of await p.readdir(root)) {
        if (!entry.isDir)
            continue;
        const info = await readUnit(p, firmwareDir, entry.name);
        if (info)
            units.push(info);
    }
    return units.sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : a.lastSeen > b.lastSeen ? -1 : 0));
}
export async function currentUnit(p, firmwareDir) {
    const file = p.join(firmwareDir, CURRENT_UNIT_FILE);
    if (!(await exists(p, file)))
        return null;
    const id = (await p.readText(file)).trim();
    return id || null;
}
export async function setCurrentUnit(p, firmwareDir, unitId) {
    await p.mkdirp(firmwareDir);
    await p.writeText(p.join(firmwareDir, CURRENT_UNIT_FILE), unitId + '\n');
}
/** The given unit, else the current one; throws when neither exists. Ids become paths, so only a CID or "legacy" passes. */
export async function resolveUnit(p, firmwareDir, unitId) {
    const id = unitId ?? (await currentUnit(p, firmwareDir));
    if (!id)
        throw new InstallerError('no player has been read on this computer yet');
    if (!isCid(id) && id !== LEGACY_UNIT)
        throw new InstallerError(`${id} is not a player id`);
    return id;
}
/** Removes a file or a directory tree; `remove` on the desktop is not recursive. */
export async function removeTree(p, target) {
    const info = await p.stat(target);
    if (!info.exists)
        return;
    if (info.isDir) {
        for (const entry of await p.readdir(target))
            await removeTree(p, p.join(target, entry.name));
    }
    await p.remove(target);
}
/**
 * Moves `from` to `to` by renames only. When `to` already exists (a move that stopped midway),
 * the children are moved into it one by one, replacing files of the same name.
 */
async function moveInto(p, from, to) {
    const src = await p.stat(from);
    if (!src.exists)
        return;
    const dst = await p.stat(to);
    if (!dst.exists) {
        await p.mkdirp(p.dirname(to));
        await p.rename(from, to);
        return;
    }
    if (!src.isDir || !dst.isDir) {
        await p.rename(from, to);
        return;
    }
    for (const entry of await p.readdir(from))
        await moveInto(p, p.join(from, entry.name), p.join(to, entry.name));
    await p.remove(from);
}
/**
 * The flat device layout (device/ with device-identity.json, stock/, out/, upgrade/ directly
 * under the firmware dir) moves into units/legacy/. The flat upgrade/ follows only when it is
 * the same player as the stock read and not older; otherwise it is deleted (an upgrade read is
 * cheap to repeat, an original is not). device/ moves last, so a crash midway is finished by
 * the next call.
 */
async function migrateFlatDevice(p, firmwareDir) {
    const legacy = unitDir(p, firmwareDir, LEGACY_UNIT);
    const flatDevice = p.join(firmwareDir, DEVICE_DIR);
    const stockRead = await readJson(p, p.join(flatDevice, IDENTITY_FILE));
    const flatUpgrade = p.join(firmwareDir, UPGRADE_DIR);
    const upgradeRead = await readJson(p, p.join(flatUpgrade, UPGRADE_REPORT_FILE));
    let keepUpgrade = false;
    try {
        keepUpgrade = Boolean(stockRead && upgradeRead && restoreAvailableFor(stockRead, upgradeRead) && stockRead.readAt <= upgradeRead.readAt);
    }
    catch {
        keepUpgrade = false;
    }
    if (!(await readUnit(p, firmwareDir, LEGACY_UNIT))) {
        const firstSeen = stockRead?.readAt ?? new Date().toISOString();
        await writeUnit(p, firmwareDir, {
            unitId: LEGACY_UNIT,
            emmcCid: null,
            fsUuid: stockRead?.layout?.android?.uuid ?? null,
            firmwareVersion: stockRead?.identity?.manifest?.firmwareVersion ?? null,
            firstSeen,
            lastSeen: keepUpgrade ? upgradeRead.readAt : firstSeen,
            installed: keepUpgrade,
        });
    }
    await moveInto(p, p.join(firmwareDir, STOCK_DIR), p.join(legacy, STOCK_DIR));
    await moveInto(p, p.join(firmwareDir, OUT_DIR), p.join(legacy, OUT_DIR));
    if (keepUpgrade)
        await moveInto(p, flatUpgrade, p.join(legacy, UPGRADE_DIR));
    else
        await removeTree(p, flatUpgrade);
    if (!(await currentUnit(p, firmwareDir)))
        await setCurrentUnit(p, firmwareDir, LEGACY_UNIT);
    await moveInto(p, flatDevice, p.join(legacy, DEVICE_DIR));
}
/** A flat stock/ without a device identity came from a ROM package: it moves, with out/, to package/. */
async function migrateFlatPackage(p, firmwareDir) {
    const pkg = packageDir(p, firmwareDir);
    const flatStock = p.join(firmwareDir, STOCK_DIR);
    const flatOut = p.join(firmwareDir, OUT_DIR);
    // out/ alone counts only when a package move had already started (stock/ moved, then a crash).
    if (!(await exists(p, flatStock)) && !((await exists(p, flatOut)) && (await exists(p, p.join(pkg, STOCK_DIR)))))
        return false;
    await moveInto(p, flatStock, p.join(pkg, STOCK_DIR));
    await moveInto(p, flatOut, p.join(pkg, OUT_DIR));
    return true;
}
/**
 * Moves data written before per-player folders into units/legacy/ ('legacy') or package/
 * ('package'); null when there was nothing to move. Renames only; safe to call on every entry.
 */
export async function migrateFlatLayout(p, firmwareDir) {
    if (await exists(p, p.join(firmwareDir, DEVICE_DIR, IDENTITY_FILE))) {
        await migrateFlatDevice(p, firmwareDir);
        return 'legacy';
    }
    return (await migrateFlatPackage(p, firmwareDir)) ? 'package' : null;
}
/** Renames units/<from>/ to units/<to>/ (which must not exist yet) and rewrites its unit.json for the new id. */
export async function renameUnit(p, firmwareDir, from, to) {
    const target = unitDir(p, firmwareDir, to);
    if (await exists(p, target))
        throw new InstallerError(`player ${to} already has a folder`);
    const info = await readUnit(p, firmwareDir, from);
    await p.rename(unitDir(p, firmwareDir, from), target);
    if (info)
        await writeUnit(p, firmwareDir, { ...info, unitId: to });
}
/** Rewrites the unit fields of a report kept in a unit's folder (when it exists) for the player that now owns it. */
async function retagReport(p, from, to, cid) {
    const report = await readJson(p, from);
    if (!report)
        return;
    await p.writeText(to, JSON.stringify({ ...report, unitId: cid, emmcCid: cid }, null, 2) + '\n');
}
/**
 * After a successful write from the legacy unit, the player that session talked to carries
 * that original's lineage: units/legacy/ becomes units/<cid>/. When the player was read since
 * (units/<cid>/ exists), the legacy original and its reports move in only if that unit has no
 * original of its own; its upgrade/ and out/ stay; the rest of units/legacy/ is removed.
 * Until the target is complete units/legacy/ stays loadable: the reports are copied in first,
 * the image follows in one rename, and only then is units/legacy/ removed. unit.json keeps
 * the earlier firstSeen and records whether the write installed Studio Pocket; current-unit
 * names the player.
 */
export async function adoptLegacyUnit(p, firmwareDir, cid, action) {
    if (!isCid(cid))
        throw new InstallerError(`${cid} is not a player id`);
    const legacyDir = unitDir(p, firmwareDir, LEGACY_UNIT);
    const legacy = await readUnit(p, firmwareDir, LEGACY_UNIT);
    if (!(await exists(p, legacyDir)))
        return;
    const now = new Date().toISOString();
    const installed = action === 'install';
    const target = unitDir(p, firmwareDir, cid);
    const existing = await readUnit(p, firmwareDir, cid);
    if (!(await exists(p, target))) {
        await renameUnit(p, firmwareDir, LEGACY_UNIT, cid);
        for (const file of [p.join(target, DEVICE_DIR, IDENTITY_FILE), p.join(target, UPGRADE_DIR, UPGRADE_REPORT_FILE)])
            await retagReport(p, file, file, cid);
        await writeUnit(p, firmwareDir, {
            fsUuid: null, firmwareVersion: null, firstSeen: now,
            ...legacy, unitId: cid, emmcCid: cid, lastSeen: now, installed,
        });
    }
    else {
        const targetImage = p.join(target, STOCK_DIR, STOCK_IMAGE);
        if (!(await exists(p, targetImage))) {
            await p.mkdirp(p.join(target, STOCK_DIR));
            await p.mkdirp(p.join(target, DEVICE_DIR));
            await retagReport(p, p.join(legacyDir, DEVICE_DIR, IDENTITY_FILE), p.join(target, DEVICE_DIR, IDENTITY_FILE), cid);
            const layout = p.join(legacyDir, DEVICE_DIR, LAYOUT_FILE);
            if (await exists(p, layout))
                await p.copyFile(layout, p.join(target, DEVICE_DIR, LAYOUT_FILE));
            await p.rename(p.join(legacyDir, STOCK_DIR, STOCK_IMAGE), targetImage);
        }
        await removeTree(p, legacyDir);
        const firstSeen = [existing?.firstSeen, legacy?.firstSeen].filter((d) => Boolean(d)).sort()[0] ?? now;
        await writeUnit(p, firmwareDir, {
            fsUuid: legacy?.fsUuid ?? null, firmwareVersion: legacy?.firmwareVersion ?? null,
            ...existing, unitId: cid, emmcCid: cid, firstSeen, lastSeen: now, installed,
        });
    }
    await setCurrentUnit(p, firmwareDir, cid);
}
//# sourceMappingURL=units.js.map