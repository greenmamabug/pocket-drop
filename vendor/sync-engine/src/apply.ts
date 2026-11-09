// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Ashworth Digital Ltd
// This file is part of Studio Pocket. It is licensed under GPL-3.0-only, or under a
// commercial licence from Ashworth Digital Ltd (see COPYING.commercial).

import {
    FORMAT_VERSION, ICONS_DIR, LIBRARY_FILE, LIBRARY_FORMAT, PARTIAL_SUFFIX, PLAYLISTS_DIR, PLAYLIST_MANIFEST_FILE, PLAYLIST_UPDATE_LOCK_FILE, STATE_DIR, SYNC_LOCK_FILE, TRACKS_DIR,
    checkPlaylistDir, type LibraryIndex, type LibraryIndexEntry,
} from '@studio-pocket/library-format';
import { writeAtomic } from './device.js';
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
    skipped: { id: string; problems: string[] }[];
    /** Cleanup failures (one message each); the sync itself succeeded. */
    warnings: string[];
    /** Absolute paths of obsolete files removed after the index was written. */
    cleaned: string[];
}

export class SyncError extends Error {}
export class InsufficientStorageError extends SyncError {}
export class SyncAborted extends SyncError {}

export async function applySync(fs: SyncFs, plan: SyncPlan, options: ApplyOptions): Promise<ApplyResult> {
    const root = plan.root;
    for (const stray of plan.stray) await fs.remove(stray, true);
    const free = await (options.freeBytes ?? fs.freeBytes)(root);
    const reserve = options.reserveBytes ?? 16 * 1024 * 1024;
    const reclaim = 0; // removals free space, but FAT frees lazily; do not count on it.
    if (free !== null && plan.bytesToCopy + reserve > free + reclaim) {
        throw new InsufficientStorageError(`need ${plan.bytesToCopy} bytes plus ${reserve} reserve, volume has ${free} free`);
    }

    await fs.mkdirp(fs.join(root, PLAYLISTS_DIR));
    await fs.mkdirp(fs.join(root, STATE_DIR));
    await fs.writeFile(fs.join(root, SYNC_LOCK_FILE), `${options.generator} ${new Date().toISOString()}\n`);

    const removed: string[] = [];
    for (const action of plan.playlists.filter((p) => p.kind === 'remove')) {
        await fs.remove(fs.join(root, PLAYLISTS_DIR, action.id), true);
        await fs.remove(fs.join(root, STATE_DIR, `${action.id}.json`), false);
        removed.push(action.id);
    }

    const updates = plan.playlists.filter((p) => p.kind === 'add' || p.kind === 'update');
    let bytesDone = 0;
    for (const action of updates) {
        const dir = fs.join(root, PLAYLISTS_DIR, action.id);
        await fs.mkdirp(fs.join(dir, TRACKS_DIR));
        if (action.manifest?.tracks.some((t) => t.icon)) await fs.mkdirp(fs.join(dir, ICONS_DIR));
        for (const file of action.files) {
            if (file.kind !== 'copy') continue;
            const partial = file.to + PARTIAL_SUFFIX;
            const rel = fs.relative(root, file.to);
            let aborted = false;
            if (options.copy) await options.copy(file.from, partial);
            else await fs.copyFile(file.from, partial, (bytes) => {
                if (options.onProgress?.({ playlistId: action.id, file: rel, bytesDone: bytesDone + Math.min(bytes, file.bytes), bytesTotal: plan.bytesToCopy, fileDone: false }) === false) aborted = true;
            });
            if (aborted) throw new SyncAborted('aborted by caller');
            if (file.reason === 'missing') await fs.rename(partial, file.to);
            bytesDone += file.bytes;
            const cont = options.onProgress?.({ playlistId: action.id, file: rel, bytesDone, bytesTotal: plan.bytesToCopy, fileDone: true });
            if (cont === false) throw new SyncAborted('aborted by caller');
        }
    }

    const written: string[] = [];
    for (const action of updates) {
        const replacements = action.files.filter((f) => f.kind === 'copy' && f.reason !== 'missing');
        // Marks the playlist while live files are being replaced: readers hide it until the manifest is written.
        if (replacements.length > 0) await fs.writeFile(fs.join(root, PLAYLISTS_DIR, action.id, PLAYLIST_UPDATE_LOCK_FILE), new Date().toISOString() + '\n');
        for (const file of action.files) {
            if (file.kind === 'copy' && file.reason !== 'missing') await fs.rename(file.to + PARTIAL_SUFFIX, file.to);
        }
        await writeAtomic(fs, fs.join(root, PLAYLISTS_DIR, action.id, PLAYLIST_MANIFEST_FILE), action.manifestBytes!);
        // Removed for every add/update, so a marker left by an interrupted run is cleared even when this one wrote none.
        await fs.remove(fs.join(root, PLAYLISTS_DIR, action.id, PLAYLIST_UPDATE_LOCK_FILE), false);
        written.push(action.id);
    }

    // Build the index only from what is actually complete on disk now.
    const entries: LibraryIndexEntry[] = [];
    const skipped: ApplyResult['skipped'] = [];
    for (const action of plan.playlists.filter((p) => p.kind !== 'remove')) {
        const dir = fs.join(root, PLAYLISTS_DIR, action.id);
        const check = await checkPlaylistDir(fs, dir, { id: action.id });
        if (!check.ok || !check.manifest) { skipped.push({ id: action.id, problems: check.problems }); continue; }
        entries.push({
            id: action.id, title: check.manifest.title, dir: `${PLAYLISTS_DIR}/${action.id}`,
            trackCount: check.manifest.tracks.length, totalBytes: check.manifest.tracks.reduce((n, t) => n + t.sizeBytes, 0), manifestSha256: await fs.sha256File(fs.join(dir, PLAYLIST_MANIFEST_FILE)),
        });
    }
    const index: LibraryIndex = { format: LIBRARY_FORMAT, formatVersion: FORMAT_VERSION, generatedAt: new Date().toISOString(), generator: options.generator, playlists: entries };
    await writeAtomic(fs, fs.join(root, LIBRARY_FILE), JSON.stringify(index, null, 2) + '\n');
    await fs.remove(fs.join(root, SYNC_LOCK_FILE), false);

    const warnings: string[] = [];
    const cleaned: string[] = [];
    for (const action of updates) {
        const dir = fs.join(root, PLAYLISTS_DIR, action.id);
        const manifest = action.manifest!;
        // Compared case-insensitively: on FAT/exFAT/APFS a case-only rename keeps the old-case
        // name on disk, which the plan already accepted as the referenced file.
        const keep = new Set([PLAYLIST_MANIFEST_FILE, ...[manifest.cover, manifest.icon, ...manifest.tracks.flatMap((t) => [t.file, t.icon])].filter((f): f is string => !!f)].map((f) => f.toLowerCase()));
        for (const sub of ['', TRACKS_DIR, ICONS_DIR]) {
            const subDir = sub ? fs.join(dir, sub) : dir;
            let entries: { name: string; isDir: boolean }[];
            try {
                entries = await fs.readdir(subDir);
            } catch (e) {
                warnings.push(`could not list ${subDir}: ${(e as Error).message}`);
                continue;
            }
            for (const entry of entries) {
                if (entry.isDir || keep.has((sub ? `${sub}/${entry.name}` : entry.name).toLowerCase())) continue;
                const file = fs.join(subDir, entry.name);
                try {
                    await fs.remove(file, false);
                    cleaned.push(file);
                } catch (e) {
                    warnings.push(`could not remove ${file}: ${(e as Error).message}`);
                }
            }
        }
    }
    return { index, written, removed, skipped, warnings, cleaned };
}
