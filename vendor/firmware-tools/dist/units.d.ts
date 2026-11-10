import type { FirmwarePlatform } from './platform.js';
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
export declare const UNITS_DIR = "units";
export declare const LEGACY_UNIT = "legacy";
export declare const PACKAGE_DIR = "package";
export declare const CURRENT_UNIT_FILE = "current-unit";
export declare const UNIT_FILE = "unit.json";
export declare const TMP_DIR = "tmp";
export interface UnitInfo {
    unitId: string;
    emmcCid: string | null;
    fsUuid: string | null;
    firmwareVersion: string | null;
    firstSeen: string;
    lastSeen: string;
    installed: boolean;
}
export declare const isCid: (s: string) => boolean;
export declare function unitDir(p: FirmwarePlatform, firmwareDir: string, unitId: string): string;
export declare function packageDir(p: FirmwarePlatform, firmwareDir: string): string;
/**
 * A unit's unit.json. A CID folder name is trusted over the file: a crash between
 * renameUnit's folder rename and its unit.json rewrite leaves units/<cid>/unit.json still
 * saying "legacy", and that unit must not vanish from listUnits until the next read.
 */
export declare function readUnit(p: FirmwarePlatform, firmwareDir: string, unitId: string): Promise<UnitInfo | null>;
export declare function writeUnit(p: FirmwarePlatform, firmwareDir: string, info: UnitInfo): Promise<void>;
/** Every unit with a readable unit.json, the one seen most recently first. */
export declare function listUnits(p: FirmwarePlatform, firmwareDir: string): Promise<UnitInfo[]>;
export declare function currentUnit(p: FirmwarePlatform, firmwareDir: string): Promise<string | null>;
export declare function setCurrentUnit(p: FirmwarePlatform, firmwareDir: string, unitId: string): Promise<void>;
/** The given unit, else the current one; throws when neither exists. Ids become paths, so only a CID or "legacy" passes. */
export declare function resolveUnit(p: FirmwarePlatform, firmwareDir: string, unitId?: string): Promise<string>;
/** Removes a file or a directory tree; `remove` on the desktop is not recursive. */
export declare function removeTree(p: FirmwarePlatform, target: string): Promise<void>;
/**
 * Moves data written before per-player folders into units/legacy/ ('legacy') or package/
 * ('package'); null when there was nothing to move. Renames only; safe to call on every entry.
 */
export declare function migrateFlatLayout(p: FirmwarePlatform, firmwareDir: string): Promise<'legacy' | 'package' | null>;
/** Renames units/<from>/ to units/<to>/ (which must not exist yet) and rewrites its unit.json for the new id. */
export declare function renameUnit(p: FirmwarePlatform, firmwareDir: string, from: string, to: string): Promise<void>;
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
export declare function adoptLegacyUnit(p: FirmwarePlatform, firmwareDir: string, cid: string, action: 'install' | 'restore'): Promise<void>;
