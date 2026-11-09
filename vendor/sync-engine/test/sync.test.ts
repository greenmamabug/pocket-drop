// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Ashworth Digital Ltd
// This file is part of Studio Pocket. It is licensed under GPL-3.0-only, or under a
// commercial licence from Ashworth Digital Ltd (see COPYING.commercial).

import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { checkLibrary } from '@studio-pocket/library-format/node';
import { InsufficientStorageError, SyncAborted, applySync as applySyncWith } from '../src/apply.js';
import { applySync, ensureDeviceMarker, inspectDevice, nodeSyncFs, planTransfer } from '../src/node.js';
import { PLAYLIST_UPDATE_LOCK_FILE, checkPlaylistDir } from '@studio-pocket/library-format';
import { describePlan } from '../src/plan.js';
import { fixtureRoot, sourceFromFixtures } from './helpers.js';
import type { SourceLibrary } from '../src/source.js';

const planFor = (r: string, source: SourceLibrary, remove: string[] = [], options: { verifyHashes?: boolean } = {}) => planTransfer(r, { send: source.playlists, remove }, options);

let volume: string;
let root: string;
const exists = (p: string) => stat(p).then(() => true, () => false);
const listParts = async (dir: string) => (await readdir(dir, { recursive: true })).filter((f) => f.endsWith('.part'));

/**
 * Replaces a source track's audio with `bytes`, written to a temp file outside the player's
 * root (the committed fixture is never modified), and updates the source manifest to match.
 */
async function replaceTrack(source: SourceLibrary, trackId: string, bytes: Buffer): Promise<void> {
    const track = source.playlists[0]!.tracks.find((t) => t.entry.id === trackId)!;
    const file = path.join(volume, `source-${trackId}.mp3`);
    await writeFile(file, bytes);
    track.localPath = file;
    track.entry.sizeBytes = bytes.length;
    track.entry.sha256 = createHash('sha256').update(bytes).digest('hex');
}
/** Same size, different bytes: one byte flipped near the end of the fixture audio. */
async function sameSizeChanged(trackId: string): Promise<Buffer> {
    const bytes = await readFile(path.join(fixtureRoot, 'playlists/bedtime/tracks', `${trackId}.mp3`));
    bytes[bytes.length - 2] = bytes[bytes.length - 2]! ^ 0xff;
    return bytes;
}

beforeEach(async () => {
    volume = await mkdtemp(path.join(os.tmpdir(), 'myo-sync-'));
    await ensureDeviceMarker(volume, 'test');
    root = path.join(volume, 'STUDIOPOCKET');
});
afterEach(() => rm(volume, { recursive: true, force: true }));

describe('device marker', () => {
    it('is created once and then recognised', async () => {
        const first = await inspectDevice(volume);
        expect(first.marker?.deviceId).toMatch(/[0-9a-f-]{36}/);
        expect(first.hasLibrary).toBe(false);
        const again = await ensureDeviceMarker(volume, 'test');
        expect(again.deviceId).toBe(first.marker!.deviceId);
    });
});

describe('fresh sync', () => {
    it('copies everything, writes manifests before the index, and leaves no partial files', async () => {
        const source = await sourceFromFixtures(['bedtime', 'songs']);
        const plan = await planFor(root, source);
        expect(plan.playlists.map((p) => p.kind)).toEqual(['add', 'add']);
        expect(describePlan(plan)).toMatch(/^2 to add, 0 to update, 0 unchanged, 0 to remove/);
        const result = await applySync(plan, { generator: 'test' });
        expect(result.index.playlists.map((p) => p.id)).toEqual(['bedtime', 'songs']);
        expect(result.skipped).toEqual([]);
        const check = await checkLibrary(root, { verifyHashes: true });
        expect(check.playlists.every((p) => p.ok)).toBe(true);
        expect(check.syncLockPresent).toBe(false);
        expect(await exists(path.join(root, 'playlists/bedtime/cover.jpg'))).toBe(true);
        expect(await exists(path.join(root, 'playlists/bedtime/icons/ch1.png'))).toBe(true);
        expect(await exists(path.join(root, 'playlists/songs/icons/song-1.png'))).toBe(true);
        const all = await readdir(root, { recursive: true });
        expect(all.filter((f) => f.endsWith('.part'))).toEqual([]);
    });

    it('is a no-op the second time', async () => {
        const source = await sourceFromFixtures(['bedtime']);
        await applySync(await planFor(root, source), { generator: 'test' });
        const plan = await planFor(root, source, [], { verifyHashes: true });
        expect(plan.playlists.map((p) => p.kind)).toEqual(['keep']);
        expect(plan.bytesToCopy).toBe(0);
    });
});

