// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Ashworth Digital Ltd
// This file is part of Studio Pocket. It is licensed under GPL-3.0-only, or under a
// commercial licence from Ashworth Digital Ltd (see COPYING.commercial).

import { copyFile, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkLibrary } from '@studio-pocket/library-format/node';
import { refuseUnsafeVolume, syncFolder, syncReportLines } from '../src/folder-sync.js';

const AUDIO = path.resolve(import.meta.dirname, '../../library-format/fixtures/audio');
const IMAGES = path.resolve(import.meta.dirname, '../../library-format/fixtures/images');

async function songs(): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), 'myo-songs-'));
    await mkdir(path.join(root, 'Bedtime'));
    await copyFile(path.join(AUDIO, 'tone-c5.mp3'), path.join(root, 'Bedtime', 'one.mp3'));
    await copyFile(path.join(AUDIO, 'tone-e5.mp3'), path.join(root, 'Bedtime', 'two.mp3'));
    return root;
}

async function exists(p: string): Promise<boolean> {
    return stat(p).then(() => true, () => false);
}

describe('refuseUnsafeVolume', () => {
    it('refuses a drive root and the home folder', () => {
        expect(() => refuseUnsafeVolume('/')).toThrow(/refusing to use/);
        expect(() => refuseUnsafeVolume(os.homedir())).toThrow(/refusing to use/);
    });

    const win = { platform: 'win32' as const, homedir: 'C:\\Users\\alex', systemDrive: 'C:', systemRoot: 'C:\\Windows' };

    it('accepts any other Windows drive root, however it is written', () => {
        for (const v of ['E:\\', 'E:', 'e:\\']) expect(() => refuseUnsafeVolume(v, win)).not.toThrow();
    });

    it('refuses the Windows system drive, home folder and system root', () => {
        for (const v of ['C:\\', 'c:', 'C:\\Users\\alex', 'c:\\users\\Alex\\', 'C:\\Windows']) {
            expect(() => refuseUnsafeVolume(v, win), v).toThrow(/refusing to use/);
        }
    });

    it('keeps the POSIX rules', () => {
        const posix = { platform: 'darwin' as const, homedir: '/Users/alex' };
        expect(() => refuseUnsafeVolume('/', posix)).toThrow(/refusing to use/);
        expect(() => refuseUnsafeVolume('/Users/alex', posix)).toThrow(/refusing to use/);
        expect(() => refuseUnsafeVolume('/Volumes/NO NAME', posix)).not.toThrow();
    });
});

describe('syncReportLines', () => {
    it('prints notes, a warning line per cleanup failure, and the cleaned count when non-zero', () => {
        expect(syncReportLines({ notes: ['n'], warnings: ['could not remove a: EBUSY', 'could not remove b: EPERM'], cleaned: ['/v/x', '/v/y', '/v/z'] })).toEqual([
            'note: n', 'warning: could not remove a: EBUSY', 'warning: could not remove b: EPERM', 'cleaned 3 file(s)',
        ]);
        expect(syncReportLines({ notes: [], warnings: [], cleaned: [] })).toEqual([]);
    });
});

describe('syncFolder', () => {
    it('refuses a volume that is not a player, and writes nothing', async () => {
        const folder = await songs();
        const volume = await mkdtemp(path.join(os.tmpdir(), 'myo-volume-'));
        await expect(syncFolder({ folder, volume, create: false, generator: 'test' })).rejects.toThrow(/run again with --create/);
        expect(await exists(path.join(volume, 'STUDIOPOCKET'))).toBe(false);
    });

    it('with --create writes a library, and a sync cut short by a pulled cable converges on rerun', async () => {
        const folder = await songs();
        const volume = await mkdtemp(path.join(os.tmpdir(), 'myo-volume-'));
        let copies = 0;
        await expect(syncFolder({
            folder, volume, create: true, generator: 'test',
            copy: async (from, to) => { if (++copies === 2) throw new Error('cable pulled'); await copyFile(from, to); },
        })).rejects.toThrow('cable pulled');

        await syncFolder({ folder, volume, create: false, generator: 'test' });

        const check = await checkLibrary(path.join(volume, 'STUDIOPOCKET'));
        expect(check.problems).toEqual([]);
        expect(check.index?.playlists.map((p) => p.id)).toEqual(['bedtime']);
    });

    it('writes a MYO Studio download with its titles, track icons and cover', async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), 'myo-archive-'));
        const folder = path.join(root, 'Ada-full');
        await mkdir(path.join(folder, 'audio'), { recursive: true });
        await mkdir(path.join(folder, 'icons'));
        await copyFile(path.join(AUDIO, 'tone-e4.m4a'), path.join(folder, 'audio', '01 - Opening.m4a'));
        await copyFile(path.join(AUDIO, 'tone-c5.mp3'), path.join(folder, 'audio', '02 - Cake.mp3'));
        await copyFile(path.join(IMAGES, 'pixel-moon.png'), path.join(folder, 'icons', '01.png'));
        await copyFile(path.join(IMAGES, 'pixel-star.png'), path.join(folder, 'icons', '02.png'));
        await copyFile(path.join(IMAGES, 'cover-blue.jpg'), path.join(folder, 'cover.jpg'));
        await writeFile(path.join(folder, 'metadata.json'), JSON.stringify({ title: 'Ada Twist Stories', tracks: [{ index: 1, title: 'Opening Credits', key: '00' }, { index: 2, title: 'Cake Twist', key: '01' }] }));
        const volume = await mkdtemp(path.join(os.tmpdir(), 'myo-volume-'));

        await syncFolder({ folder, volume, create: true, generator: 'test' });

        const lib = path.join(volume, 'STUDIOPOCKET');
        const check = await checkLibrary(lib);
        expect(check.problems).toEqual([]);
        const dir = path.join(lib, 'playlists', 'ada-twist-stories');
        const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
        expect(manifest.title).toBe('Ada Twist Stories');
        expect(manifest.tracks.map((t: { title: string }) => t.title)).toEqual(['Opening Credits', 'Cake Twist']);
        expect(manifest.cover).toBe('cover.jpg');
        expect(await readFile(path.join(dir, 'cover.jpg'))).toEqual(await readFile(path.join(IMAGES, 'cover-blue.jpg')));
        for (const [i, t] of (manifest.tracks as { id: string; icon: string }[]).entries()) {
            expect(t.icon).toBe(`icons/${t.id}.png`);
            expect(await readFile(path.join(dir, t.icon))).toEqual(await readFile(path.join(IMAGES, ['pixel-moon.png', 'pixel-star.png'][i]!)));
        }
    });
});
