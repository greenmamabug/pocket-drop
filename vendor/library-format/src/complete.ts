// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Ashworth Digital Ltd
// This file is part of Studio Pocket. It is licensed under GPL-3.0-only, or under a
// commercial licence from Ashworth Digital Ltd (see COPYING.commercial).

import { FormatError, parseWith, validateGroups, validateLibraryIndex, validatePlaylistManifest, validateRecent } from './validate.js';
import {
    GROUPS_FILE, LIBRARY_FILE, PLAYLIST_MANIFEST_FILE, PLAYLIST_UPDATE_LOCK_FILE, RECENT_FILE, SYNC_LOCK_FILE,
    type GroupsFile, type LibraryIndex, type LibraryIndexEntry, type PlaylistManifest, type RecentFile,
} from './types.js';
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

export async function checkPlaylistDir(fs: LibraryFs, dir: string, entry: Pick<LibraryIndexEntry, 'id'> & Partial<LibraryIndexEntry>, options: { verifyHashes?: boolean } = {}): Promise<PlaylistCheck> {
    const problems: string[] = [];
    let manifest: PlaylistManifest | null = null;
    const manifestPath = fs.join(dir, PLAYLIST_MANIFEST_FILE);
    try {
        manifest = parseWith(validatePlaylistManifest, await fs.readText(manifestPath), `${entry.id}/manifest.json`);
    } catch (error) {
        problems.push(error instanceof FormatError ? error.message : `manifest unreadable: ${(error as Error).message}`);
        return { id: entry.id, ok: false, manifest: null, problems };
    }
    if ((await fs.stat(fs.join(dir, PLAYLIST_UPDATE_LOCK_FILE))).exists) problems.push('update interrupted (update.lock present)');
    if (manifest.id !== entry.id) problems.push(`manifest id ${manifest.id} != ${entry.id}`);
    if (entry.manifestSha256) {
        const actual = await fs.sha256File(manifestPath);
        if (actual !== entry.manifestSha256) problems.push('manifest hash does not match library index');
    }
    if (entry.trackCount !== undefined && entry.trackCount !== manifest.tracks.length) problems.push(`trackCount ${entry.trackCount} != ${manifest.tracks.length}`);
    for (const track of manifest.tracks) {
        const file = fs.join(dir, track.file);
        const info = await fs.stat(file);
        if (!info.exists) { problems.push(`missing ${track.file}`); continue; }
        if (info.size !== track.sizeBytes) { problems.push(`${track.file} is ${info.size} B, expected ${track.sizeBytes}`); continue; }
        if (options.verifyHashes && (await fs.sha256File(file)) !== track.sha256) problems.push(`${track.file} hash mismatch`);
    }
    for (const art of [manifest.cover, manifest.icon, ...manifest.tracks.map((t) => t.icon ?? null)]) {
        if (art && !(await fs.stat(fs.join(dir, ...art.split('/')))).exists) problems.push(`missing artwork ${art} (non-fatal)`);
    }
    const fatal = problems.filter((p) => !p.endsWith('(non-fatal)'));
    return { id: entry.id, ok: fatal.length === 0, manifest, problems };
}

export async function checkLibrary(fs: LibraryFs, root: string, options: { verifyHashes?: boolean } = {}): Promise<LibraryCheck> {
    const problems: string[] = [];
    let index: LibraryIndex | null = null;
    try {
        index = parseWith(validateLibraryIndex, await fs.readText(fs.join(root, LIBRARY_FILE)), LIBRARY_FILE);
    } catch (error) {
        problems.push(error instanceof FormatError ? error.message : `library.json unreadable: ${(error as Error).message}`);
    }
    const playlists: PlaylistCheck[] = [];
    for (const entry of index?.playlists ?? []) {
        // entry.dir is validated as `playlists/<id>` (forward slashes); split so fs.join can use the platform separator.
        playlists.push(await checkPlaylistDir(fs, fs.join(root, ...entry.dir.split('/')), entry, options));
    }
    const groups = await readOptional(fs, root, GROUPS_FILE, validateGroups, problems);
    for (const icon of groups?.groups.map((g) => g.icon) ?? []) {
        if (icon && !(await fs.stat(fs.join(root, ...icon.split('/')))).exists) problems.push(`missing group icon ${icon} (non-fatal)`);
    }
    const recent = await readOptional(fs, root, RECENT_FILE, validateRecent, problems);
    return { index, syncLockPresent: (await fs.stat(fs.join(root, SYNC_LOCK_FILE))).exists, playlists, groups, recent, problems };
}

/** An optional root file: absent is null with no problem; unreadable or invalid is null and a non-fatal problem. */
async function readOptional<T>(fs: LibraryFs, root: string, name: string, validator: (value: unknown, path?: string) => T, problems: string[]): Promise<T | null> {
    const file = fs.join(root, name);
    if (!(await fs.stat(file)).exists) return null;
    try {
        return parseWith(validator, await fs.readText(file), name);
    } catch (error) {
        problems.push(`${error instanceof FormatError ? error.message : `${name} unreadable: ${(error as Error).message}`} (non-fatal)`);
        return null;
    }
}
