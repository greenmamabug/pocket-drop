import { type DeviceMarker } from '@studio-pocket/library-format';
import type { SyncFs } from './fs.js';
/**
 * Identifying a mounted player. It works on any directory (tests use a temp dir);
 * the commands pass the mount point of the Y2's USB volume.
 */
export interface DeviceInfo {
    root: string;
    marker: DeviceMarker | null;
    hasLibrary: boolean;
    freeBytes: number | null;
}
export declare function inspectDevice(fs: SyncFs, volume: string): Promise<DeviceInfo>;
/** Creates the root and marker if absent. Idempotent. */
export declare function ensureDeviceMarker(fs: SyncFs, volume: string, createdBy: string): Promise<DeviceMarker>;
/**
 * Write to `<file>.part` then rename over the target. On FAT this is not a true atomic
 * replace, but the window is a single directory-entry update instead of a partial file,
 * and readers never open `.part` names.
 */
export declare function writeAtomic(fs: SyncFs, file: string, data: string | Uint8Array): Promise<void>;