describe('interruption', () => {
    it('leaves the old index valid and finishes on the next run', async () => {
        await applySync(await planFor(root, await sourceFromFixtures(['bedtime'])), { generator: 'test' });
        const before = await readFile(path.join(root, 'library.json'), 'utf8');

        const source = await sourceFromFixtures(['bedtime', 'songs']);
        let copies = 0;
        const { copyFile } = await import('node:fs/promises');
        await expect(applySync(await planFor(root, source), {
            generator: 'test',
            copy: async (from, to) => {
                if (++copies === 2) {
                    await writeFile(to, Buffer.alloc(100)); // half-written .part
                    throw new Error('USB unplugged');
                }
                await copyFile(from, to);
            },
        })).rejects.toThrow('USB unplugged');

        // Old index untouched, lock present, player would still see bedtime only.
        expect(await readFile(path.join(root, 'library.json'), 'utf8')).toBe(before);
        const mid = await checkLibrary(root);
        expect(mid.syncLockPresent).toBe(true);
        expect(mid.index!.playlists.map((p) => p.id)).toEqual(['bedtime']);

        // New files go live as they finish (song-1); only the half-written song-2 is a stray.
        const plan = await planFor(root, source);
        expect(plan.stray.map((f) => path.relative(root, f))).toEqual(['playlists/songs/tracks/song-2.m4a.part']);
        expect(plan.playlists.find((p) => p.id === 'songs')!.kind).toBe('add');
        expect(plan.playlists.find((p) => p.id === 'bedtime')!.kind).toBe('keep');
        const result = await applySync(plan, { generator: 'test' });
        expect(result.index.playlists.map((p) => p.id)).toEqual(['bedtime', 'songs']);
        const after = await checkLibrary(root, { verifyHashes: true });
        expect(after.playlists.every((p) => p.ok)).toBe(true);
        expect(after.syncLockPresent).toBe(false);
    });

    it('an interruption during the copies leaves the previous version complete', async () => {
        const original = await sourceFromFixtures(['bedtime']);
        await applySync(await planFor(root, original), { generator: 'test' });
        const manifestBefore = await readFile(path.join(root, 'playlists/bedtime/manifest.json'), 'utf8');
        const ch1Before = await readFile(path.join(root, 'playlists/bedtime/tracks/ch1.mp3'));
        const ch2Before = await readFile(path.join(root, 'playlists/bedtime/tracks/ch2.mp3'));

        const source = await sourceFromFixtures(['bedtime']);
        await replaceTrack(source, 'ch1', await sameSizeChanged('ch1'));
        await replaceTrack(source, 'ch2', await sameSizeChanged('ch2'));
        const plan = await planFor(root, source);
        expect(plan.playlists[0]!.files.filter((f) => f.kind === 'copy')).toHaveLength(2);
        let copies = 0;
        await expect(applySync(plan, {
            generator: 'test',
            copy: async (from, to) => {
                if (++copies === 2) throw new Error('USB unplugged');
                await copyFile(from, to);
            },
        })).rejects.toThrow('USB unplugged');

        expect(await readFile(path.join(root, 'playlists/bedtime/manifest.json'), 'utf8')).toBe(manifestBefore);
        expect(await readFile(path.join(root, 'playlists/bedtime/tracks/ch1.mp3'))).toEqual(ch1Before);
        expect(await readFile(path.join(root, 'playlists/bedtime/tracks/ch2.mp3'))).toEqual(ch2Before);
        const mid = await checkLibrary(root, { verifyHashes: true });
        expect(mid.playlists.find((p) => p.id === 'bedtime')!.ok).toBe(true);
        expect(await listParts(root)).toEqual(['playlists/bedtime/tracks/ch1.mp3.part']);
        expect((await planFor(root, source)).stray).toHaveLength(1);
    });

    it('an interruption between the renames and the manifest is repaired by the next sync', async () => {
        await applySync(await planFor(root, await sourceFromFixtures(['bedtime'])), { generator: 'test' });
        const source = await sourceFromFixtures(['bedtime']);
        // A different size, so the old manifest no longer matches the renamed file.
        await replaceTrack(source, 'ch1', await readFile(path.join(fixtureRoot, 'playlists/bedtime/tracks/ch2.mp3')));
        const manifestPart = path.join(root, 'playlists/bedtime/manifest.json.part');
        const failingFs = { ...nodeSyncFs, rename: async (from: string, to: string) => {
            if (from === manifestPart) throw new Error('USB unplugged');
            await nodeSyncFs.rename(from, to);
        } };
        await expect(applySyncWith(failingFs, await planFor(root, source), { generator: 'test' })).rejects.toThrow('USB unplugged');

        const mid = await checkPlaylistDir(nodeSyncFs, path.join(root, 'playlists/bedtime'), { id: 'bedtime' });
        expect(mid.ok).toBe(false);
        expect(mid.problems).toEqual(['update interrupted (update.lock present)', 'tracks/ch1.mp3 is 24676 B, expected 18564']);

        const plan = await planFor(root, source);
        expect(plan.playlists[0]!.kind).toBe('update');
        await applySync(plan, { generator: 'test' });
        const after = await checkLibrary(root, { verifyHashes: true });
        expect(after.playlists.find((p) => p.id === 'bedtime')!.ok).toBe(true);
        expect(after.index!.playlists.map((p) => p.id)).toEqual(['bedtime']);
    });

    it('an interruption between two same-size renames leaves the playlist marked and the next sync repairs it', async () => {
        await applySync(await planFor(root, await sourceFromFixtures(['bedtime'])), { generator: 'test' });
        const source = await sourceFromFixtures(['bedtime']);
        await replaceTrack(source, 'ch1', await sameSizeChanged('ch1'));
        await replaceTrack(source, 'ch2', await sameSizeChanged('ch2'));
        let renames = 0;
        const failingFs = { ...nodeSyncFs, rename: async (from: string, to: string) => {
            if (!from.endsWith('.part')) { await nodeSyncFs.rename(from, to); return; }
            if (to.includes(`${path.sep}tracks${path.sep}`) && ++renames === 2) throw new Error('USB unplugged');
            await nodeSyncFs.rename(from, to);
        } };
        await expect(applySyncWith(failingFs, await planFor(root, source), { generator: 'test' })).rejects.toThrow('USB unplugged');

        const mid = await checkLibrary(root);
        const bedtime = mid.playlists.find((p) => p.id === 'bedtime')!;
        expect(bedtime.ok).toBe(false);
        expect(bedtime.problems).toContain('update interrupted (update.lock present)');
        expect(await exists(path.join(root, 'playlists/bedtime', PLAYLIST_UPDATE_LOCK_FILE))).toBe(true);
        // The track whose rename failed is still staged; the next plan removes it as a stray.
        const leftover = await listParts(root);
        expect(leftover).toHaveLength(1);
        expect(leftover[0]).toMatch(/^playlists[\\/]bedtime[\\/]tracks[\\/]ch[12]\.mp3\.part$/);

        const plan = await planFor(root, source);
        expect(plan.playlists[0]!.kind).toBe('update');
        expect(plan.stray.map((f) => path.relative(root, f))).toEqual(leftover);
        await applySync(plan, { generator: 'test' });
        expect(await exists(path.join(root, 'playlists/bedtime', PLAYLIST_UPDATE_LOCK_FILE))).toBe(false);
        const after = await checkLibrary(root, { verifyHashes: true });
        expect(after.playlists.find((p) => p.id === 'bedtime')!.ok).toBe(true);
        expect(await listParts(root)).toEqual([]);
    });

    it('a marker left after the manifest write is cleared by the next sync without copying', async () => {
        const source = await sourceFromFixtures(['bedtime']);
        await applySync(await planFor(root, source), { generator: 'test' });
        const lock = path.join(root, 'playlists/bedtime', PLAYLIST_UPDATE_LOCK_FILE);
        await writeFile(lock, 'left over\n');
        // The marker alone makes the playlist an update, one that copies nothing.
        const plan = await planFor(root, source);
        expect(plan.playlists[0]!.kind).toBe('update');
        expect(plan.bytesToCopy).toBe(0);
        await applySync(plan, { generator: 'test' });
        expect(await exists(lock)).toBe(false);
    });

    it('a first sync or a missing-only update writes no marker', async () => {
        const lockWrites: string[] = [];
        const spyFs = { ...nodeSyncFs, writeFile: async (p: string, data: string | Uint8Array) => {
            if (p.includes(PLAYLIST_UPDATE_LOCK_FILE)) lockWrites.push(p);
            await nodeSyncFs.writeFile(p, data);
        } };
        const source = await sourceFromFixtures(['bedtime']);
        await applySyncWith(spyFs, await planFor(root, source), { generator: 'test' });
        expect(lockWrites).toEqual([]);
        // Missing-only update: delete one live track so the plan copies it with reason 'missing'.
        await rm(path.join(root, 'playlists/bedtime/tracks/ch1.mp3'));
        const plan = await planFor(root, source);
        expect(plan.playlists[0]!.kind).toBe('update');
        expect(plan.playlists[0]!.files.filter((f) => f.kind === 'copy').every((f) => f.kind === 'copy' && f.reason === 'missing')).toBe(true);
        await applySyncWith(spyFs, plan, { generator: 'test' });
        expect(lockWrites).toEqual([]);
    });

    it('can be aborted from the progress callback and resumed', async () => {
        const source = await sourceFromFixtures(['bedtime', 'songs']);
        await expect(applySync(await planFor(root, source), { generator: 'test', onProgress: (e) => e.bytesDone < e.bytesTotal / 2 })).rejects.toThrow(SyncAborted);
        const plan = await planFor(root, source);
        expect(plan.bytesToCopy).toBeGreaterThan(0);
        expect(plan.bytesToCopy).toBeLessThan((await planFor(path.join(volume, 'empty'), source)).bytesToCopy);
        await applySync(plan, { generator: 'test' });
        expect(await listParts(root)).toEqual([]);
        expect((await checkLibrary(root)).playlists.every((p) => p.ok)).toBe(true);
    });
});

