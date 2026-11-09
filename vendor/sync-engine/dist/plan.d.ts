import { LIBRARY_FILE, PLAYLIST_MANIFEST_FILE, STATE_DIR, type LibraryCheck, type PlaylistManifest } from '@studio-pocket/library-format';
import type { SourcePlaylist } from './source.js';
import { type SyncFs } from './fs.js';
/**
 * A transfer plan is a pure description of what will change. The desktop shows it before
 * anything is written ("3 playlists to add, 1 to update, 2 to remove, 128 MB to copy").
 */
export type FileAction = {
    kind: 'copy';
    from: string;
    to: string;
    bytes: number;
    reason: 'missing' | 'size' | 'hash' | 'changed';
} | {
    kind: 'keep';
    to: string;
    bytes: number;
};
export interface PlaylistAction {
    id: string;
    title: string;
    kind: 'add' | 'update' | 'keep' | 'remove';
    files: FileAction[];
    manifest: PlaylistManifest | null;
    manifestBytes: Uint8Array | null;
    bytesToCopy: number;
    /** On the player but not part of this transfer: left exactly as it is. */
    untouched?: true;
}
export interface SyncPlan {
    root: string;
    playlists: PlaylistAction[];
    bytesToCopy: number;
    /** Stray `.part` files and unknown directories to clean. */
    stray: string[];
    deviceState: LibraryCheck;
}
/**
 * Canonical bytes for a manifest: run through the validator so key order is fixed, which makes
 * "same content" comparisons stable no matter who built the object. Throws on an invalid manifest,
 * so nothing unparseable is ever written to a device.
 */
export declare function serializeManifest(manifest: PlaylistManifest): Uint8Array;
/** What to do on the player: send these playlists, remove these ids. Everything else is left exactly as it is. */
export interface TransferRequest {
    send: SourcePlaylist[];
    remove: string[];
}
/**
 * Plans a transfer. Sent playlists are added, updated or kept file by file; ids in `remove` are
 * deleted; every other playlist on the player (complete, incomplete or an unlisted directory) gets
 * a `keep` action with no file work, so it is never touched and stays in the index when complete.
 */
export declare function planTransfer(fs: SyncFs, root: string, request: TransferRequest, options?: {
    verifyHashes?: boolean;
}): Promise<SyncPlan>;
export declare function describePlan(plan: SyncPlan): string;
export { LIBRARY_FILE, PLAYLIST_MANIFEST_FILE, STATE_DIR };
