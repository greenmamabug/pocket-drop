// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Ashworth Digital Ltd
// This file is part of Studio Pocket. It is licensed under GPL-3.0-only, or under a
// commercial licence from Ashworth Digital Ltd (see COPYING.commercial).

import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { validatePlaylistManifest } from '@studio-pocket/library-format';
import { buildFolderLibrary, FolderError, playlistSlug } from '../src/folder.js';
import { nodeFolderDeps } from '../src/folder-node.js';

const AUDIO = path.resolve(import.meta.dirname, '../../library-format/fixtures/audio');
const IMAGES = path.resolve(import.meta.dirname, '../../library-format/fixtures/images');

async function folder(): Promise<string> {
    return mkdtemp(path.join(os.tmpdir(), 'myo-folder-'));
}

async function copyAudio(root: string, rel: string, fixture: string): Promise<void> {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await copyFile(path.join(AUDIO, fixture), path.join(root, rel));
}

async function writeText(root: string, rel: string, text: string): Promise<void> {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), text);
}

describe('buildFolderLibrary', () => {
    it('makes one playlist per folder, tracks in name order, with valid manifests', async () => {
        const root = await folder();
        await copyAudio(root, 'Bedtime/02-b.mp3', 'tone-c5.mp3');
        await copyAudio(root, 'Bedtime/01-a.m4a', 'tone-e4.m4a');
        const lib = await buildFolderLibrary(root, nodeFolderDeps);
        const [playlist] = lib.playlists;
        expect(lib.playlists.map((p) => p.manifest.id)).toEqual(['bedtime']);
        expect(playlist!.manifest.tracks.map((t) => t.title)).toEqual(['01-a', '02-b']);
        expect(() => validatePlaylistManifest(playlist!.manifest)).not.toThrow();
    });

    it('refuses formats the player cannot play and names every bad file', async () => {
        const root = await folder();
        await writeText(root, 'Bedtime/a.opus', 'not really opus');
        await writeText(root, 'Bedtime/b.wav', 'RIFF');
        await writeText(root, 'Bedtime/c.mp3', 'not audio');
        await writeText(root, 'loose.mp3', 'top level');
        const error = await buildFolderLibrary(root, nodeFolderDeps).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(FolderError);
        const message = (error as Error).message;
        expect(message).toMatch(/a\.opus: unsupported file type/);
        expect(message).toMatch(/b\.wav: unsupported file type/);
        expect(message).toMatch(/c\.mp3: cannot read/);
        expect(message).toMatch(/loose\.mp3: audio belongs inside a playlist folder/);
        expect(message).toMatch(/4 problem\(s\)/);
    });

    it('ignores cover art and system files, with one note naming them', async () => {
        const root = await folder();
        await copyAudio(root, 'Bedtime/01-a.mp3', 'tone-c5.mp3');
        await writeText(root, 'Bedtime/cover.jpg', 'x');
        await writeText(root, 'Bedtime/Thumbs.db', 'x');
        await writeText(root, 'readme.txt', 'x');
        const lib = await buildFolderLibrary(root, nodeFolderDeps);
        expect(lib.playlists[0]!.manifest.tracks).toHaveLength(1);
        expect(lib.notes).toHaveLength(1);
        expect(lib.notes![0]).toMatch(/cover\.jpg/);
        expect(lib.notes![0]).toMatch(/Thumbs\.db/);
    });

    it('still refuses unsupported audio such as .ogg', async () => {
        const root = await folder();
        await copyAudio(root, 'Bedtime/01-a.mp3', 'tone-c5.mp3');
        await writeText(root, 'Bedtime/b.ogg', 'OggS');
        await expect(buildFolderLibrary(root, nodeFolderDeps)).rejects.toThrow(/b\.ogg: unsupported file type/);
    });

    it('refuses a nested folder that holds audio', async () => {
        const root = await folder();
        await copyAudio(root, 'Artist/Album/01-a.mp3', 'tone-c5.mp3');
        await copyAudio(root, 'Artist/02-b.mp3', 'tone-e4.m4a');
        const error = await buildFolderLibrary(root, nodeFolderDeps).catch((e: Error) => e);
        expect(error).toBeInstanceOf(FolderError);
        expect((error as Error).message).toMatch(/Album: nested folders are not supported; put the audio files directly in the playlist folder/);
    });

    it('refuses an .mp3 whose codec the player cannot play, even when it probes', async () => {
        const root = await folder();
        await copyAudio(root, 'Bedtime/really-opus.mp3', 'tone-c5.mp3');
        const deps = { ...nodeFolderDeps, probe: async () => ({ codec: 'Opus', durationSeconds: 3 }) };
        await expect(buildFolderLibrary(root, deps)).rejects.toThrow(/really-opus\.mp3: cannot read/);
    });

    it('keeps titles as written and makes ids and file names safe', async () => {
        const root = await folder();
        // A folder name cannot contain "/", so the awkward characters are the others.
        await copyAudio(root, 'Café: "Songs" 2026?/Ünïcode track ✓.mp3', 'tone-c5.mp3');
        const [playlist] = (await buildFolderLibrary(root, nodeFolderDeps)).playlists;
        expect(playlist!.manifest.title).toBe('Café: "Songs" 2026?');
        expect(playlist!.manifest.id).toBe('caf-songs-2026');
        expect(playlist!.manifest.tracks[0]!.title).toBe('Ünïcode track ✓');
        expect(playlist!.manifest.tracks[0]!.file).toMatch(/^tracks\/[0-9a-f]{16}\.mp3$/);
    });

    it('suffixes duplicate playlist ids and duplicate tracks instead of failing', async () => {
        const root = await folder();
        await copyAudio(root, 'Songs!/a.mp3', 'tone-c5.mp3');
        await copyAudio(root, 'songs/a.mp3', 'tone-e5.mp3');
        await copyAudio(root, 'songs/copy-of-a.mp3', 'tone-e5.mp3');
        const lib = await buildFolderLibrary(root, nodeFolderDeps);
        // 'songs' sorts before 'Songs!', so it keeps the plain id.
        expect(lib.playlists.map((p) => p.manifest.id)).toEqual(['songs', 'songs-2']);
        const ids = lib.playlists[0]!.manifest.tracks.map((t) => t.id);
        expect(new Set(ids).size).toBe(2);
        expect(ids[1]).toMatch(/-2$/);
    });

    it('gives a name with no ASCII letters a stable hashed id', () => {
        expect(playlistSlug('童话')).toMatch(/^p-[0-9a-f]{12}$/);
        expect(playlistSlug('童话')).toBe(playlistSlug('童话'));
    });

    it('refuses an MP3 cut inside its first frame', async () => {
        const root = await folder();
        const bytes = await readFile(path.join(AUDIO, 'tone-c5.mp3'));
        await mkdir(path.join(root, 'Bedtime'));
        await writeFile(path.join(root, 'Bedtime/cut.mp3'), bytes.subarray(0, 100));
        await expect(buildFolderLibrary(root, nodeFolderDeps)).rejects.toThrow(/cut\.mp3: cannot read/);
    });

    it('accepts an MP3 cut cleanly at 50%: it still probes with a duration, and plays up to the cut', async () => {
        // music-metadata reports a positive duration (the length from the file's own header,
        // not the frames present), so the builder does not refuse it. No size-versus-duration heuristic.
        const root = await folder();
        const bytes = await readFile(path.join(AUDIO, 'tone-c5.mp3'));
        await mkdir(path.join(root, 'Bedtime'));
        await writeFile(path.join(root, 'Bedtime/half.mp3'), bytes.subarray(0, Math.floor(bytes.length / 2)));
        const [playlist] = (await buildFolderLibrary(root, nodeFolderDeps)).playlists;
        expect(playlist!.manifest.tracks[0]!.durationMs).toBeGreaterThan(0);
    });

    it('collects failures from sha256 and list alongside the other problems', async () => {
        const root = await folder();
        await copyAudio(root, 'Good/a.mp3', 'tone-c5.mp3');
        await copyAudio(root, 'Good/b.mp3', 'tone-e5.mp3');
        await copyAudio(root, 'Locked/x.mp3', 'tone-a4.mp3');
        await writeText(root, 'Good/c.wav', 'RIFF');
        const deps = {
            ...nodeFolderDeps,
            list: async (dir: string) => {
                if (dir.endsWith('Locked')) throw new Error('EACCES: permission denied');
                return nodeFolderDeps.list(dir);
            },
            sha256: async (file: string) => {
                if (file.endsWith('b.mp3')) throw new Error('EIO: read failed');
                return nodeFolderDeps.sha256(file);
            },
        };
        const error = await buildFolderLibrary(root, deps).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(FolderError);
        const message = (error as Error).message;
        expect(message).toMatch(/b\.mp3: EIO: read failed/);
        expect(message).toMatch(/Locked: EACCES: permission denied/);
        expect(message).toMatch(/c\.wav: unsupported file type/);
        expect(message).toMatch(/3 problem\(s\)/);
    });
});