describe('updates and removals', () => {
    it('updates a changed manifest without recopying audio', async () => {
        const source = await sourceFromFixtures(['bedtime']);
        await applySync(await planFor(root, source), { generator: 'test' });
        source.playlists[0]!.manifest.tracks[0]!.title = 'Chapter one (renamed)';
        const plan = await planFor(root, source);
        expect(plan.playlists[0]!.kind).toBe('update');
        expect(plan.bytesToCopy).toBe(0);
        const before = plan.deviceState.index!.playlists[0]!.manifestSha256;
        const result = await applySync(plan, { generator: 'test' });
        const manifest = JSON.parse(await readFile(path.join(root, 'playlists/bedtime/manifest.json'), 'utf8'));
        expect(manifest.tracks[0].title).toBe('Chapter one (renamed)');
        expect(result.index.playlists[0]!.manifestSha256).not.toBe(before);
    });

    it('recopies a track whose size changed on the device', async () => {
        const source = await sourceFromFixtures(['bedtime']);
        await applySync(await planFor(root, source), { generator: 'test' });
        await writeFile(path.join(root, 'playlists/bedtime/tracks/ch2.mp3'), Buffer.alloc(10));
        const plan = await planFor(root, source);
        const copies = plan.playlists[0]!.files.filter((f) => f.kind === 'copy');
        expect(copies).toHaveLength(1);
        expect(copies[0]).toMatchObject({ reason: 'size' });
        await applySync(plan, { generator: 'test' });
        expect((await checkLibrary(root, { verifyHashes: true })).playlists[0]!.ok).toBe(true);
    });

    it('copies a track whose bytes changed but whose size did not', async () => {
        await applySync(await planFor(root, await sourceFromFixtures(['bedtime'])), { generator: 'test' });
        const source = await sourceFromFixtures(['bedtime']);
        await replaceTrack(source, 'ch1', await sameSizeChanged('ch1'));
        const plan = await planFor(root, source);
        const copies = plan.playlists[0]!.files.filter((f) => f.kind === 'copy');
        expect(copies).toHaveLength(1);
        expect(copies[0]).toMatchObject({ reason: 'changed', to: path.join(root, 'playlists/bedtime/tracks/ch1.mp3') });
        await applySync(plan, { generator: 'test' });
        const check = await checkLibrary(root, { verifyHashes: true });
        expect(check.playlists[0]!.ok).toBe(true);
        expect(check.playlists[0]!.manifest!.tracks[0]!.sha256).toBe(source.playlists[0]!.tracks[0]!.entry.sha256);
    });

    it('removes files a playlist no longer references after the index is written', async () => {
        await applySync(await planFor(root, await sourceFromFixtures(['bedtime'])), { generator: 'test' });
        await writeFile(path.join(root, 'state/bedtime.json'), '{"resume":true}');
        const source = await sourceFromFixtures(['bedtime']);
        source.playlists[0]!.manifest.tracks = source.playlists[0]!.manifest.tracks.filter((t) => t.id !== 'ch3');
        source.playlists[0]!.tracks = source.playlists[0]!.tracks.filter((t) => t.entry.id !== 'ch3');
        const ch3 = path.join(root, 'playlists/bedtime/tracks/ch3.mp3');
        const result = await applySync(await planFor(root, source), { generator: 'test' });
        expect(await exists(ch3)).toBe(false);
        expect(result.cleaned).toEqual([ch3]);
        expect(result.warnings).toEqual([]);
        expect(await readFile(path.join(root, 'state/bedtime.json'), 'utf8')).toBe('{"resume":true}');
        expect(await exists(path.join(root, 'playlists/bedtime/tracks/ch1.mp3'))).toBe(true);
        expect(await exists(path.join(root, 'playlists/bedtime/icons/ch1.png'))).toBe(true);
        expect(await exists(path.join(root, 'playlists/bedtime/cover.jpg'))).toBe(true);
        expect((await checkLibrary(root, { verifyHashes: true })).playlists[0]!.ok).toBe(true);
    });

    it('keeps a referenced file whose name on disk differs only in case', async () => {
        await applySync(await planFor(root, await sourceFromFixtures(['bedtime'])), { generator: 'test' });
        const source = await sourceFromFixtures(['bedtime']);
        source.playlists[0]!.manifest.tracks[0]!.title = 'Chapter one (renamed)';
        // As a case-insensitive volume reports a file written earlier as CH1.MP3.
        const caseFs = { ...nodeSyncFs, readdir: async (dir: string) => (await nodeSyncFs.readdir(dir)).map((e) => (e.name === 'ch1.mp3' ? { ...e, name: 'CH1.MP3' } : e)) };
        const result = await applySyncWith(caseFs, await planFor(root, source), { generator: 'test' });
        expect(result.cleaned).toEqual([]);
        expect(await exists(path.join(root, 'playlists/bedtime/tracks/ch1.mp3'))).toBe(true);
    });

    it('reports a cleanup failure as a warning and still succeeds', async () => {
        await applySync(await planFor(root, await sourceFromFixtures(['bedtime'])), { generator: 'test' });
        const source = await sourceFromFixtures(['bedtime']);
        source.playlists[0]!.manifest.tracks = source.playlists[0]!.manifest.tracks.filter((t) => t.id !== 'ch3');
        source.playlists[0]!.tracks = source.playlists[0]!.tracks.filter((t) => t.entry.id !== 'ch3');
        const ch3 = path.join(root, 'playlists/bedtime/tracks/ch3.mp3');
        const lockedFs = { ...nodeSyncFs, remove: async (p: string, recursive: boolean) => {
            if (p === ch3) throw new Error('file in use');
            await nodeSyncFs.remove(p, recursive);
        } };
        const result = await applySyncWith(lockedFs, await planFor(root, source), { generator: 'test' });
        expect(result.cleaned).toEqual([]);
        expect(result.warnings).toEqual([`could not remove ${ch3}: file in use`]);
        expect(result.index.playlists.map((p) => p.id)).toEqual(['bedtime']);
        expect((await checkLibrary(root, { verifyHashes: true })).playlists[0]!.ok).toBe(true);
    });

    it('removes only what it is told to, with its state', async () => {
        await applySync(await planFor(root, await sourceFromFixtures(['bedtime', 'songs'])), { generator: 'test' });
        await writeFile(path.join(root, 'state/songs.json'), '{}');
        await writeFile(path.join(root, 'state/bedtime.json'), '{}');
        const plan = await planFor(root, { generator: 'test', playlists: [] }, ['songs']);
        expect(plan.playlists.map((p) => `${p.id}:${p.kind}`).sort()).toEqual(['bedtime:keep', 'songs:remove']);
        const result = await applySync(plan, { generator: 'test' });
        expect(result.removed).toEqual(['songs']);
        expect(await exists(path.join(root, 'playlists/songs'))).toBe(false);
        expect(await exists(path.join(root, 'state/songs.json'))).toBe(false);
        expect(await exists(path.join(root, 'state/bedtime.json'))).toBe(true);
        expect(result.index.playlists.map((p) => p.id)).toEqual(['bedtime']);
    });

    it('leaves a playlist it was not told about exactly as it is, and keeps it in the index', async () => {
        await applySync(await planFor(root, await sourceFromFixtures(['bedtime', 'songs'])), { generator: 'test' });
        const dir = path.join(root, 'playlists/songs');
        const snapshot = async () => Promise.all((await readdir(dir, { recursive: true })).sort().map(async (f) => [f, (await stat(path.join(dir, f))).isFile() ? (await readFile(path.join(dir, f))).toString('base64') : 'dir']));
        const before = await snapshot();
        const source = await sourceFromFixtures(['bedtime']);
        source.playlists[0]!.manifest.tracks[0]!.title = 'Chapter one (renamed)';
        const plan = await planFor(root, source);
        expect(plan.playlists.find((p) => p.id === 'songs')).toMatchObject({ kind: 'keep', untouched: true, files: [] });
        expect(describePlan(plan)).toMatch(/^0 to add, 1 to update, 0 unchanged, 0 to remove/);
        const result = await applySync(plan, { generator: 'test' });
        expect(result.written).toEqual(['bedtime']);
        expect(result.index.playlists.map((p) => p.id)).toEqual(['bedtime', 'songs']);
        expect(await snapshot()).toEqual(before);
    });

    it('leaves an unlisted directory on the player alone', async () => {
        await applySync(await planFor(root, await sourceFromFixtures(['bedtime'])), { generator: 'test' });
        const { mkdir } = await import('node:fs/promises');
        await mkdir(path.join(root, 'playlists/someone-else'), { recursive: true });
        await writeFile(path.join(root, 'playlists/someone-else/notes.txt'), 'keep me');
        const result = await applySync(await planFor(root, await sourceFromFixtures(['bedtime'])), { generator: 'test' });
        expect(result.removed).toEqual([]);
        expect(await readFile(path.join(root, 'playlists/someone-else/notes.txt'), 'utf8')).toBe('keep me');
    });

    it('refuses to send and remove the same playlist', async () => {
        await expect(planFor(root, await sourceFromFixtures(['bedtime']), ['bedtime'])).rejects.toThrow(/both send and remove/);
    });
});

