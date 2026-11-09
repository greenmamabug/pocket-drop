import { type LibraryIndex } from '@studio-pocket/library-format';
import type { SyncPlan } from './plan.js';
import type { SyncFs } from './fs.js';
/**
 * Applies a plan. Order matters and is the whole point:
 *   1. Stray partial files removed (before the free-space check, so leftovers of an interrupted
 *      run count as free space); sync.lock written (a hint to the player; never blocks it).
 *   2. Removed playlists deleted (dir + state file).
 *   3. Copy: every file of every add/update is written to `<name>.part`. A file with no live
 *      predecessor (`missing`) is renamed live at once: no manifest names it yet, and it is kept
 *      if the run is interrupted. Replacements (`size`, `changed`, `hash`) stay as `.part`, so an
 *      interruption here leaves the previous version of every playlist playable (except those
 *      this run removes, which are already gone).
 *   4. Switch, per playlist: each staged `.part` renamed to its live name, then the manifest written
 *      atomically. A replacing update first writes the playlist's `update.lock`, removed after the
 *      manifest; interrupted inside these few renames, the lock stays, the player hides that
 *      playlist, and the next sync's plan sees the lock and finishes the update.
 *   5. Each playlist re-checked from disk; only complete ones go in library.json (via rename).
 *   6. sync.lock removed.
 *   7. Cleanup: in each playlist written this run, files at the playlist root and in `tracks/`
 *      and `icons/` that the new manifest does not name are removed. `state/` is never touched.
 *      Failures are reported as warnings, never thrown.
 * Untouched playlists (`keep` with `untouched`) are only re-checked for the index.
 * If the process dies anywhere, re-running planTransfer + applySync finishes the job: the old
 * library.json is still valid, `.part` files are ignored by readers and cleaned up here.
 */
export interface ApplyOptions {
    generator: string;
    /** Called after every file (and during large copies when the fs reports progress); return false to abort. */
    onProgress?: (event: ProgressEvent) => boolean | void;
    /** Test hook: throw inside to simulate an interruption mid-copy. */
    copy?: (from: string, to: string) => Promise<void>;
    freeBytes?: (dir: string) => Promise<number | null>;
    /** Safety margin kept free on the volume. */
    reserveBytes?: number;
}
export interface ProgressEvent {
    playlistId: string;
    file: string;
    bytesDone: number;
    bytesTotal: number;
    /** True once the file named in `file` is fully written (a replacement stays `.part` until the switch). */
    fileDone: boolean;
}
export interface ApplyResult {
    index: LibraryIndex;
    written: string[];
    removed: string[];
    skipped: {
        id: string;
        problems: string[];
    }[];
    /** Cleanup failures (one message each); the sync itself succeeded. */
    warnings: string[];
    /** Absolute paths of obsolete files removed after the index was written. */
    cleaned: string[];
}
export declare class SyncError extends Error {
}
export declare class InsufficientStorageError extends SyncError {
}
export declare class SyncAborted extends SyncError {
}
export declare function applySync(fs: SyncFs, plan: SyncPlan, options: ApplyOptions): Promise<ApplyResult>;