async function copyImage(root: string, rel: string, fixture: string): Promise<void> {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await copyFile(path.join(IMAGES, fixture), path.join(root, rel));
}

/** A MYO Studio v2 download: tracks listed out of order on purpose, so index order is what counts. */
async function v2Archive(root: string, rel: string, title = 'Christmas Songs'): Promise<string> {
    const dir = path.join(root, rel);
    await copyAudio(dir, 'audio/01 - Deck.mp3', 'tone-c5.mp3');
    await copyAudio(dir, 'audio/02 - Jingle.mp3', 'tone-e5.mp3');
    await copyImage(dir, 'icons/01.png', 'pixel-moon.png');
    await copyImage(dir, 'icons/02.png', 'pixel-star.png');
    await writeText(dir, 'metadata.json', JSON.stringify({
        format: 'myo-studio-archive', version: 2, title, cover: null, playbackType: 'linear',
        tracks: [
            { index: 2, key: '01', title: '2.Jingle Pups', audio: 'audio/02 - Jingle.mp3', icon: 'icons/02.png', duration: 1, format: 'aac' },
            { index: 1, key: '00', title: '1.Deck the Pups', audio: 'audio/01 - Deck.mp3', icon: 'icons/01.png', duration: 1, format: 'aac' },
        ],
    }));
    return dir;
}

