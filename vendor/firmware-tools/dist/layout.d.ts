import { type Ext4Superblock } from './ext4.js';
import { type FirmwareManifest } from './manifest.js';
import type { FirmwarePlatform } from './platform.js';
/**
 * Where the system partition really is on a unit, measured from the device itself.
 *
 * Why: the archive scatter is not necessarily the unit's layout (the tested Y2 has ANDROID
 * 0x880000 before the scatter's linear address), partition names are not available
 * (no PMT, no MBR mtkclient can parse), and mtkclient addresses are linear user-area
 * offsets. So the read reads a window that certainly contains the partition, finds the
 * system ext4 superblock in it, and only trusts the result for a write when the NEXT
 * partition's superblock (CACHE is ext4 on the Y2) sits exactly where the system filesystem
 * ends. Two independent markers, or no write.
 */
export declare const LAYOUT_FILE = "device-layout.json";
export declare const DEFAULT_SCAN_ALIGN = 65536;
export declare const DEFAULT_MAX_SCAN: number;
export interface ReadWindow {
    /** Linear address where the read starts. */
    start: number;
    length: number;
}
/**
 * The window a first read on an unknown unit covers: from `linearAddressOffset` before the
 * scatter's ANDROID (linear) address up to the scatter's CACHE (linear) address. For the
 * Y2 manifests that is 0x5180000 + 0x34800000: any layout where ANDROID moved up to
 * 0x1400000 earlier than the scatter says is captured together with its end marker.
 */
export declare function windowForManifest(manifest: FirmwareManifest): ReadWindow;
export interface SystemFsHit {
    /** Offset of the filesystem inside the scanned file. */
    offset: number;
    superblock: Ext4Superblock;
}
export interface ScanOptions {
    align?: number;
    maxScan?: number;
}
/** First ext4 superblock at `align` boundaries within the first `maxScan` bytes of `file`. */
export declare function findSystemFs(p: FirmwarePlatform, file: string, options?: ScanOptions): Promise<SystemFsHit | null>;
export interface DeviceLayout {
    measured: string;
    method: string;
    windowStart: number;
    android: {
        start: number;
        size: number;
        end: number;
        uuid: string;
        blocks: number;
        blockSize: number;
        mountCount: number;
    };
    /** The partition that starts exactly at android.end (CACHE on the Y2), when its superblock is there. */
    endMarker: {
        start: number;
        size: number;
        uuid: string;
    } | null;
    trustedForWrite: boolean;
    /** The same numbers as hex strings, for humans reading the JSON. */
    hex: {
        androidStart: string;
        androidSize: string;
        androidEnd: string;
    };
}
export declare class LayoutError extends Error {
}
/**
 * Measures the system partition inside `windowFile` (a read that started at linear address
 * `windowStart`). Throws LayoutError when no ext4 superblock is found; `trustedForWrite` is
 * false when the end marker is missing (the read was too short, or the layout is not the one
 * this tool understands).
 */
export declare function measureLayout(p: FirmwarePlatform, windowFile: string, windowStart: number, options?: ScanOptions): Promise<DeviceLayout>;
export declare function writeLayout(p: FirmwarePlatform, dir: string, layout: DeviceLayout): Promise<string>;
export declare function readLayout(p: FirmwarePlatform, dir: string): Promise<DeviceLayout | null>;
