// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Ashworth Digital Ltd
// This file is part of Studio Pocket. It is licensed under GPL-3.0-only, or under a
// commercial licence from Ashworth Digital Ltd (see COPYING.commercial).
import { FormatError, parseWith, validateGroups, validateLibraryIndex, validatePlaylistManifest, validateRecent } from './validate.js';
import { GROUPS_FILE, LIBRARY_FILE, PLAYLIST_MANIFEST_FILE, PLAYLIST_UPDATE_LOCK_FILE, RECENT_FILE, SYNC_LOCK_FILE, } from './types.js';
export async function checkPlaylistDir(fs, dir, entry, options = {}) {
    const problems = [];
    let manifest = null;
    const manifestPath = fs.join(dir, PLAYLIST_MANIFEST_FILE);
    try {
        manifest = parseWith(validatePlaylistManifest, await fs.readText(manifestPath), `${entry.id}/manifest.json`);
    }
    catch (error) {
        problems.push(error instanceof FormatError ? error.message : `manifest unreadable: ${error.message}`);
        return { id: entry.id, ok: false, manifest: null, problems };
    }
    if ((await fs.stat(fs.join(dir, PLAYLIST_UPDATE_LOCK_FILE))).exists)
        problems.push('update interrupted (update.lock present)');
    if (manifest.id !== entry.id)
        problems.push(`manifest id ${manifest.id} != ${entry.id}`);
    if (entry.manifestSha256) {
        const actual = await fs.sha256File(manifestPath);
        if (actual !== entry.manifestSha256)
            problems.push('manifest hash does not match library index');
    }
    if (entry.trackCount !== undefined && entry.trackCount !== manifest.tracks.length)
        problems.push(`trackCount ${entry.trackCount} != ${manifest.tracks.length}`);
    for (const track of manifest.tracks) {
        const file = fs.join(dir, track.file);
        const info = await fs.stat(file);
        if (!info.exists) {
            problems.push(`missing ${track.file}`);
            continue;
        }
        if (info.size !== track.sizeBytes) {
            problems.push(`${track.file} is ${info.size} B, expected ${track.sizeBytes}`);
            continue;
        }
        if (options.verifyHashes && (await fs.sha256File(file)) !== track.sha256)
            problems.push(`${track.file} hash mismatch`);
    }
    for (const art of [manifest.cover, manifest.icon, ...manifest.tracks.map((t) => t.icon ?? null)]) {
        if (art && !(await fs.stat(fs.join(dir, ...art.split('/')))).exists)
            problems.push(`missing artwork ${art} (non-fatal)`);
    }
    const fatal = problems.filter((p) => !p.endsWith('(non-fatal)'));
    return { id: entry.id, ok: fatal.length === 0, manifest, problems };
}
export async function checkLibrary(fs, root, options = {}) {
    const problems = [];
    let index = null;
    try {
        index = parseWith(validateLibraryIndex, await fs.readText(fs.join(root, LIBRARY_FILE)), LIBRARY_FILE);
    }
    catch (error) {
        problems.push(error instanceof FormatError ? error.message : `library.json unreadable: ${error.message}`);
    }
    const playlists = [];
    for (const entry of index?.playlists ?? []) {
        // entry.dir is validated as `playlists/<id>` (forward slashes); split so fs.join can use the platform separator.
        playlists.push(await checkPlaylistDir(fs, fs.join(root, ...entry.dir.split('/')), entry, options));
    }
    const groups = await readOptional(fs, root, GROUPS_FILE, validateGroups, problems);
    for (const icon of groups?.groups.map((g) => g.icon) ?? []) {
        if (icon && !(await fs.stat(fs.join(root, ...icon.split('/')))).exists)
            problems.push(`missing group icon ${icon} (non-fatal)`);
    }
    const recent = await readOptional(fs, root, RECENT_FILE, validateRecent, problems);
    return { index, syncLockPresent: (await fs.stat(fs.join(root, SYNC_LOCK_FILE))).exists, playlists, groups, recent, problems };
}
/** An optional root file: absent is null with no problem; unreadable or invalid is null and a non-fatal problem. */
async function readOptional(fs, root, name, validator, problems) {
    const file = fs.join(root, name);
    if (!(await fs.stat(file)).exists)
        return null;
    try {
        return parseWith(validator, await fs.readText(file), name);
    }
    catch (error) {
        problems.push(`${error instanceof FormatError ? error.message : `${name} unreadable: ${error.message}`} (non-fatal)`);
        return null;
    }
}
//# sourceMappingURL=complete.js.map