/** A MYO Studio v1 download: no format marker, tracks carry only index, title and key. */
async function v1Archive(root: string, rel: string, opts: { audio?: string[] } = {}): Promise<string> {
    const dir = path.join(root, rel);
    const audio = opts.audio ?? ['01 - Opening.m4a', '02 - Cake.mp3', '03 - Birds.mp3'];
    const fixtures = ['tone-e4.m4a', 'tone-c5.mp3', 'tone-e5.mp3', 'tone-a4.mp3'];
    for (const [i, name] of audio.entries()) await copyAudio(dir, `audio/${name}`, fixtures[i % fixtures.length]!);
    for (const [i, name] of ['01.png', '02.png', '03.png'].entries()) await copyImage(dir, `icons/${name}`, ['pixel-moon.png', 'pixel-note.png', 'pixel-star.png'][i]!);
    // A real download's cover.jpg can hold PNG data: this one does.
    await copyImage(dir, 'cover.jpg', 'pixel-note.png');
    await writeText(dir, 'metadata.json', JSON.stringify({
        title: 'Ada Twist Stories', exportedAt: '2026-01-15T11:32:55.066Z',
        tracks: [{ index: 3, title: 'Birds', key: '02' }, { index: 1, title: 'Opening Credits', key: '00' }, { index: 2, title: 'Cake Twist', key: '01' }],
    }));
    return dir;
}

