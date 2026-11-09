// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Ashworth Digital Ltd
// This file is part of Studio Pocket. It is licensed under GPL-3.0-only, or under a
// commercial licence from Ashworth Digital Ltd (see COPYING.commercial).
import { FORMAT_VERSION, ICONS_DIR, LIBRARY_FILE, LIBRARY_FORMAT, PARTIAL_SUFFIX, PLAYLISTS_DIR, PLAYLIST_MANIFEST_FILE, PLAYLIST_UPDATE_LOCK_FILE, STATE_DIR, SYNC_LOCK_FILE, TRACKS_DIR, checkPlaylistDir, } from '@studio-pocket/library-format';
import { writeAtomic } from './device.js';
export class SyncError extends Error {
}
export class InsufficientStorageError extends SyncError {
}
export class SyncAborted extends SyncError {
}
export async function applySync(fs, plan, options) {
    const root = plan.root;
    for (const stray of plan.stray)
        await fs.remove(stray, true);
    const free = await (options.freeBytes ?? fs.freeBytes)(root);
    const reserve = options.reserveBytes ?? 16 * 1024 * 1024;
    const reclaim = 0; // removals free space, but FAT frees lazily; do not count on it.
    if (free !== null && plan.bytesToCopy + reserve > free + reclaim) {
        throw new InsufficientStorageError(`need ${plan.bytesToCopy} bytes plus ${reserve} reserve, volume has ${free} free`);
    }
    await fs.mkdirp(fs.join(root, PLAYLISTS_DIR));
    await fs.mkdirp(fs.join(root, STATE_DIR));
    await fs.writeFile(fs.join(root, SYNC_LOCK_FILE), `${options.generator} ${new Date().toISOString()}\n`);
    const removed = [];
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
        if (action.manifest?.tracks.some((t) => t.icon))
            await fs.mkdirp(fs.join(dir, ICONS_DIR));
        for (const file of action.files) {
            if (file.kind !== 'copy')
                continue;
            const partial = file.to + PARTIAL_SUFFIX;
            const rel = fs.relative(root, file.to);
            let aborted = false;
            if (options.copy)
                await options.copy(file.from, partial);
            else
                await fs.copyFile(file.from, partial, (bytes) => {
                    if (options.onProgress?.({ playlistId: action.id, file: rel, bytesDone: bytesDone + Math.min(bytes, file.bytes), bytesTotal: plan.bytesToCopy, fileDone: false }) === false)
                        aborted = true;
                });
            if (aborted)
                throw new SyncAborted('aborted by caller');
            if (file.reason === 'missing')
                await fs.rename(partial, file.to);
            bytesDone += file.bytes;
            const cont = options.onProgress?.({ playlistId: action.id, file: rel, bytesDone, bytesTotal: plan.bytesToCopy, fileDone: true });
            if (cont === false)
                throw new SyncAborted('aborted by caller');
        }
    }
    const written = [];
    for (const action of updates) {
        const replacements = action.files.filter((f) => f.kind === 'copy' && f.reason !== 'missing');
        // Marks the playlist while live files are being replaced: readers hide it until the manifest is written.
        if (replacements.length > 0)
            await fs.writeFile(fs.join(root, PLAYLISTS_DIR, action.id, PLAYLIST_UPDATE_LOCK_FILE), new Date().toISOString() + '\n');
        for (const file of action.files) {
            if (file.kind === 'copy' && file.reason !== 'missing')
                await fs.rename(file.to + PARTIAL_SUFFIX, file.to);
        }
        await writeAtomic(fs, fs.join(root, PLAYLISTS_DIR, action.id, PLAYLIST_MANIFEST_FILE), action.manifestBytes);
        // Removed for every add/update, so a marker left by an interrupted run is cleared even when this one wrote none.
        await fs.remove(fs.join(root, PLAYLISTS_DIR, action.id, PLAYLIST_UPDATE_LOCK_FILE), false);
        written.push(action.id);
    }
    // Build the index only from what is actually complete on disk now.
    const entries = [];
    const skipped = [];
    for (const action of plan.playlists.filter((p) => p.kind !== 'remove')) {
        const dir = fs.join(root, PLAYLISTS_DIR, action.id);
        const check = await checkPlaylistDir(fs, dir, { id: action.id });
        if (!check.ok || !check.manifest) {
            skipped.push({ id: action.id, problems: check.problems });
            continue;
        }
        entries.push({
            id: action.id, title: check.manifest.title, dir: `${PLAYLISTS_DIR}/${action.id}`,
            trackCount: check.manifest.tracks.length, totalBytes: check.manifest.tracks.reduce((n, t) => n + t.sizeBytes, 0), manifestSha256: await fs.sha256File(fs.join(dir, PLAYLIST_MANIFEST_FILE)),
        });
    }
    const index = { format: LIBRARY_FORMAT, formatVersion: FORMAT_VERSION, generatedAt: new Date().toISOString(), generator: options.generator, playlists: entries };
    await writeAtomic(fs, fs.join(root, LIBRARY_FILE), JSON.stringify(index, null, 2) + '\n');
    await fs.remove(fs.join(root, SYNC_LOCK_FILE), false);
    const warnings = [];
    const cleaned = [];
    for (const action of updates) {
        const dir = fs.join(root, PLAYLISTS_DIR, action.id);
        const manifest = action.manifest;
        // Compared case-insensitively: on FAT/exFAT/APFS a case-only rename keeps the old-case
        // name on disk, which the plan already accepted as the referenced file.
        const keep = new Set([PLAYLIST_MANIFEST_FILE, ...[manifest.cover, manifest.icon, ...manifest.tracks.flatMap((t) => [t.file, t.icon])].filter((f) => !!f)].map((f) => f.toLowerCase()));
        for (const sub of ['', TRACKS_DIR, ICONS_DIR]) {
            const subDir = sub ? fs.join(dir, sub) : dir;
            let entries;
            try {
                entries = await fs.readdir(subDir);
            }
            catch (e) {
                warnings.push(`could not list ${subDir}: ${e.message}`);
                continue;
            }
            for (const entry of entries) {
                if (entry.isDir || keep.has((sub ? `${sub}/${entry.name}` : entry.name).toLowerCase()))
                    continue;
                const file = fs.join(subDir, entry.name);
                try {
                    await fs.remove(file, false);
                    cleaned.push(file);
                }
                catch (e) {
                    warnings.push(`could not remove ${file}: ${e.message}`);
                }
            }
        }
    }
    return { index, written, removed, skipped, warnings, cleaned };
}
//# sourceMappingURL=apply.js.map