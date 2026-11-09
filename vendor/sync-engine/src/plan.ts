// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Ashworth Digital Ltd
// This file is part of Studio Pocket. It is licensed under GPL-3.0-only, or under a
// commercial licence from Ashworth Digital Ltd (see COPYING.commercial).

import {
    ICONS_DIR, LIBRARY_FILE, PARTIAL_SUFFIX, PLAYLISTS_DIR, PLAYLIST_MANIFEST_FILE, STATE_DIR, TRACKS_DIR,
    checkLibrary, validatePlaylistManifest, type LibraryCheck, type PlaylistManifest,
} from '@studio-pocket/library-format';
import type { SourcePlaylist } from './source.js';
import { utf8, type SyncFs } from './fs.js';

/**
 * A transfer plan is a pure description of what will change. The desktop shows it before
 * anything is written ("3 playlists to add, 1 to update, 2 to remove, 128 MB to copy").
 */
export type FileAction = { kind: 'copy'; from: string; to: string; bytes: number; reason: 'missing' | 'size' | 'hash' | 'changed' } | { kind: 'keep'; to: string; bytes: number };

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
export function serializeManifest(manifest: PlaylistManifest): Uint8Array {
    return utf8(JSON.stringify(validatePlaylistManifest(manifest), null, 2) + '\n');
}

async function planPlaylist(fs: SyncFs, root: string, source: SourcePlaylist, existing: LibraryCheck['playlists'][number] | undefined, verifyHashes: boolean): Promise<PlaylistAction> {
    const dir = fs.join(root, PLAYLISTS_DIR, source.manifest.id);
    const manifestBytes = serializeManifest(source.manifest);
    const files: FileAction[] = [];
    // A track whose sha256 in the manifest already on the player differs from the source's has
    // changed content, even at the same size (no file hashing needed). Images carry no hash in the manifest, so a same-size changed
    // cover or icon is not detected; images are recopied only when missing or a different size.
    const previousSha = new Map((existing?.manifest?.tracks ?? []).map((t) => [t.file, t.sha256]));
    const candidates: { from: string; to: string; bytes: number; sha256?: string; changed?: boolean }[] = source.tracks.map((t) => {
        const previous = previousSha.get(t.entry.file);
        return { from: t.localPath, to: fs.join(dir, ...t.entry.file.split('/')), bytes: t.entry.sizeBytes, sha256: t.entry.sha256, changed: previous !== undefined && previous !== t.entry.sha256 };
    });
    for (const t of source.tracks) {
        if (t.entry.icon && t.iconPath) candidates.push({ from: t.iconPath, to: fs.join(dir, ...t.entry.icon.split('/')), bytes: (await fs.stat(t.iconPath)).size });
    }
    if (source.manifest.cover && source.coverPath) candidates.push({ from: source.coverPath, to: fs.join(dir, source.manifest.cover), bytes: (await fs.stat(source.coverPath)).size });
    if (source.manifest.icon && source.iconPath) candidates.push({ from: source.iconPath, to: fs.join(dir, source.manifest.icon), bytes: (await fs.stat(source.iconPath)).size });

    for (const c of candidates) {
        const state = await fs.stat(c.to);
        if (!state.exists) files.push({ kind: 'copy', from: c.from, to: c.to, bytes: c.bytes, reason: 'missing' });
        else if (state.size !== c.bytes) files.push({ kind: 'copy', from: c.from, to: c.to, bytes: c.bytes, reason: 'size' });
        else if (c.changed) files.push({ kind: 'copy', from: c.from, to: c.to, bytes: c.bytes, reason: 'changed' });
        else if (verifyHashes && c.sha256 && (await fs.sha256File(c.to)) !== c.sha256) files.push({ kind: 'copy', from: c.from, to: c.to, bytes: c.bytes, reason: 'hash' });
        else files.push({ kind: 'keep', to: c.to, bytes: c.bytes });
    }
    const manifestSame = existing?.ok && existing.manifest !== null && (await fs.sha256Bytes(serializeManifest(existing.manifest))) === (await fs.sha256Bytes(manifestBytes));
    const copies = files.filter((f) => f.kind === 'copy');
    const kind: PlaylistAction['kind'] = !existing || existing.manifest === null ? 'add' : manifestSame && copies.length === 0 ? 'keep' : 'update';
    return { id: source.manifest.id, title: source.manifest.title, kind, files, manifest: source.manifest, manifestBytes, bytesToCopy: copies.reduce((n, f) => n + f.bytes, 0) };
}