describe('buildFolderLibrary with MYO Studio downloads', () => {
    it('reads a v2 download: its title, its track titles in index order, and its icons', async () => {
        const root = await folder();
        const dir = await v2Archive(root, 'Christmas-Songs-full');
        const lib = await buildFolderLibrary(root, nodeFolderDeps);
        expect(lib.notes ?? []).toEqual([]);
        const [playlist] = lib.playlists;
        const m = playlist!.manifest;
        expect(m.id).toBe('christmas-songs');
        expect(m.title).toBe('Christmas Songs');
        expect(m.source).toEqual({ kind: 'local' });
        expect(m.cover).toBeNull();
        expect(playlist!.coverPath).toBeUndefined();
        expect(m.tracks.map((t) => t.title)).toEqual(['1.Deck the Pups', '2.Jingle Pups']);
        expect(playlist!.tracks.map((t) => t.localPath)).toEqual([path.join(dir, 'audio/01 - Deck.mp3'), path.join(dir, 'audio/02 - Jingle.mp3')]);
        expect(m.tracks.map((t) => t.icon)).toEqual(m.tracks.map((t) => `icons/${t.id}.png`));
        expect(playlist!.tracks.map((t) => t.iconPath)).toEqual([path.join(dir, 'icons/01.png'), path.join(dir, 'icons/02.png')]);
        expect(() => validatePlaylistManifest(m)).not.toThrow();
    });

    it('keeps every path from metadata.json inside the download: an escaping audio path is refused, an escaping icon or cover dropped', async () => {
        const root = await folder();
        const dir = await v2Archive(root, 'Escape-full');
        await copyAudio(root, 'Other/outside.mp3', 'tone-c5.mp3');
        await writeText(dir, 'metadata.json', JSON.stringify({
            format: 'myo-studio-archive', version: 2, title: 'Escape', cover: '/etc/hosts',
            tracks: [{ index: 1, key: '00', title: 'Out', audio: '../Other/outside.mp3', icon: '../../x.png' }],
        }));
        const error = await buildFolderLibrary(root, nodeFolderDeps).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(FolderError);
        expect((error as Error).message).toMatch(/track 1 has no audio file inside the download/);

        await writeText(dir, 'metadata.json', JSON.stringify({
            format: 'myo-studio-archive', version: 2, title: 'Escape', cover: '/etc/hosts',
            tracks: [{ index: 1, key: '00', title: 'In', audio: 'audio/01 - Deck.mp3', icon: '../../x.png' }],
        }));
        const playlist = (await buildFolderLibrary(root, nodeFolderDeps)).playlists.find((p) => p.manifest.title === 'Escape');
        expect(playlist!.coverPath).toBeUndefined();
        expect(playlist!.tracks[0]!.iconPath).toBeUndefined();
    });

    it('reads a v1 download: audio and icons by file-name position, and its cover under the name its bytes call for', async () => {
        const root = await folder();
        const dir = await v1Archive(root, 'Ada-full');
        const [playlist] = (await buildFolderLibrary(root, nodeFolderDeps)).playlists;
        const m = playlist!.manifest;
        expect(m.title).toBe('Ada Twist Stories');
        expect(m.id).toBe('ada-twist-stories');
        expect(m.tracks.map((t) => t.title)).toEqual(['Opening Credits', 'Cake Twist', 'Birds']);
        expect(playlist!.tracks.map((t) => path.basename(t.localPath))).toEqual(['01 - Opening.m4a', '02 - Cake.mp3', '03 - Birds.mp3']);
        expect(m.tracks[0]!.mimeType).toBe('audio/mp4');
        expect(playlist!.tracks.map((t) => path.basename(t.iconPath!))).toEqual(['01.png', '02.png', '03.png']);
        expect(m.cover).toBe('cover.png');
        expect(playlist!.coverPath).toBe(path.join(dir, 'cover.jpg'));
    });

    it('reads an .aac file that holds MP4 data (as MYO Studio AAC downloads do) as M4A', async () => {
        const root = await folder();
        await v1Archive(root, 'Ada-full', { audio: ['01 - Opening.aac', '02 - Cake.mp3', '03 - Birds.mp3'] });
        await copyAudio(root, 'Bedtime/01-a.aac', 'tone-e4.m4a');
        const lib = await buildFolderLibrary(root, nodeFolderDeps);
        for (const p of lib.playlists) {
            const t = p.manifest.tracks[0]!;
            expect(t.mimeType).toBe('audio/mp4');
            expect(t.file).toMatch(/^tracks\/[0-9a-f]{16}\.m4a$/);
            expect(t.durationMs).toBeGreaterThan(1500);
        }
    });

    it('takes a JPEG cover as cover.jpg', async () => {
        const root = await folder();
        const dir = await v2Archive(root, 'X-full');
        const meta = JSON.parse(await readFile(path.join(dir, 'metadata.json'), 'utf8'));
        await copyImage(dir, 'cover.jpg', 'cover-blue.jpg');
        await writeText(dir, 'metadata.json', JSON.stringify({ ...meta, cover: 'cover.jpg' }));
        const [playlist] = (await buildFolderLibrary(root, nodeFolderDeps)).playlists;
        expect(playlist!.manifest.cover).toBe('cover.jpg');
        expect(playlist!.coverPath).toBe(path.join(dir, 'cover.jpg'));
    });

    it('imports the folder passed in as one playlist when it is itself a download', async () => {
        const root = await folder();
        const dir = await v1Archive(root, 'Ada-full');
        const lib = await buildFolderLibrary(dir, nodeFolderDeps);
        expect(lib.playlists.map((p) => p.manifest.title)).toEqual(['Ada Twist Stories']);
        expect(lib.playlists[0]!.manifest.tracks).toHaveLength(3);
        expect(lib.notes ?? []).toEqual([]);
    });

    it('takes downloads and plain playlist folders side by side', async () => {
        const root = await folder();
        await v2Archive(root, 'Christmas-Songs-full');
        await copyAudio(root, 'Bedtime/01-a.mp3', 'tone-g5.mp3');
        const lib = await buildFolderLibrary(root, nodeFolderDeps);
        expect(lib.playlists.map((p) => [p.manifest.id, p.manifest.title, p.manifest.tracks.length])).toEqual([['bedtime', 'Bedtime', 1], ['christmas-songs', 'Christmas Songs', 2]]);
        expect(lib.playlists[0]!.tracks[0]!.iconPath).toBeUndefined();
    });

    it('refuses an Opus download and says to take the AAC version', async () => {
        const root = await folder();
        await v1Archive(root, 'Famous-Five-full', { audio: ['01 - Chapter 1.opus', '02 - Chapter 2.mp3', '03 - Chapter 3.mp3'] });
        const error = await buildFolderLibrary(root, nodeFolderDeps).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(FolderError);
        expect((error as Error).message).toMatch(/01 - Chapter 1\.opus: the player cannot play Opus; download the AAC version of this playlist from MYO Studio/);
        expect((error as Error).message).toMatch(/1 problem\(s\)/);
    });

    it('skips an icon that is not a 16x16 PNG, with a note, and still syncs the track', async () => {
        const root = await folder();
        const dir = await v2Archive(root, 'Christmas-Songs-full');
        const png = await readFile(path.join(IMAGES, 'pixel-moon.png'));
        png.writeUInt32BE(32, 16); // IHDR width
        await writeFile(path.join(dir, 'icons/01.png'), png);
        const lib = await buildFolderLibrary(root, nodeFolderDeps);
        const [playlist] = lib.playlists;
        expect(playlist!.manifest.tracks.map((t) => t.icon === undefined)).toEqual([true, false]);
        expect(playlist!.tracks[0]!.iconPath).toBeUndefined();
        expect(lib.notes).toHaveLength(1);
        expect(lib.notes![0]).toMatch(/01\.png/);
        expect(lib.notes![0]).toMatch(/16x16/);
    });

    it('refuses a v1 download whose audio count does not match its track list, naming the download', async () => {
        const root = await folder();
        await v1Archive(root, 'Ada-full', { audio: ['01 - Opening.m4a', '02 - Cake.mp3'] });
        await expect(buildFolderLibrary(root, nodeFolderDeps)).rejects.toThrow(/Ada-full: metadata\.json lists 3 tracks but audio\/ holds 2 files/);
    });

    it('treats a metadata.json that is not a MYO Studio download, and any other .json, as a stray file', async () => {
        const root = await folder();
        await copyAudio(root, 'Bedtime/01-a.mp3', 'tone-c5.mp3');
        await writeText(root, 'Bedtime/metadata.json', '{"artist": "someone"}');
        await writeText(root, 'library.json', '{}');
        const lib = await buildFolderLibrary(root, nodeFolderDeps);
        expect(lib.playlists[0]!.manifest.title).toBe('Bedtime');
        expect(lib.notes![0]).toMatch(/ignored 2 non-audio file\(s\)/);
    });

    it('says zip files are not opened', async () => {
        const root = await folder();
        await copyAudio(root, 'Bedtime/01-a.mp3', 'tone-c5.mp3');
        await writeText(root, 'Christmas-Songs.zip', 'PK');
        const lib = await buildFolderLibrary(root, nodeFolderDeps);
        expect(lib.notes!.join('\n')).toMatch(/zip files are not opened; unzip them first: .*Christmas-Songs\.zip/);
        await expect(buildFolderLibrary(path.join(root, 'Christmas-Songs.zip'), nodeFolderDeps)).rejects.toThrow(/unzip it first/);
    });
});