describe('groups and recent', () => {
    // groups.json and groups/ belong to the desktop's Organise tab; recent.json to the player.
    const seed = async () => {
        const { copyFile, mkdir } = await import('node:fs/promises');
        await mkdir(path.join(root, 'groups'), { recursive: true });
        await copyFile(path.join(fixtureRoot, 'groups.json'), path.join(root, 'groups.json'));
        await copyFile(path.join(fixtureRoot, 'groups/g-bedtime.png'), path.join(root, 'groups/g-bedtime.png'));
        await copyFile(path.join(fixtureRoot, 'recent.json'), path.join(root, 'recent.json'));
    };
    const snapshot = async () => ({
        groups: await readFile(path.join(root, 'groups.json'), 'utf8'),
        recent: await readFile(path.join(root, 'recent.json'), 'utf8'),
        icons: Object.fromEntries(await Promise.all((await readdir(path.join(root, 'groups'))).sort().map(async (f) => [f, (await readFile(path.join(root, 'groups', f))).toString('base64')]))),
    });

    it('a send leaves groups.json, groups/ and recent.json untouched', async () => {
        await seed();
        const before = await snapshot();
        const plan = await planFor(root, await sourceFromFixtures(['bedtime', 'songs']));
        expect(plan.stray).toEqual([]);
        await applySync(plan, { generator: 'test' });
        expect(await snapshot()).toEqual(before);
    });

    it('a removal leaves them untouched too, even when the removed playlist is in a group', async () => {
        await applySync(await planFor(root, await sourceFromFixtures(['bedtime', 'songs'])), { generator: 'test' });
        await seed();
        const before = await snapshot();
        const result = await applySync(await planFor(root, { generator: 'test', playlists: [] }, ['bedtime']), { generator: 'test' });
        expect(result.removed).toEqual(['bedtime']);
        expect(await snapshot()).toEqual(before);
        expect((await checkLibrary(root)).groups?.groups[0]!.playlists).toContain('bedtime');
    });
});