async function findStray(fs: SyncFs, root: string, wantedIds: Set<string>): Promise<string[]> {
    const stray: string[] = [];
    const playlistsDir = fs.join(root, PLAYLISTS_DIR);
    for (const { name } of await fs.readdir(playlistsDir)) {
        const dir = fs.join(playlistsDir, name);
        if (name.endsWith(PARTIAL_SUFFIX)) { stray.push(dir); continue; }
        if (!wantedIds.has(name)) continue; // removals are planned separately
        for (const sub of ['', TRACKS_DIR, ICONS_DIR]) {
            const subDir = sub ? fs.join(dir, sub) : dir;
            for (const f of await fs.readdir(subDir)) {
                if (f.name.endsWith(PARTIAL_SUFFIX)) stray.push(fs.join(subDir, f.name));
            }
        }
    }
    for (const f of await fs.readdir(root)) {
        if (f.name.endsWith(PARTIAL_SUFFIX)) stray.push(fs.join(root, f.name));
    }
    return stray;
}

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
export async function planTransfer(fs: SyncFs, root: string, request: TransferRequest, options: { verifyHashes?: boolean } = {}): Promise<SyncPlan> {
    const sendIds = new Set(request.send.map((p) => p.manifest.id));
    const both = request.remove.filter((id) => sendIds.has(id));
    if (both.length) throw new Error(`cannot both send and remove: ${both.join(', ')}`);
    const deviceState = await checkLibrary(fs, root);
    const existingById = new Map(deviceState.playlists.map((p) => [p.id, p]));
    const playlists: PlaylistAction[] = [];
    for (const sp of request.send) {
        playlists.push(await planPlaylist(fs, root, sp, existingById.get(sp.manifest.id), options.verifyHashes ?? false));
    }
    const onDevice = new Set<string>(existingById.keys());
    for (const { name } of await fs.readdir(fs.join(root, PLAYLISTS_DIR))) {
        if (!name.endsWith(PARTIAL_SUFFIX)) onDevice.add(name);
    }
    const removing = new Set(request.remove);
    for (const id of [...onDevice].sort()) {
        if (sendIds.has(id)) continue;
        const title = existingById.get(id)?.manifest?.title ?? id;
        if (removing.has(id)) playlists.push({ id, title, kind: 'remove', files: [], manifest: null, manifestBytes: null, bytesToCopy: 0 });
        else playlists.push({ id, title, kind: 'keep', files: [], manifest: existingById.get(id)?.manifest ?? null, manifestBytes: null, bytesToCopy: 0, untouched: true });
    }
    return { root, playlists, bytesToCopy: playlists.reduce((n, p) => n + p.bytesToCopy, 0), stray: await findStray(fs, root, sendIds), deviceState };
}

export function describePlan(plan: SyncPlan): string {
    const count = (kind: PlaylistAction['kind']) => plan.playlists.filter((p) => p.kind === kind && !p.untouched).length;
    return `${count('add')} to add, ${count('update')} to update, ${count('keep')} unchanged, ${count('remove')} to remove; ${plan.bytesToCopy} bytes to copy; ${plan.stray.length} stray files`;
}

export { LIBRARY_FILE, PLAYLIST_MANIFEST_FILE, STATE_DIR };
