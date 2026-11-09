import { type GroupsFile, type LibraryIndex, type LibraryIndexEntry, type PlaylistManifest, type RecentFile } from './types.js';
import type { LibraryFs } from './fs.js';
/**
 * Completeness rules shared by the desktop (after a sync) and the player (on load):
 * a playlist is usable only if its manifest parses, every track file exists with exactly
 * the declared size, and (when asked) hashes match. Anything else is reported, not shown.
 * The functions take a LibraryFs so they run under Node (tests, CLI) and inside the
 * desktop webview (Tauri commands) unchanged.
 */
export interface PlaylistCheck {
    id: string;
    ok: boolean;
    manifest: PlaylistManifest | null;
    problems: string[];
}
export interface LibraryCheck {
    index: LibraryIndex | null;
    syncLockPresent: boolean;
    playlists: PlaylistCheck[];
    /** null when groups.json is absent or invalid; an invalid one is a non-fatal problem and hides nothing. */
    groups: GroupsFile | null;
    /** null when recent.json is absent (nothing played yet) or invalid (non-fatal). */
    recent: RecentFile | null;
    problems: string[];
}
export declare function checkPlaylistDir(fs: LibraryFs, dir: string, entry: Pick<LibraryIndexEntry, 'id'> & Partial<LibraryIndexEntry>, options?: {
    verifyHashes?: boolean;
}): Promise<PlaylistCheck>;
export declare function checkLibrary(fs: LibraryFs, root: string, options?: {
    verifyHashes?: boolean;
}): Promise<LibraryCheck>;