describe('storage', () => {
    it('refuses to start when the volume is too full', async () => {
        const plan = await planFor(root, await sourceFromFixtures(['bedtime']));
        await expect(applySync(plan, { generator: 'test', freeBytes: async () => 1000, reserveBytes: 0 })).rejects.toThrow(InsufficientStorageError);
        expect(await exists(path.join(root, 'sync.lock'))).toBe(false);
        expect(await exists(path.join(root, 'playlists/bedtime'))).toBe(false);
    });

    it('counts the space held by stray partial files as free', async () => {
        const source = await sourceFromFixtures(['bedtime']);
        const { mkdir } = await import('node:fs/promises');
        await mkdir(path.join(root, 'playlists/bedtime/tracks'), { recursive: true });
        const stray = path.join(root, 'playlists/bedtime/tracks/ch1.mp3.part');
        await writeFile(stray, Buffer.alloc(1024 * 1024));
        const plan = await planFor(root, source);
        expect(plan.stray).toEqual([stray]);
        // Too little room while the stray is there; enough once it is gone.
        const freeBytes = async () => ((await exists(stray)) ? plan.bytesToCopy - 1 : plan.bytesToCopy + 1024 * 1024);
        const result = await applySync(plan, { generator: 'test', freeBytes, reserveBytes: 0 });
        expect(result.written).toEqual(['bedtime']);
        expect(await exists(stray)).toBe(false);
    });
});
