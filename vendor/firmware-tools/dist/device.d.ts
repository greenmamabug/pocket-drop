import type { FirmwareManifest } from './manifest.js';
import type { FirmwarePlatform } from './platform.js';
/** Prefix of the identification problem raised for an image that already carries Studio Pocket. */
export declare const ALREADY_RUNS_STUDIO_POCKET = "this player already runs Studio Pocket";
/**
 * Identifies a system image read from a player: which firmware build it is, and whether the
 * stock launcher we are about to replace is the one the manifest expects. This replaces the
 * zip-hash identification of the download path: the unit's own filesystem is a different
 * ext4 generation of the same build, so only content can be compared.
 */
export interface DeviceIdentity {
    buildIncremental: string;
    /** ro.build.version.incremental without the `eng.build.` prefix: the manifest's customBuildVersion. */
    build: string;
    fingerprint: string;
    displayId: string;
    fmRadio: boolean;
    fsUuid: string;
    /** Present when the image already carries Studio Pocket (an installed or upgraded unit). */
    installedStudioPocket: {
        path: string;
        sizeBytes: number;
        sha256: string;
    } | null;
    launcher: {
        path: string;
        sizeBytes: number;
        sha256: string;
    } | null;
    manifest: FirmwareManifest | null;
    problems: string[];
}
export declare function parseBuildProp(text: string): Record<string, string>;
/** The launcher path inside the image (manifests record it with the /system mount prefix). */
export declare function launcherImagePath(manifest: FirmwareManifest | null): string;
export declare function identifyDeviceImage(p: FirmwarePlatform, image: string, manifests: FirmwareManifest[]): Promise<DeviceIdentity>;
