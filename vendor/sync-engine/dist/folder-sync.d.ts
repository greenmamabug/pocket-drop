import { type ApplyResult } from './apply.js';
export interface SyncFolderOptions {
    folder: string;
    volume: string;
    create: boolean;
    generator: string;
    copy?: (from: string, to: string) => Promise<void>;
}
export interface VolumeEnv {
    platform?: NodeJS.Platform;
    homedir?: string;
    systemDrive?: string;
    systemRoot?: string;
}
/**
 * The places that are never a player: the system drive's root, the home folder and (on Windows) the
 * Windows folder. On POSIX every filesystem root is refused. Any other Windows drive root is a valid
 * volume, because that is where the player mounts.
 */
export declare function refuseUnsafeVolume(volume: string, env?: VolumeEnv): void;
/** The stderr lines studio-pocket-sync prints after a sync: each note and cleanup warning, then how many obsolete files went. */
export declare function syncReportLines(result: Pick<ApplyResult, 'warnings' | 'cleaned'> & {
    notes: string[];
}): string[];
export declare function syncFolder(opts: SyncFolderOptions): Promise<ApplyResult & {
    notes: string[];
}>;
